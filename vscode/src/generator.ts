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
 * Status of the generator
 */
export type GeneratorStatus = 'idle' | 'running' | 'success' | 'error';

/** Where the extension looks for probe-verus and how it got on. */
export interface ProbeVerusCheck {
    /** The command the extension runs: the setting, with `~` expanded */
    command: string;
    /** `probe-verus --version` output, when it ran */
    version?: string;
    /**
     * What `probe-verus setup --status` reports as missing: tools by name,
     * and `Rust toolchain <channel>` when the one Verus needs is not installed
     */
    missingTools: string[];
    /** The full `setup --status` report, for the output channel */
    report?: string;
}

/** One `probe-verus extract`, from spawn to the single finalisation. */
interface Run {
    child: cp.ChildProcess;
    /** `cancelGenerator` was called; the exit that follows is not a failure */
    cancelled: boolean;
    /** The run has been finalised (`error` and `close` can both fire) */
    settled: boolean;
}

const OUTPUT_CHANNEL = 'Call Graph Pipeline';
const RELEASES_URL = 'https://github.com/Beneficial-AI-Foundation/probe-verus/releases';

/**
 * Singleton state for the generator
 */
let currentStatus: GeneratorStatus = 'idle';
let statusBarItem: vscode.StatusBarItem | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let currentRun: Run | null = null;
let runCount = 0;
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
 * Run `probe-verus extract` for a workspace folder with its settings,
 * replacing its index only if the run succeeds. One run at a time: while
 * one is going, another request is logged and dropped.
 */
export async function runGenerator(folder: vscode.WorkspaceFolder): Promise<void> {
    if (!vscode.workspace.isTrusted) {
        vscode.window.showErrorMessage(
            'Regenerating the index runs probe-verus, which needs a trusted workspace.'
        );
        return;
    }
    if (currentStatus === 'running') {
        // Two runs would race on the index; the caller's own guard may have
        // been checked before an await
        output().appendLine('probe-verus is already running; not starting another');
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
    // so a watcher never sees a half-written index. The counter keeps runs
    // of this extension host apart (the pid alone is the same for all of them).
    const tempPath = path.join(
        path.dirname(indexPath), `.${path.basename(indexPath)}.${process.pid}.${++runCount}.tmp`,
    );

    // Ensure output directory exists
    const indexDir = path.dirname(indexPath);
    if (!fs.existsSync(indexDir)) {
        fs.mkdirSync(indexDir, { recursive: true });
    }

    const config = vscode.workspace.getConfiguration('callGraph', folder);
    const command = probeVerusCommand(folder);
    const args = ['extract', workspaceRoot, '-o', tempPath];
    if (config.get<boolean>('skipVerification', false)) {
        args.push('--skip-verify');
    }
    if (config.get<boolean>('useRustAnalyzer', false)) {
        args.push('--rust-analyzer');
    }
    const pkg = config.get<string>('package', '');
    if (pkg) {
        args.push('--package', pkg);
    }

    // Nothing has been awaited since the guard above, so this is the only run
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

        // probe-verus runs verus-analyzer and `cargo verus` as children of its
        // own. In its own process group they can be killed with it; Windows
        // has taskkill /T for that instead (see `killTree`).
        const child = cp.spawn(command, args, { cwd: workspaceRoot, detached: process.platform !== 'win32' });
        const run: Run = { child, cancelled: false, settled: false };
        currentRun = run;
        // The end of stderr, to recognise a probe-verus without `extract -o`
        let stderrTail = '';

        child.stdout?.on('data', (data) => {
            channel.append(data.toString());
        });

        child.stderr?.on('data', (data) => {
            const text = data.toString();
            channel.append(text);
            stderrTail = (stderrTail + text).slice(-16 * 1024);
        });

        /**
         * The one place the run ends: sets the status, removes the temp file
         * unless it became the index, and shows one message. `error` is
         * followed by `close` (and cancel by `close`), so it runs once.
         */
        const settle = async (code: number | null, startError?: Error): Promise<void> => {
            if (run.settled) {
                return;
            }
            run.settled = true;
            if (currentRun === run) {
                currentRun = null;
            }
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`[Generator] exited with ${code} after ${duration}s`);
            channel.appendLine('---');

            if (run.cancelled) {
                await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
                currentStatus = 'idle';
                channel.appendLine(`probe-verus cancelled after ${duration}s`);
                vscode.window.showInformationMessage('probe-verus cancelled');
            } else if (startError) {
                currentStatus = 'error';
                console.error(`[Generator] failed to start: ${startError.message}`);
                channel.appendLine(`✗ Failed to start probe-verus: ${startError.message}`);
                if (startError.message.includes('ENOENT')) {
                    channel.appendLine('');
                    channel.appendLine(`${command} was not found.`);
                    channel.appendLine(`Install probe-verus from ${RELEASES_URL} (the installer puts it on PATH),`);
                    channel.appendLine('or set "callGraph.probeVerusPath" to the binary.');
                }
                vscode.window.showErrorMessage('Failed to start probe-verus. See output for details.');
            } else if (code === 0 && fs.existsSync(tempPath)) {
                try {
                    await fs.promises.rename(tempPath, indexPath);
                    currentStatus = 'success';
                    channel.appendLine(`✓ probe-verus extract completed in ${duration}s`);
                    channel.appendLine(`Output: ${indexPath}`);
                    vscode.window.showInformationMessage(`Call graph index updated (${duration}s)`);
                } catch (error: any) {
                    currentStatus = 'error';
                    channel.appendLine(`✗ Could not replace ${indexPath}: ${error.message}`);
                    vscode.window.showErrorMessage('Could not replace the call graph index. See output for details.');
                }
            } else {
                currentStatus = 'error';
                await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
                channel.appendLine(code === 0
                    ? `✗ probe-verus exited without writing ${tempPath}`
                    : `✗ probe-verus failed with exit code ${code}`);
                reportFailure(stderrTail);
            }

            updateStatusBar();
            resolve();
        };

        child.on('close', (code) => { settle(code); });
        child.on('error', (error) => { settle(null, error); });
    });
}

/**
 * The toast for a failed extract. A probe-verus up to v8.0.1 passes every
 * check and then rejects `-o` (clap exits 2 with "unexpected argument");
 * that one gets its own message. Otherwise the output has the details, and
 * `setup --status` can say whether a tool is missing.
 */
function reportFailure(stderrTail: string): void {
    if (/unexpected argument '(-o|--output)'/.test(stderrTail)) {
        vscode.window.showErrorMessage(
            'This probe-verus predates `extract -o`. Install a release newer than v8.0.1.',
            'Open releases',
        ).then((action) => {
            if (action === 'Open releases') {
                vscode.env.openExternal(vscode.Uri.parse(RELEASES_URL));
            }
        }, console.error);
        return;
    }
    vscode.window.showErrorMessage(
        'probe-verus extract failed. See output for details.',
        'Check Prerequisites',
    ).then((action) => {
        if (action === 'Check Prerequisites') {
            return vscode.commands.executeCommand('callGraph.checkPrerequisites');
        }
    }).then(undefined, console.error);
}

/**
 * Cancel the running generator. The run is finalised when probe-verus has
 * exited, by the same `close` handler as any other exit.
 */
export function cancelGenerator(): void {
    const run = currentRun;
    if (!run || run.settled || run.cancelled) {
        return;
    }
    run.cancelled = true;
    killTree(run.child);
}

/**
 * Kill a child spawned by `runGenerator` and the processes it spawned:
 * the process group on POSIX (`detached` made the child its leader), the
 * tree by taskkill on Windows. Falls back to killing the child alone.
 */
function killTree(child: cp.ChildProcess): void {
    if (child.pid === undefined) {
        child.kill();
        return;
    }
    if (process.platform === 'win32') {
        cp.spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
            .on('error', () => child.kill());
        return;
    }
    try {
        process.kill(-child.pid, 'SIGTERM');
    } catch {
        child.kill();
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
    return languageId === 'rust' && await probeVerusVersion(folder) !== undefined;
}

/**
 * `probe-verus --version` for the folder's command, or undefined when it
 * cannot run. Local and quick, unlike `setup --status`, so this is the check
 * before a run.
 */
export async function probeVerusVersion(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
    try {
        return (await executeCommand(probeVerusCommand(folder), ['--version'])).trim();
    } catch {
        return undefined;
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
 * `managed`, `PATH` or `missing`, then the Rust toolchain the resolved Verus
 * needs with `Status: NOT INSTALLED` when rustup lacks it; what is missing
 * is returned by name. The whole report goes to the output channel.
 *
 * The status report asks GitHub which Verus release is current, so this is
 * for "Check Prerequisites" and after a failure, not before every run.
 */
export async function checkPrerequisites(folder: vscode.WorkspaceFolder): Promise<ProbeVerusCheck> {
    const command = probeVerusCommand(folder);
    const check: ProbeVerusCheck = { command, missingTools: [] };
    check.version = await probeVerusVersion(folder);
    if (check.version === undefined) {
        return check;
    }
    try {
        const report = await executeCommand(command, ['setup', '--status'], folder.uri.fsPath);
        check.report = report;
        check.missingTools = missingFromStatus(report);
        const channel = output();
        channel.appendLine(`${check.version} (${command})`);
        channel.append(report.endsWith('\n') ? report : report + '\n');
        channel.appendLine('---');
    } catch (error: any) {
        check.report = `probe-verus setup --status failed: ${error.message}`;
    }
    return check;
}

/** What a `probe-verus setup --status` report says is missing, by name. */
export function missingFromStatus(report: string): string[] {
    const missing: string[] = [];
    let toolchain: string | undefined;
    for (const line of report.split('\n')) {
        const tool = /^(\S+)\s.*\s(managed|PATH|missing)\s/.exec(line + ' ');
        if (tool && tool[2] === 'missing') {
            missing.push(tool[1]);
            continue;
        }
        const required = /^Rust toolchain required by Verus \S+: (\S+)/.exec(line);
        if (required) {
            toolchain = required[1];
        } else if (toolchain && /^\s+Status: NOT INSTALLED/.test(line)) {
            missing.push(`Rust toolchain ${toolchain}`);
        }
    }
    return missing;
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
