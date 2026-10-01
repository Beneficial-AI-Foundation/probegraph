/**
 * PipelineRunner - Run probegraph pipeline to generate/update the index
 * 
 * This module handles:
 * - Running the pipeline command in the background, without a shell
 * - Writing to a temporary file and renaming it over the index on success
 * - Showing progress in the status bar
 * - Debouncing save events
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { resolveIndexPath } from './indexLoader';

/**
 * Pipeline configuration options
 */
export interface PipelineOptions {
    /** Skip Verus verification (faster, but no verification status) */
    skipVerification?: boolean;
    
    /** Skip similar lemmas enrichment */
    skipSimilarLemmas?: boolean;
    
    /** Use cached SCIP data if available */
    useCachedScip?: boolean;
    
    /** Package name for workspaces */
    package?: string;
    
    /** GitHub URL for source links */
    githubUrl?: string;
}

/**
 * Status of the pipeline runner
 */
export type PipelineStatus = 'idle' | 'running' | 'success' | 'error';

/**
 * Singleton state for the pipeline runner
 */
let currentStatus: PipelineStatus = 'idle';
let statusBarItem: vscode.StatusBarItem | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let currentProcess: cp.ChildProcess | null = null;

/**
 * Initialize the pipeline runner
 */
export function initializePipelineRunner(context: vscode.ExtensionContext): void {
    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'callGraph.showPipelineOutput';
    context.subscriptions.push(statusBarItem);
    
    // Setup file watcher for auto-regeneration
    const config = vscode.workspace.getConfiguration('callGraph');
    if (config.get<boolean>('autoRegenerateOnSave', false)) {
        setupFileWatcher(context);
    }
    
    updateStatusBar();
}

/**
 * Setup file watcher for automatic regeneration on save
 */
function setupFileWatcher(context: vscode.ExtensionContext): void {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.rs');
    
    watcher.onDidChange((uri) => triggerDebounced(uri));
    watcher.onDidCreate((uri) => triggerDebounced(uri));
    watcher.onDidDelete((uri) => triggerDebounced(uri));
    
    context.subscriptions.push(watcher);
    
    // Also watch for document saves (more reliable)
    vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.languageId === 'rust') {
            triggerDebounced(document.uri);
        }
    }, null, context.subscriptions);
}

/**
 * Trigger pipeline regeneration with debouncing, for the folder of the file
 * that changed
 */
function triggerDebounced(uri: vscode.Uri): void {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
        return;
    }
    const config = vscode.workspace.getConfiguration('callGraph', folder);
    const debounceMs = config.get<number>('debounceDelayMs', 3000);
    
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        
        // Only run if not already running
        if (currentStatus !== 'running') {
            runPipeline(folder);
        }
    }, debounceMs);
}

/**
 * The pipeline binary built in a probegraph checkout: under CARGO_TARGET_DIR
 * if set, else under <repo>/target, else where `cargo metadata` says the
 * target directory is (a `.cargo/config.toml` can move it). Undefined when
 * none is built.
 */
async function findPipelineBinary(probegraphPath: string): Promise<string | undefined> {
    const binaryIn = (targetDir: string) => {
        const binary = path.join(targetDir, 'release', 'pipeline');
        return fs.existsSync(binary) ? binary : undefined;
    };
    if (process.env.CARGO_TARGET_DIR) {
        return binaryIn(path.resolve(probegraphPath, process.env.CARGO_TARGET_DIR));
    }
    const conventional = binaryIn(path.join(probegraphPath, 'target'));
    if (conventional) {
        return conventional;
    }
    try {
        const metadata = JSON.parse(await executeCommand(
            'cargo', ['metadata', '--format-version', '1', '--no-deps'], probegraphPath
        ));
        if (typeof metadata.target_directory === 'string') {
            return binaryIn(metadata.target_directory);
        }
    } catch {
        // No cargo, or not a cargo workspace
    }
    return undefined;
}

/**
 * Run the probegraph pipeline for a workspace folder, replacing its index
 * only if the run succeeds
 */
export async function runPipeline(folder: vscode.WorkspaceFolder, options?: PipelineOptions): Promise<void> {
    if (!vscode.workspace.isTrusted) {
        vscode.window.showErrorMessage(
            'Regenerating the index runs the probegraph pipeline, which needs a trusted workspace.'
        );
        return;
    }
    const workspaceRoot = folder.uri.fsPath;
    let indexPath: string;
    try {
        indexPath = resolveIndexPath(folder);
    } catch (error: any) {
        vscode.window.showErrorMessage(error.message);
        return;
    }
    // The pipeline writes here; the file is renamed over the index at the end,
    // so a watcher never sees a half-written index
    const tempPath = path.join(path.dirname(indexPath), `.${path.basename(indexPath)}.${process.pid}.tmp`);
    
    // Ensure output directory exists
    const indexDir = path.dirname(indexPath);
    if (!fs.existsSync(indexDir)) {
        fs.mkdirSync(indexDir, { recursive: true });
    }
    
    // Get configuration
    const config = vscode.workspace.getConfiguration('callGraph', folder);
    const scipCallgraphPath = config.get<string>('defaultScipCallgraphPath', '');
    const skipVerification = options?.skipVerification ?? config.get<boolean>('skipVerification', false);
    const skipSimilarLemmas = options?.skipSimilarLemmas ?? config.get<boolean>('skipSimilarLemmas', true);
    
    // Build command
    let command: string;
    let args: string[];
    let cwd: string = workspaceRoot;
    
    if (scipCallgraphPath && fs.existsSync(scipCallgraphPath)) {
        const releaseBinary = await findPipelineBinary(scipCallgraphPath);
        
        if (releaseBinary) {
            // Use the pre-built binary
            command = releaseBinary;
            args = [workspaceRoot, '-o', tempPath];
            cwd = scipCallgraphPath; // Run from probegraph dir for script paths
        } else {
            // Use cargo run from probegraph directory
            command = 'cargo';
            args = [
                'run', '--release', '-p', 'metrics-cli', '--bin', 'pipeline',
                '--',
                workspaceRoot, '-o', tempPath
            ];
            cwd = scipCallgraphPath;
        }
    } else {
        // Try to find pipeline in PATH
        command = 'pipeline';
        args = [workspaceRoot, '-o', tempPath];
        
        // Show a helpful message if not configured
        vscode.window.showWarningMessage(
            'probegraph path not configured. Please set "callGraph.defaultScipCallgraphPath" in settings.',
            'Open Settings'
        ).then(selection => {
            if (selection === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'callGraph.defaultScipCallgraphPath');
            }
        });
    }
    
    // Add options
    if (skipVerification) {
        args.push('--skip-verification');
    }
    if (skipSimilarLemmas) {
        args.push('--skip-similar-lemmas');
    }
    if (options?.useCachedScip) {
        args.push('--use-cached-scip');
    }
    if (options?.package) {
        args.push('-p', options.package);
    }
    if (options?.githubUrl) {
        args.push('--github-url', options.githubUrl);
    }
    
    // Update status
    currentStatus = 'running';
    updateStatusBar();
    
    // Create output channel
    const outputChannel = vscode.window.createOutputChannel('Call Graph Pipeline');
    outputChannel.show(true);
    outputChannel.appendLine(`Running: ${command} ${args.join(' ')}`);
    outputChannel.appendLine(`Working directory: ${cwd}`);
    outputChannel.appendLine('---');
    console.log(`[Pipeline] ${command} ${JSON.stringify(args)} in ${cwd}`);
    
    return new Promise((resolve) => {
        const startTime = Date.now();
        
        currentProcess = cp.spawn(command, args, {
            cwd,
            env: { ...process.env, RUST_LOG: 'info' }
        });
        
        currentProcess.stdout?.on('data', (data) => {
            outputChannel.append(data.toString());
        });
        
        currentProcess.stderr?.on('data', (data) => {
            outputChannel.append(data.toString());
        });
        
        currentProcess.on('close', async (code) => {
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            currentProcess = null;
            console.log(`[Pipeline] exited with ${code} after ${duration}s`);
            
            if (code === 0 && fs.existsSync(tempPath)) {
                try {
                    await fs.promises.rename(tempPath, indexPath);
                    currentStatus = 'success';
                    outputChannel.appendLine('---');
                    outputChannel.appendLine(`✓ Pipeline completed successfully in ${duration}s`);
                    outputChannel.appendLine(`Output: ${indexPath}`);
                    vscode.window.showInformationMessage(`Call graph index updated (${duration}s)`);
                } catch (error: any) {
                    currentStatus = 'error';
                    outputChannel.appendLine(`✗ Could not replace ${indexPath}: ${error.message}`);
                    vscode.window.showErrorMessage(`Could not replace the call graph index. See output for details.`);
                }
            } else {
                currentStatus = 'error';
                fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
                outputChannel.appendLine('---');
                outputChannel.appendLine(code === 0
                    ? `✗ Pipeline exited without writing ${tempPath}`
                    : `✗ Pipeline failed with exit code ${code}`);
                vscode.window.showErrorMessage(`Call graph pipeline failed. See output for details.`);
            }
            
            updateStatusBar();
            resolve();
        });
        
        currentProcess.on('error', (error) => {
            currentStatus = 'error';
            currentProcess = null;
            console.error(`[Pipeline] failed to start: ${error.message}`);
            outputChannel.appendLine('---');
            outputChannel.appendLine(`✗ Failed to start pipeline: ${error.message}`);
            
            // Show helpful error message
            if (error.message.includes('ENOENT')) {
                outputChannel.appendLine('');
                outputChannel.appendLine('The pipeline command was not found.');
                outputChannel.appendLine('Please set the "callGraph.defaultScipCallgraphPath" setting to the path of your probegraph repository.');
                outputChannel.appendLine('');
                outputChannel.appendLine('Example:');
                outputChannel.appendLine('  "callGraph.defaultScipCallgraphPath": "/home/user/git_repos/probegraph"');
            }
            
            vscode.window.showErrorMessage('Failed to start call graph pipeline. See output for details.');
            updateStatusBar();
            resolve();
        });
    });
}

/**
 * Cancel the running pipeline
 */
export function cancelPipeline(): void {
    if (currentProcess) {
        currentProcess.kill();
        currentProcess = null;
        currentStatus = 'idle';
        updateStatusBar();
        vscode.window.showInformationMessage('Call graph pipeline cancelled');
    }
}

/**
 * Get the current pipeline status
 */
export function getPipelineStatus(): PipelineStatus {
    return currentStatus;
}

/** True when a generator is configured for the folder's language. */
export function hasGenerator(folder: vscode.WorkspaceFolder, languageId: string): boolean {
    if (languageId !== 'rust') {
        return false;
    }
    return !!vscode.workspace.getConfiguration('callGraph', folder).get<string>('defaultScipCallgraphPath');
}

/**
 * Update the status bar item
 */
function updateStatusBar(): void {
    if (!statusBarItem) {
        return;
    }
    
    switch (currentStatus) {
        case 'running':
            statusBarItem.text = '$(sync~spin) Call Graph: Updating...';
            statusBarItem.tooltip = 'Click to view pipeline output';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            statusBarItem.show();
            break;
            
        case 'success':
            statusBarItem.text = '$(check) Call Graph: Ready';
            statusBarItem.tooltip = 'Call graph index is up to date';
            statusBarItem.backgroundColor = undefined;
            statusBarItem.show();
            
            // Hide after a few seconds
            setTimeout(() => {
                if (currentStatus === 'success') {
                    statusBarItem?.hide();
                }
            }, 5000);
            break;
            
        case 'error':
            statusBarItem.text = '$(error) Call Graph: Error';
            statusBarItem.tooltip = 'Click to view error details';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            statusBarItem.show();
            break;
            
        default:
            statusBarItem.hide();
    }
}

/**
 * Check if the pipeline prerequisites are met
 */
export async function checkPrerequisites(): Promise<{ ok: boolean; missing: string[] }> {
    const missing: string[] = [];
    
    // Check for verus-analyzer
    try {
        await executeCommand('verus-analyzer', ['--version']);
    } catch {
        missing.push('verus-analyzer (not found in PATH)');
    }
    
    // Check for scip
    try {
        await executeCommand('scip', ['--version']);
    } catch {
        missing.push('scip (download from https://github.com/sourcegraph/scip/releases or build with: git clone https://github.com/sourcegraph/scip.git && cd scip && go build ./cmd/scip)');
    }
    
    // Check for cargo verus (optional, for verification)
    try {
        await executeCommand('cargo', ['verus', '--version']);
    } catch {
        // This is optional, so just warn
        console.log('cargo verus not found - verification will be skipped');
    }
    
    return {
        ok: missing.length === 0,
        missing
    };
}

/**
 * Execute a command and return its output
 */
function executeCommand(command: string, args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.execFile(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}
