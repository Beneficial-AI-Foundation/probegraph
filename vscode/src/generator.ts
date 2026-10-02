/**
 * Generator - run `probe-verus extract` to produce or refresh the index
 *
 * This module handles:
 * - Running probe-verus in the background, without a shell
 * - Writing to a temporary file and renaming it over the index on success
 * - Showing progress in the status bar
 * - Debouncing save events
 * - Checking the prerequisites probe-verus itself needs, and installing them
 *   through `probe-verus setup`
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { resolveIndexPath } from './indexLoader';

/**
 * Options for one run; each defaults to the folder's settings
 */
export interface GeneratorOptions {
    /** Skip Verus verification (faster, but no verification status) */
    skipVerification?: boolean;

    /** Index with rust-analyzer instead of verus-analyzer (plain Rust projects) */
    useRustAnalyzer?: boolean;

    /** Re-index even when probe-verus's SCIP cache is current */
    regenerateScip?: boolean;

    /** The package to extract in a workspace with several members (`--package`) */
    package?: string;
}

/**
 * Status of the generator
 */
export type GeneratorStatus = 'idle' | 'running' | 'success' | 'error';

/** Where the extension looks for probe-verus and how it got on. */
export interface ProbeVerusCheck {
    /** The command the extension runs: the setting, with `~` expanded */
    command: string;
    /** `probe-verus --version` output, when it ran */
    version?: string;
    /** Tools `probe-verus setup --status` reports as missing */
    missingTools: string[];
    /** The full `setup --status` report, for the output channel */
    report?: string;
}

const OUTPUT_CHANNEL = 'Call Graph Pipeline';
const RELEASES_URL = 'https://github.com/Beneficial-AI-Foundation/probe-verus/releases';

/**
 * Singleton state for the generator
 */
let currentStatus: GeneratorStatus = 'idle';
let statusBarItem: vscode.StatusBarItem | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let currentProcess: cp.ChildProcess | null = null;
let outputChannel: vscode.OutputChannel | null = null;

/**
 * Initialize the generator
 */
export function initializeGenerator(context: vscode.ExtensionContext): void {
    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'callGraph.showPipelineOutput';
    context.subscriptions.push(statusBarItem);

    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL);
    context.subscriptions.push(outputChannel);

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
 * Trigger regeneration with debouncing, for the folder of the file that
 * changed
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
            runGenerator(folder);
        }
    }, debounceMs);
}

/**
 * The probe-verus command for a folder: `callGraph.probeVerusPath`, with a
 * leading `~` expanded. A bare name is looked up on PATH by the spawn.
 */
export function probeVerusCommand(folder: vscode.WorkspaceFolder): string {
    const configured = vscode.workspace.getConfiguration('callGraph', folder)
        .get<string>('probeVerusPath', 'probe-verus').trim() || 'probe-verus';
    if (configured === '~' || configured.startsWith('~/')) {
        return path.join(os.homedir(), configured.slice(1));
    }
    return configured;
}

/**
 * Run `probe-verus extract` for a workspace folder, replacing its index
 * only if the run succeeds
 */
export async function runGenerator(folder: vscode.WorkspaceFolder, options?: GeneratorOptions): Promise<void> {
    if (!vscode.workspace.isTrusted) {
        vscode.window.showErrorMessage(
            'Regenerating the index runs probe-verus, which needs a trusted workspace.'
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
    // probe-verus writes here; the file is renamed over the index at the end,
    // so a watcher never sees a half-written index
    const tempPath = path.join(path.dirname(indexPath), `.${path.basename(indexPath)}.${process.pid}.tmp`);

    // Ensure output directory exists
    const indexDir = path.dirname(indexPath);
    if (!fs.existsSync(indexDir)) {
        fs.mkdirSync(indexDir, { recursive: true });
    }

    // Get configuration
    const config = vscode.workspace.getConfiguration('callGraph', folder);
    const skipVerification = options?.skipVerification ?? config.get<boolean>('skipVerification', false);
    const useRustAnalyzer = options?.useRustAnalyzer ?? config.get<boolean>('useRustAnalyzer', false);
    const pkg = options?.package ?? config.get<string>('package', '');

    const command = probeVerusCommand(folder);
    const args = ['extract', workspaceRoot, '-o', tempPath];
    if (skipVerification) {
        args.push('--skip-verify');
    }
    if (useRustAnalyzer) {
        args.push('--rust-analyzer');
    }
    if (options?.regenerateScip) {
        args.push('--regenerate-scip');
    }
    if (pkg) {
        args.push('--package', pkg);
    }

    // Update status
    currentStatus = 'running';
    updateStatusBar();

    const channel = output();
    channel.show(true);
    channel.appendLine(`Running: ${command} ${args.join(' ')}`);
    channel.appendLine(`Working directory: ${workspaceRoot}`);
    channel.appendLine('---');
    console.log(`[Generator] ${command} ${JSON.stringify(args)} in ${workspaceRoot}`);

    return new Promise((resolve) => {
        const startTime = Date.now();

        currentProcess = cp.spawn(command, args, { cwd: workspaceRoot });

        currentProcess.stdout?.on('data', (data) => {
            channel.append(data.toString());
        });

        currentProcess.stderr?.on('data', (data) => {
            channel.append(data.toString());
        });

        currentProcess.on('close', async (code) => {
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            currentProcess = null;
            console.log(`[Generator] exited with ${code} after ${duration}s`);

            if (code === 0 && fs.existsSync(tempPath)) {
                try {
                    await fs.promises.rename(tempPath, indexPath);
                    currentStatus = 'success';
                    channel.appendLine('---');
                    channel.appendLine(`✓ probe-verus extract completed in ${duration}s`);
                    channel.appendLine(`Output: ${indexPath}`);
                    vscode.window.showInformationMessage(`Call graph index updated (${duration}s)`);
                } catch (error: any) {
                    currentStatus = 'error';
                    channel.appendLine(`✗ Could not replace ${indexPath}: ${error.message}`);
                    vscode.window.showErrorMessage(`Could not replace the call graph index. See output for details.`);
                }
            } else {
                currentStatus = 'error';
                await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
                channel.appendLine('---');
                channel.appendLine(code === 0
                    ? `✗ probe-verus exited without writing ${tempPath}`
                    : `✗ probe-verus failed with exit code ${code}`);
                vscode.window.showErrorMessage(`probe-verus extract failed. See output for details.`);
            }

            updateStatusBar();
            resolve();
        });

        currentProcess.on('error', (error) => {
            currentStatus = 'error';
            currentProcess = null;
            console.error(`[Generator] failed to start: ${error.message}`);
            channel.appendLine('---');
            channel.appendLine(`✗ Failed to start probe-verus: ${error.message}`);

            // Show helpful error message
            if (error.message.includes('ENOENT')) {
                channel.appendLine('');
                channel.appendLine(`${command} was not found.`);
                channel.appendLine(`Install probe-verus from ${RELEASES_URL} (the installer puts it on PATH),`);
                channel.appendLine('or set "callGraph.probeVerusPath" to the binary.');
            }

            vscode.window.showErrorMessage('Failed to start probe-verus. See output for details.');
            updateStatusBar();
            resolve();
        });
    });
}

/**
 * Cancel the running generator
 */
export function cancelGenerator(): void {
    if (currentProcess) {
        currentProcess.kill();
        currentProcess = null;
        currentStatus = 'idle';
        updateStatusBar();
        vscode.window.showInformationMessage('probe-verus cancelled');
    }
}

/**
 * Get the current generator status
 */
export function getGeneratorStatus(): GeneratorStatus {
    return currentStatus;
}

/** True when the folder's language has a generator here and it can be run. */
export async function hasGenerator(folder: vscode.WorkspaceFolder, languageId: string): Promise<boolean> {
    if (languageId !== 'rust') {
        return false;
    }
    try {
        await executeCommand(probeVerusCommand(folder), ['--version']);
        return true;
    } catch {
        return false;
    }
}

/**
 * Update the status bar item. It sits next to the session's "Call Graph: …"
 * item, which says what is loaded; this one says what probe-verus is doing.
 */
function updateStatusBar(): void {
    if (!statusBarItem) {
        return;
    }

    switch (currentStatus) {
        case 'running':
            statusBarItem.text = '$(sync~spin) probe-verus: running';
            statusBarItem.tooltip = 'Click to view probe-verus output';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            statusBarItem.show();
            break;

        case 'success':
            statusBarItem.text = '$(check) probe-verus: done';
            statusBarItem.tooltip = 'The call graph index was replaced';
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
            statusBarItem.text = '$(error) probe-verus: failed';
            statusBarItem.tooltip = 'Click to view error details';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            statusBarItem.show();
            break;

        default:
            statusBarItem.hide();
    }
}

/**
 * Is probe-verus there, and does it have its tools? `probe-verus setup
 * --status` prints a table with one line per tool whose status column is
 * `managed`, `PATH` or `missing`; the missing ones are returned by name. The
 * whole report goes to the output channel.
 */
export async function checkPrerequisites(folder: vscode.WorkspaceFolder): Promise<ProbeVerusCheck> {
    const command = probeVerusCommand(folder);
    const check: ProbeVerusCheck = { command, missingTools: [] };
    try {
        check.version = (await executeCommand(command, ['--version'])).trim();
    } catch {
        return check;
    }
    try {
        const report = await executeCommand(command, ['setup', '--status'], folder.uri.fsPath);
        check.report = report;
        for (const line of report.split('\n')) {
            const m = /^(\S+)\s.*\s(managed|PATH|missing)\s/.exec(line + ' ');
            if (m && m[2] === 'missing') {
                check.missingTools.push(m[1]);
            }
        }
        const channel = output();
        channel.appendLine(`${check.version} (${command})`);
        channel.append(report.endsWith('\n') ? report : report + '\n');
        channel.appendLine('---');
    } catch (error: any) {
        check.report = `probe-verus setup --status failed: ${error.message}`;
    }
    return check;
}

/** Where to get probe-verus, for messages. */
export const PROBE_VERUS_INSTALL_HINT =
    `Install probe-verus from ${RELEASES_URL} (the installer script puts it on PATH), ` +
    'or set callGraph.probeVerusPath to the binary.';

/**
 * Run `probe-verus setup --from-project <folder>`, which downloads the
 * analyzer, scip and the Verus release the project pins, plus its Rust
 * toolchain. Only after the user asked, and only in a trusted workspace.
 */
export async function installTools(folder: vscode.WorkspaceFolder): Promise<boolean> {
    if (!vscode.workspace.isTrusted) {
        vscode.window.showErrorMessage('Installing tools runs probe-verus setup, which needs a trusted workspace.');
        return false;
    }
    const command = probeVerusCommand(folder);
    const args = ['setup', '--from-project', folder.uri.fsPath];
    const channel = output();
    channel.show(true);
    channel.appendLine(`Running: ${command} ${args.join(' ')}`);
    channel.appendLine('---');
    return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'probe-verus setup', cancellable: true },
        (_progress, token) => new Promise<boolean>((resolve) => {
            const child = cp.spawn(command, args, { cwd: folder.uri.fsPath });
            token.onCancellationRequested(() => child.kill());
            child.stdout?.on('data', (d) => channel.append(d.toString()));
            child.stderr?.on('data', (d) => channel.append(d.toString()));
            child.on('error', (error) => {
                channel.appendLine(`✗ Failed to start probe-verus: ${error.message}`);
                resolve(false);
            });
            child.on('close', (code) => {
                channel.appendLine('---');
                channel.appendLine(code === 0 ? '✓ probe-verus setup completed' : `✗ probe-verus setup exited with ${code}`);
                resolve(code === 0);
            });
        }),
    );
}

function output(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL);
    }
    return outputChannel;
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
