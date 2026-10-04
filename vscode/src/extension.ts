/**
 * Call Graph Visualizer Extension
 * 
 * Shows the probegraph call graph around the Rust, Verus or Lean declaration
 * at the cursor, from a probe extract (probe-verus, probe-lean) or a legacy
 * pipeline index.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { formatTimestamp, isInside, isLeanGraph, D3Node } from './indexLoader';
import { resolveCursor } from '../../web/src/editor-lookup';
import { enclosingSymbol } from './cursorSymbol';
import { GraphPanel, Direction, HostMessage, WebviewMessage } from './webviewLoader';
import { GraphRevision, GraphSession, Sessions } from './session';
import {
    PROBE_VERUS_INSTALL_HINT,
    cancelGenerator,
    checkPrerequisites,
    getGeneratorStatus,
    hasGenerator,
    initializeGenerator,
    installTools,
    probeVerusCommand,
    probeVerusVersion,
    runGenerator,
} from './generator';

/**
 * API returned from activate(), for the integration tests
 */
export interface CallGraphApi {
    /** Every message the webview posts */
    onDidReceiveWebviewMessage: vscode.Event<WebviewMessage>;
    /** Every message sent to the webview */
    onDidPostMessage: vscode.Event<HostMessage>;
    /** Handle a message as if the webview had posted it */
    deliverWebviewMessage(message: WebviewMessage): Promise<void>;
}

let sessions: Sessions;
let panel: GraphPanel;

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): CallGraphApi {
    console.log('Call Graph Visualizer extension is now active!');
    
    sessions = new Sessions(context.globalStorageUri.fsPath);
    panel = new GraphPanel(context, () => sessions.graph);
    context.subscriptions.push(
        sessions,
        panel,
        sessions.onDidChangeGraph(() => panel.graphChanged()),
        panel.onDidSelect((result) => {
            if (result.status === 'filtered') {
                reportFiltered(result.selection.nodeId, result.filteredBy);
            } else if (result.status === 'missing') {
                vscode.window.showWarningMessage('The declaration is no longer in the graph.');
            }
        }),
    );

    // Initialize the generator
    initializeGenerator(context);
    
    // Register commands
    registerCommands(context);
    
    // Bind to the active editor's folder so the status bar says what is loaded
    preloadIndex();

    return {
        onDidReceiveWebviewMessage: panel.onDidReceiveMessage,
        onDidPostMessage: panel.onDidPostMessage,
        deliverWebviewMessage: (m) => panel.deliver(m),
    };
}

/**
 * Register all extension commands
 */
function registerCommands(context: vscode.ExtensionContext): void {
    const show = (direction: Direction) => () => showCallGraph(direction);

    context.subscriptions.push(
        vscode.commands.registerCommand('callGraph.showAtCursor', show('both')),
        vscode.commands.registerCommand('callGraph.showGraph', show('both')),
        vscode.commands.registerCommand('callGraph.showDependencies', show('callees')),
        vscode.commands.registerCommand('callGraph.showDependents', show('callers')),
        // Legacy command for backwards compatibility
        vscode.commands.registerCommand('call-graph-visualizer.displayCallGraph', show('both')),
    );
    
    // Regenerate index
    context.subscriptions.push(
        vscode.commands.registerCommand('callGraph.regenerateIndex', async () => {
            await regenerateIndex();
        })
    );
    
    // Cancel a running probe-verus
    context.subscriptions.push(
        vscode.commands.registerCommand('callGraph.cancelPipeline', () => {
            cancelGenerator();
        })
    );
    
    // Show the generator's output (for status bar click)
    context.subscriptions.push(
        vscode.commands.registerCommand('callGraph.showPipelineOutput', () => {
            // Focus the output channel
            vscode.commands.executeCommand('workbench.action.output.show', { 
                id: 'Call Graph Pipeline' 
            });
        })
    );
    
    // Check prerequisites
    context.subscriptions.push(
        vscode.commands.registerCommand('callGraph.checkPrerequisites', async () => {
            await showPrerequisiteStatus();
        })
    );
}

/**
 * Bind to the active editor's folder and read its graph, if there is one
 */
function preloadIndex(): void {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
        return;
    }
    const session = sessions.bind(folder);
    session?.load().catch((error) => {
        console.warn('[Extension] No index to preload:', error.message);
    });
}

const SUPPORTED_LANGUAGES = new Set(['rust', 'lean4']);

/**
 * Show call graph for the function at cursor
 */
async function showCallGraph(direction: Direction): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active text editor');
        return;
    }
    
    if (!SUPPORTED_LANGUAGES.has(editor.document.languageId)) {
        vscode.window.showErrorMessage('The call graph works in Rust and Lean files');
        return;
    }
    
    if (editor.document.uri.scheme !== 'file') {
        vscode.window.showErrorMessage('The call graph works on files on disk');
        return;
    }
    
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!folder) {
        vscode.window.showErrorMessage('File is not in a workspace folder');
        return;
    }
    
    // Where the cursor was when the command ran, not after the awaits below
    const position = editor.selection.active;
    const session = await sessions.forFolder(folder);
    if (!session) {
        return;
    }
    
    let graph: GraphRevision;
    try {
        graph = await session.load();
    } catch (error: any) {
        await reportUnreadable(session, editor.document.languageId, error);
        return;
    }

    const node = await findNodeAtCursor(editor.document, position, graph);
    if (!node) {
        return;
    }
    
    const depth = vscode.workspace.getConfiguration('callGraph', folder).get<number>('depth', 3);
    panel.show({ nodeId: node.id, direction, depth });
}

/**
 * The graph node of the declaration at the cursor. When there is none, says
 * why and returns null; when several fit, asks.
 */
async function findNodeAtCursor(
    document: vscode.TextDocument,
    position: vscode.Position,
    graph: GraphRevision,
): Promise<D3Node | null> {
    const { projectRoot, index } = graph;
    if (!isInside(projectRoot, document.uri.fsPath)) {
        vscode.window.showWarningMessage(
            `${path.basename(document.uri.fsPath)} is outside the project root ${projectRoot}. ` +
            `Set callGraph.projectRoot if the graph's paths are relative to another directory.`
        );
        return null;
    }
    const graphPath = path.relative(projectRoot, document.uri.fsPath).split(path.sep).join('/');
    const symbol = await enclosingSymbol(document, position);
    const result = resolveCursor(index.locations, { graphPath, line: position.line + 1, symbol });
    
    switch (result.kind) {
        case 'match':
            return result.node;
        case 'ambiguous': {
            const picked = await vscode.window.showQuickPick(
                result.candidates.map(n => ({
                    label: n.display_name,
                    description: `lines ${n.start_line}-${n.end_line ?? n.start_line}`,
                    detail: n.id,
                    node: n
                })),
                { placeHolder: 'Several graph nodes are declared here. Select one:' }
            );
            return picked?.node ?? null;
        }
        case 'not-indexed': {
            const what = {
                file: `${graphPath} is not in the graph (paths are relative to ${projectRoot}; ` +
                    `callGraph.projectRoot changes that)`,
                line: 'No declaration in the graph covers this line',
                symbol: `\`${symbol?.name}\` is not in the graph`,
            }[result.reason];
            await reportNotIndexed(`${what}. ${describeIndex(graph)}`, document.languageId);
            return null;
        }
    }
}

/** Which file the graph came from and how old it is, for messages. */
function describeIndex(graph: GraphRevision): string {
    const { indexPath, extractedAt, sourceCommit } = graph.index.metadata;
    return `Graph: ${path.basename(indexPath)}, ` +
        `extracted ${extractedAt ? formatTimestamp(extractedAt) : 'unknown'}, ` +
        `commit ${sourceCommit ? sourceCommit.slice(0, 7) : 'unknown'}.`;
}

/**
 * A warning with a Regenerate button when a generator can run here. The
 * command does not wait for the toast to be answered.
 */
async function reportNotIndexed(message: string, languageId: string): Promise<void> {
    const folder = sessions.session?.folder;
    if (folder && await hasGenerator(folder, languageId)) {
        vscode.window.showWarningMessage(message, 'Regenerate').then((action) => {
            if (action === 'Regenerate') {
                return regenerateIndex();
            }
        }).then(undefined, console.error);
    } else {
        vscode.window.showWarningMessage(message);
    }
}

/** Lean graphs are produced outside the extension. */
const LEAN_EXTRACT_HINT = 'Run `probe-lean extract` on the Lake project';

/** The index could not be read: missing, or not a graph. */
async function reportUnreadable(session: GraphSession, languageId: string, error: any): Promise<void> {
    if (session.indexState !== 'none') {
        vscode.window.showErrorMessage(`Failed to read the call graph: ${error.message}`);
        return;
    }
    if (languageId === 'rust') {
        const action = await vscode.window.showWarningMessage(
            'Call graph index not found. Would you like to generate it now?',
            'Generate Index',
            'Cancel'
        );
        if (action === 'Generate Index') {
            await regenerateIndex();
        }
    } else {
        vscode.window.showWarningMessage(
            `No graph at ${session.indexPath}. ${LEAN_EXTRACT_HINT}, or point callGraph.indexPath at an extract.`
        );
    }
}

const FILTER_NAMES: Record<string, string> = {
    showExecFunctions: 'Exec', showProofFunctions: 'Proof', showSpecFunctions: 'Spec',
    showAxioms: 'Axiom', showTypes: 'Type', showProjections: 'Projection', showInstances: 'Instance',
    showRustNodes: 'Rust', showLeanNodes: 'Lean', showLibsignal: 'libsignal', showNonLibsignal: 'non-libsignal',
    showVerifiedNodes: 'Verified', showFailedNodes: 'Failed', showUnverifiedNodes: 'Unverified',
    exactStatuses: 'status', excludeNamePatterns: 'name exclusion', excludePathPatterns: 'path exclusion',
    includeFiles: 'file',
};

/** The selected node is in the graph but a viewer filter hides it. */
async function reportFiltered(nodeId: string, filteredBy: string[]): Promise<void> {
    const name = sessions.graph?.index.graph.nodes.find(n => n.id === nodeId)?.display_name ?? nodeId;
    if (filteredBy.length === 0) {
        // The viewer found no set of node filters whose relaxation draws it
        vscode.window.showWarningMessage(`${name} is not drawn by the viewer even with every node filter off.`);
        return;
    }
    const names = filteredBy.map(k => FILTER_NAMES[k] ?? k);
    const action = await vscode.window.showWarningMessage(
        `${name} is hidden by the ${names.join(' and ')} filter${names.length > 1 ? 's' : ''}.`,
        'Show it'
    );
    if (action === 'Show it') {
        panel.relaxFilters(filteredBy);
    }
}

/**
 * Whether the folder's call graph is a Lean one: its loaded graph says, or,
 * before one is loaded, a Rust or Lean editor in that folder does. An editor
 * from another folder says nothing, so the answer is undefined.
 */
function isLeanProject(
    folder: vscode.WorkspaceFolder, graph: GraphRevision | null, editor: vscode.TextEditor | undefined,
): boolean | undefined {
    if (graph) {
        return isLeanGraph(graph.index.graph);
    }
    if (!editor || !SUPPORTED_LANGUAGES.has(editor.document.languageId)) {
        return undefined;
    }
    const editorFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (editorFolder?.uri.toString() !== folder.uri.toString()) {
        return undefined;
    }
    return editor.document.languageId === 'lean4';
}

/**
 * Regenerate the call graph index for the session's folder (or the active
 * editor's). Only Rust graphs have a generator here; for a Lean graph, say
 * how it is produced; when neither a graph nor an editor in the folder says
 * which it is, do nothing rather than guess Rust.
 */
async function regenerateIndex(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const folder = sessions.session?.folder ?? (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri));
    const lean = folder && isLeanProject(folder, sessions.graph, editor);
    if (!folder || lean === undefined) {
        vscode.window.showErrorMessage('Open a file in the project to regenerate its call graph');
        return;
    }
    if (lean) {
        const indexPath = sessions.session?.indexPath;
        vscode.window.showWarningMessage(
            `Lean graphs are not generated by the extension. ${LEAN_EXTRACT_HINT}` +
            `${indexPath ? ` to refresh ${indexPath}` : ''}.`
        );
        return;
    }
    // Before probe-verus is run at all, even for its version
    if (!vscode.workspace.isTrusted) {
        vscode.window.showErrorMessage(
            'Regenerating the index runs probe-verus, which needs a trusted workspace.'
        );
        return;
    }
    
    // Check if already running
    if (getGeneratorStatus() === 'running') {
        const action = await vscode.window.showWarningMessage(
            'probe-verus is already running. Would you like to cancel it?',
            'Cancel',
            'Wait'
        );
        
        if (action === 'Cancel') {
            cancelGenerator();
        }
        return;
    }
    
    // probe-verus must be there. Whether it has its tools is not checked
    // here: `setup --status` goes to GitHub for the current Verus release.
    // A missing verus-analyzer or scip fails the extract with a clear
    // message, and a missing `cargo verus` only skips verification, which
    // `runGenerator` spots in the output; both toasts offer "Check
    // Prerequisites".
    if (await probeVerusVersion(folder) === undefined) {
        await reportNoProbeVerus(probeVerusCommand(folder));
        return;
    }
    
    // Run probe-verus; the session's watcher picks up the new file
    await runGenerator(folder);
}

/** probe-verus itself was not found. */
async function reportNoProbeVerus(command: string): Promise<void> {
    const action = await vscode.window.showErrorMessage(
        `${command} was not found. ${PROBE_VERUS_INSTALL_HINT}`,
        'Open releases',
        'Open Settings'
    );
    if (action === 'Open releases') {
        vscode.env.openExternal(vscode.Uri.parse('https://github.com/Beneficial-AI-Foundation/probe-verus/releases'));
    } else if (action === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'callGraph.probeVerusPath');
    }
}

/**
 * Show prerequisite status: probe-verus's version and what `probe-verus
 * setup --status` says about its tools (the full report is in the output
 * channel)
 */
async function showPrerequisiteStatus(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const folder = sessions.session?.folder
        ?? (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri))
        ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showErrorMessage('Open a folder to check its prerequisites');
        return;
    }
    const check = await checkPrerequisites(folder);
    if (!check.version) {
        await reportNoProbeVerus(check.command);
        return;
    }
    if (check.missingTools === undefined) {
        const action = await vscode.window.showErrorMessage(
            `${check.version} found, but \`probe-verus setup --status\` failed, so whether its tools are installed is unknown.`,
            'Show output'
        );
        if (action === 'Show output') {
            vscode.commands.executeCommand('callGraph.showPipelineOutput');
        }
        return;
    }
    if (check.missingTools.length === 0) {
        vscode.window.showInformationMessage(
            `${check.version} found; its tools are installed. Details in the Call Graph Pipeline output.`
        );
        return;
    }
    const action = await vscode.window.showWarningMessage(
        `${check.version} found, but ${check.missingTools.join(', ')} ${check.missingTools.length > 1 ? 'are' : 'is'} missing.`,
        'Install tools',
        'Show output'
    );
    if (action === 'Install tools') {
        await installTools(folder);
    } else if (action === 'Show output') {
        vscode.commands.executeCommand('callGraph.showPipelineOutput');
    }
}

/**
 * Extension deactivation
 */
export function deactivate() {
    console.log('Call Graph Visualizer extension deactivated');
}
