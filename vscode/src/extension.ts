/**
 * Call Graph Visualizer Extension
 * 
 * Shows the probegraph call graph around the Rust, Verus or Lean declaration
 * at the cursor, from a pipeline index or a probe extract.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { 
    loadIndex, 
    indexExists,
    formatTimestamp,
    CallGraphIndex,
    D3Node
} from './indexLoader';
import { resolveCursor } from '../../web/src/editor-lookup';
import { enclosingSymbol } from './cursorSymbol';
import { 
    showCallGraphWebview,
    ShowGraphOptions,
    onDidReceiveWebviewMessage,
    onDidSendGraph
} from './webviewLoader';
import { 
    initializePipelineRunner, 
    runPipeline, 
    cancelPipeline, 
    checkPrerequisites,
    getPipelineStatus
} from './pipelineRunner';

/**
 * API returned from activate(), for the integration tests
 */
export interface CallGraphApi {
    onDidReceiveWebviewMessage: vscode.Event<{ type: string }>;
    onDidSendGraph: vscode.Event<{ type: string; selectedNodeId: string | null }>;
}

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): CallGraphApi {
    console.log('Call Graph Visualizer extension is now active!');
    
    // Initialize the pipeline runner
    initializePipelineRunner(context);
    
    // Register commands
    registerCommands(context);
    
    // Preload index if available
    preloadIndex();

    return { onDidReceiveWebviewMessage, onDidSendGraph };
}

/**
 * Register all extension commands
 */
function registerCommands(context: vscode.ExtensionContext): void {
    // Show call graph (bidirectional - default)
    context.subscriptions.push(
        vscode.commands.registerCommand('callGraph.showGraph', async () => {
            await showCallGraph(context, 'both');
        })
    );
    
    // Show dependencies only
    context.subscriptions.push(
        vscode.commands.registerCommand('callGraph.showDependencies', async () => {
            await showCallGraph(context, 'dependencies');
        })
    );
    
    // Show dependents only
    context.subscriptions.push(
        vscode.commands.registerCommand('callGraph.showDependents', async () => {
            await showCallGraph(context, 'dependents');
        })
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
    
    // Legacy command for backwards compatibility
    context.subscriptions.push(
        vscode.commands.registerCommand('call-graph-visualizer.displayCallGraph', async () => {
            await showCallGraph(context, 'both');
        })
    );
}

/**
 * Preload the call graph index if it exists
 */
async function preloadIndex(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return;
    }
    
    const workspaceRoot = workspaceFolder.uri.fsPath;
    
    if (indexExists(workspaceRoot)) {
        loadIndex(workspaceRoot).catch((error) => {
            console.warn('[Extension] Failed to preload index:', error.message);
        });
    }
}

const SUPPORTED_LANGUAGES = new Set(['rust', 'lean4']);

/**
 * Direction type for graph display
 */
type GraphDirection = 'both' | 'dependencies' | 'dependents';

/**
 * Show call graph for the function at cursor
 */
async function showCallGraph(
    context: vscode.ExtensionContext,
    direction: GraphDirection
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active text editor');
        return;
    }
    
    if (!SUPPORTED_LANGUAGES.has(editor.document.languageId)) {
        vscode.window.showErrorMessage('The call graph works in Rust and Lean files');
        return;
    }
    
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('File is not in a workspace folder');
        return;
    }
    
    const workspaceRoot = workspaceFolder.uri.fsPath;
    
    // Check if index exists
    if (!indexExists(workspaceRoot)) {
        const action = await vscode.window.showWarningMessage(
            'Call graph index not found. Would you like to generate it now?',
            'Generate Index',
            'Cancel'
        );
        
        if (action === 'Generate Index') {
            await regenerateIndex();
        }
        return;
    }
    
    // Show progress
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Loading call graph...',
        cancellable: false
    }, async (progress) => {
        try {
            // Load index
            progress.report({ message: 'Loading index...' });
            const index = await loadIndex(workspaceRoot);
            
            progress.report({ message: 'Finding the declaration...' });
            const node = await findNodeAtCursor(editor, workspaceFolder, index);
            if (!node) {
                return;
            }
            
            // Prepare options based on direction
            const config = vscode.workspace.getConfiguration('callGraph');
            const depth = config.get<number>('depth', 3);
            
            const options: ShowGraphOptions = {
                depth
            };
            
            // Pass the unique node ID for exact matching
            options.selectedNodeId = node.id;
            
            // Also set the display name for the query UI
            const functionName = node.display_name;
            
            switch (direction) {
                case 'both':
                    // Same query in source and sink shows full neighborhood
                    options.sourceQuery = functionName;
                    options.sinkQuery = functionName;
                    break;
                case 'dependencies':
                    // Source only shows callees (what it calls)
                    options.sourceQuery = functionName;
                    break;
                case 'dependents':
                    // Sink only shows callers (who calls it)
                    options.sinkQuery = functionName;
                    break;
            }
            
            // Show the graph
            progress.report({ message: 'Opening graph explorer...' });
            showCallGraphWebview(context, index, options);
            
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to show call graph: ${error.message}`);
            console.error('[Extension] Error showing call graph:', error);
        }
    });
}

/**
 * The graph node of the declaration at the cursor. When there is none, says
 * why and returns null; when several fit, asks.
 */
async function findNodeAtCursor(
    editor: vscode.TextEditor,
    workspaceFolder: vscode.WorkspaceFolder,
    index: CallGraphIndex
): Promise<D3Node | null> {
    const { document } = editor;
    const position = editor.selection.active;
    const graphPath = path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath).split(path.sep).join('/');
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
                file: `${graphPath} is not in the graph`,
                line: 'No declaration in the graph covers this line',
                symbol: `\`${symbol?.name}\` is not in the graph`,
            }[result.reason];
            vscode.window.showWarningMessage(`${what}. ${describeIndex(index)}`);
            return null;
        }
    }
}

/** Which file the graph came from and how old it is, for messages. */
function describeIndex(index: CallGraphIndex): string {
    const { indexPath, extractedAt, sourceCommit } = index.metadata;
    const parts = [`Graph: ${path.basename(indexPath)}`];
    if (extractedAt) {
        parts.push(`extracted ${formatTimestamp(extractedAt)}`);
    }
    if (sourceCommit) {
        parts.push(`at ${sourceCommit.slice(0, 7)}`);
    }
    return parts.join(', ') + '.';
}

/**
 * Regenerate the call graph index
 */
async function regenerateIndex(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open');
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
    
    // Run the pipeline
    await runPipeline();
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
