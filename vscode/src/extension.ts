/**
 * Call Graph Visualizer Extension
 * 
 * Shows the probegraph call graph around the Rust, Verus or Lean declaration
 * at the cursor, from a pipeline index or a probe extract.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { formatTimestamp, isInside, D3Node } from './indexLoader';
import { resolveCursor } from '../../web/src/editor-lookup';
import { enclosingSymbol } from './cursorSymbol';
import { GraphPanel, Direction, HostMessage, WebviewMessage } from './webviewLoader';
import { GraphRevision, GraphSession, Sessions } from './session';
import { 
    initializePipelineRunner, 
    runPipeline, 
    cancelPipeline, 
    checkPrerequisites,
    getPipelineStatus,
    hasGenerator,
} from './pipelineRunner';

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

    // Initialize the pipeline runner
    initializePipelineRunner(context);
    
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
    
    // Cancel pipeline
    context.subscriptions.push(
        vscode.commands.registerCommand('callGraph.cancelPipeline', () => {
            cancelPipeline();
        })
    );
    
    // Show pipeline output (for status bar click)
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

/** A warning with a Regenerate button when a generator is configured. */
async function reportNotIndexed(message: string, languageId: string): Promise<void> {
    const folder = sessions.session?.folder;
    if (folder && hasGenerator(folder, languageId)) {
        const action = await vscode.window.showWarningMessage(message, 'Regenerate');
        if (action === 'Regenerate') {
            await regenerateIndex();
        }
    } else {
        vscode.window.showWarningMessage(message);
    }
}

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
            `No graph at ${session.indexPath}. Run \`probe-lean extract\` on the Lake project, ` +
            `or point callGraph.indexPath at an extract.`
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
        vscode.window.showWarningMessage(`${name} is hidden by a combination of the viewer's filters.`);
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
 * Regenerate the call graph index for the session's folder (or the active
 * editor's)
 */
async function regenerateIndex(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const folder = sessions.session?.folder ?? (uri && vscode.workspace.getWorkspaceFolder(uri));
    if (!folder) {
        vscode.window.showErrorMessage('Open a file in the project to regenerate its call graph');
        return;
    }
    
    // Check if already running
    if (getPipelineStatus() === 'running') {
        const action = await vscode.window.showWarningMessage(
            'Pipeline is already running. Would you like to cancel it?',
            'Cancel Pipeline',
            'Wait'
        );
        
        if (action === 'Cancel Pipeline') {
            cancelPipeline();
        }
        return;
    }
    
    // Check prerequisites first
    const prereqs = await checkPrerequisites();
    if (!prereqs.ok) {
        const detail = prereqs.missing.join('\n');
        const action = await vscode.window.showWarningMessage(
            `Some prerequisites are missing:\n${detail}`,
            'Continue Anyway',
            'Cancel'
        );
        
        if (action !== 'Continue Anyway') {
            return;
        }
    }
    
    // Run the pipeline; the session's watcher picks up the new file
    await runPipeline(folder);
}

/**
 * Show prerequisite status
 */
async function showPrerequisiteStatus(): Promise<void> {
    const prereqs = await checkPrerequisites();
    
    if (prereqs.ok) {
        vscode.window.showInformationMessage('All prerequisites are met! ✅');
    } else {
        const detail = prereqs.missing.join('\n• ');
        vscode.window.showWarningMessage(
            `Missing prerequisites:\n• ${detail}`,
            'Show Documentation'
        ).then((action) => {
            if (action === 'Show Documentation') {
                vscode.env.openExternal(
                    vscode.Uri.parse('https://github.com/Beneficial-AI-Foundation/probegraph')
                );
            }
        });
    }
}

/**
 * Extension deactivation
 */
export function deactivate() {
    console.log('Call Graph Visualizer extension deactivated');
}
