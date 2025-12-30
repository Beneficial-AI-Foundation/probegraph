/**
 * PipelineRunner - Run scip-callgraph pipeline to generate/update the index
 * 
 * This module handles:
 * - Running the pipeline command in the background
 * - Showing progress in the status bar
 * - Debouncing save events
 * - Reloading the index after completion
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getIndexPath, loadIndex, clearCache } from './indexLoader';

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
    
    watcher.onDidChange(() => triggerDebounced());
    watcher.onDidCreate(() => triggerDebounced());
    watcher.onDidDelete(() => triggerDebounced());
    
    context.subscriptions.push(watcher);
    
    // Also watch for document saves (more reliable)
    vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.languageId === 'rust') {
            triggerDebounced();
        }
    }, null, context.subscriptions);
}

/**
 * Trigger pipeline regeneration with debouncing
 */
function triggerDebounced(): void {
    const config = vscode.workspace.getConfiguration('callGraph');
    const debounceMs = config.get<number>('debounceDelayMs', 3000);
    
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        
        // Only run if not already running
        if (currentStatus !== 'running') {
            runPipeline();
        }
    }, debounceMs);
}

/**
 * Run the scip-callgraph pipeline
 */
export async function runPipeline(options?: PipelineOptions): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }
    
    const workspaceRoot = workspaceFolder.uri.fsPath;
    const indexPath = getIndexPath(workspaceRoot);
    
    // Ensure output directory exists
    const indexDir = path.dirname(indexPath);
    if (!fs.existsSync(indexDir)) {
        fs.mkdirSync(indexDir, { recursive: true });
    }
    
    // Get configuration
    const config = vscode.workspace.getConfiguration('callGraph');
    const scipCallgraphPath = config.get<string>('defaultScipCallgraphPath', '');
    const skipVerification = options?.skipVerification ?? config.get<boolean>('skipVerification', false);
    const skipSimilarLemmas = options?.skipSimilarLemmas ?? config.get<boolean>('skipSimilarLemmas', true);
    
    // Build command
    let command: string;
    let args: string[];
    let cwd: string = workspaceRoot;
    
    if (scipCallgraphPath && fs.existsSync(scipCallgraphPath)) {
        // Check for pre-built release binary first
        const releaseBinary = path.join(scipCallgraphPath, 'target', 'release', 'pipeline');
        
        if (fs.existsSync(releaseBinary)) {
            // Use the pre-built binary
            command = releaseBinary;
            args = [workspaceRoot, '-o', indexPath];
            cwd = scipCallgraphPath; // Run from scip-callgraph dir for script paths
        } else {
            // Use cargo run from scip-callgraph directory
            command = 'cargo';
            args = [
                'run', '--release', '-p', 'metrics-cli', '--bin', 'pipeline',
                '--',
                workspaceRoot, '-o', indexPath
            ];
            cwd = scipCallgraphPath;
        }
    } else {
        // Try to find pipeline in PATH
        command = 'pipeline';
        args = [workspaceRoot, '-o', indexPath];
        
        // Show a helpful message if not configured
        vscode.window.showWarningMessage(
            'scip-callgraph path not configured. Please set "callGraph.defaultScipCallgraphPath" in settings.',
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
    outputChannel.appendLine(`Working directory: ${workspaceRoot}`);
    outputChannel.appendLine('---');
    
    return new Promise((resolve) => {
        const startTime = Date.now();
        
        currentProcess = cp.spawn(command, args, {
            cwd,
            shell: true,
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
            
            if (code === 0) {
                currentStatus = 'success';
                outputChannel.appendLine('---');
                outputChannel.appendLine(`✓ Pipeline completed successfully in ${duration}s`);
                outputChannel.appendLine(`Output: ${indexPath}`);
                
                // Reload the index
                try {
                    clearCache();
                    await loadIndex(workspaceRoot, true);
                    vscode.window.showInformationMessage(`Call graph index updated (${duration}s)`);
                } catch (error: any) {
                    console.error('Failed to reload index:', error);
                }
            } else {
                currentStatus = 'error';
                outputChannel.appendLine('---');
                outputChannel.appendLine(`✗ Pipeline failed with exit code ${code}`);
                vscode.window.showErrorMessage(`Call graph pipeline failed. See output for details.`);
            }
            
            updateStatusBar();
            resolve();
        });
        
        currentProcess.on('error', (error) => {
            currentStatus = 'error';
            currentProcess = null;
            outputChannel.appendLine('---');
            outputChannel.appendLine(`✗ Failed to start pipeline: ${error.message}`);
            
            // Show helpful error message
            if (error.message.includes('ENOENT')) {
                outputChannel.appendLine('');
                outputChannel.appendLine('The pipeline command was not found.');
                outputChannel.appendLine('Please set the "callGraph.defaultScipCallgraphPath" setting to the path of your scip-callgraph repository.');
                outputChannel.appendLine('');
                outputChannel.appendLine('Example:');
                outputChannel.appendLine('  "callGraph.defaultScipCallgraphPath": "/home/user/git_repos/scip-callgraph"');
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
function executeCommand(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.execFile(command, args, (error, stdout) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}

