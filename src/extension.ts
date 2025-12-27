/**
 * Call Graph Visualizer Extension
 * 
 * This extension provides interactive call graph visualization for Verus/Rust projects.
 * It uses pre-computed indices from scip-callgraph for instant O(1) subgraph extraction.
 */

import * as vscode from 'vscode';
import { 
    loadIndex, 
    getIndexInfo, 
    indexExists
} from './indexLoader';
import { 
    showCallGraphWebview,
    getFunctionNameAtCursor,
    ShowGraphOptions
} from './webviewLoader';
import { 
    initializePipelineRunner, 
    runPipeline, 
    cancelPipeline, 
    checkPrerequisites,
    getPipelineStatus
} from './pipelineRunner';

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('Call Graph Visualizer extension is now active!');
    
    // Initialize the pipeline runner
    initializePipelineRunner(context);
    
    // Register commands
    registerCommands(context);
    
    // Preload index if available
    preloadIndex();
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
        try {
            const info = getIndexInfo(workspaceRoot);
            console.log(`[Extension] Index found: ${info.path}`);
            
            // Load in background
            loadIndex(workspaceRoot).then(() => {
                console.log('[Extension] Index preloaded successfully');
            }).catch((error) => {
                console.warn('[Extension] Failed to preload index:', error.message);
            });
        } catch (error) {
            console.warn('[Extension] Error checking index:', error);
        }
    } else {
        console.log('[Extension] No index found, user will need to generate one');
    }
}

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
    
    // Check if it's a Rust file
    if (editor.document.languageId !== 'rust') {
        vscode.window.showErrorMessage('This command only works with Rust files');
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
            
            // Find the function at cursor
            progress.report({ message: 'Finding function...' });
            const functionName = getFunctionNameAtCursor(editor);
            
            // Prepare options based on direction
            const config = vscode.workspace.getConfiguration('callGraph');
            const depth = config.get<number>('depth', 3);
            
            const options: ShowGraphOptions = {
                depth
            };
            
            if (functionName) {
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
                    vscode.Uri.parse('https://github.com/Beneficial-AI-Foundation/scip-callgraph')
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
