/**
 * WebviewLoader - Load the scip-callgraph web app in a VS Code webview
 * 
 * This module handles:
 * - Creating webview panels with the embedded web app
 * - Sending graph data to the webview
 * - Handling navigation messages from the webview
 * - Managing webview lifecycle
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CallGraphIndex, D3Node } from './indexLoader';

/**
 * Options for showing the call graph
 */
export interface ShowGraphOptions {
    /** Initial source query (function to show callees for) */
    sourceQuery?: string;
    
    /** Initial sink query (function to show callers for) */
    sinkQuery?: string;
    
    /** Initial depth limit */
    depth?: number;
}

/**
 * Active webview panel (singleton for now)
 */
let activePanel: vscode.WebviewPanel | null = null;

/**
 * Show the call graph webview with the given index and options
 */
export function showCallGraphWebview(
    context: vscode.ExtensionContext,
    index: CallGraphIndex,
    options: ShowGraphOptions = {}
): vscode.WebviewPanel {
    // Reuse existing panel if available
    if (activePanel) {
        activePanel.reveal();
        sendGraphToWebview(activePanel, index, options);
        return activePanel;
    }
    
    // Create new panel
    const panel = vscode.window.createWebviewPanel(
        'callGraphExplorer',
        'Call Graph Explorer',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'webview')
            ]
        }
    );
    
    activePanel = panel;
    
    // Load the HTML content
    panel.webview.html = getWebviewContent(context, panel.webview);
    
    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
        async (message) => {
            switch (message.type) {
                case 'ready':
                    // Webview is ready, send the graph data
                    sendGraphToWebview(panel, index, options);
                    break;
                    
                case 'navigate':
                    // User clicked on a node, navigate to the file
                    await navigateToFile(message);
                    break;
                    
                case 'requestRefresh':
                    // User requested a refresh, trigger index regeneration
                    vscode.commands.executeCommand('callGraph.regenerateIndex');
                    break;
            }
        },
        undefined,
        context.subscriptions
    );
    
    // Handle panel disposal
    panel.onDidDispose(() => {
        activePanel = null;
    }, null, context.subscriptions);
    
    return panel;
}

/**
 * Send graph data to the webview
 */
function sendGraphToWebview(
    panel: vscode.WebviewPanel,
    index: CallGraphIndex,
    options: ShowGraphOptions
): void {
    // Convert the index to D3Graph format expected by the web app
    // The web app expects { nodes: D3Node[], links: D3Link[], metadata: {...} }
    const nodes = Array.from(index.nodesById.values());
    const graphData = {
        nodes,
        links: index.links,
        metadata: {
            total_nodes: index.metadata.totalNodes,
            total_edges: index.metadata.totalEdges,
            project_root: index.metadata.projectRoot,
            generated_at: index.metadata.generatedAt.toISOString()
        }
    };
    
    panel.webview.postMessage({
        type: 'loadGraph',
        graph: graphData,
        initialQuery: {
            source: options.sourceQuery || '',
            sink: options.sinkQuery || '',
            depth: options.depth ?? 3
        }
    });
}

/**
 * Navigate to a file location in VS Code
 */
async function navigateToFile(message: {
    relativePath: string;
    startLine?: number;
    endLine?: number;
    displayName: string;
}): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || !message.relativePath) {
        return;
    }
    
    try {
        const filePath = vscode.Uri.joinPath(workspaceFolders[0].uri, message.relativePath);
        const doc = await vscode.workspace.openTextDocument(filePath);
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        
        // Move cursor to the function
        if (message.startLine) {
            const position = new vscode.Position(message.startLine - 1, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(
                new vscode.Range(position, position),
                vscode.TextEditorRevealType.InCenter
            );
        }
    } catch (error) {
        console.error('Failed to navigate to file:', error);
        vscode.window.showErrorMessage(`Could not open file: ${message.relativePath}`);
    }
}

/**
 * Get the HTML content for the webview
 */
function getWebviewContent(
    context: vscode.ExtensionContext,
    webview: vscode.Webview
): string {
    const webviewPath = vscode.Uri.joinPath(context.extensionUri, 'webview');
    
    // Read the index.html file
    const htmlPath = path.join(webviewPath.fsPath, 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    
    // Get URIs for assets
    const cssUri = webview.asWebviewUri(
        vscode.Uri.joinPath(webviewPath, 'assets', 'main.css')
    );
    const jsUri = webview.asWebviewUri(
        vscode.Uri.joinPath(webviewPath, 'assets', 'main.js')
    );
    
    // Replace asset paths with webview URIs
    // The built HTML has relative paths like "./assets/main.css"
    html = html.replace(
        /\.\/assets\/main\.css/g,
        cssUri.toString()
    );
    html = html.replace(
        /\.\/assets\/main\.js/g,
        jsUri.toString()
    );
    
    // Add Content Security Policy
    const nonce = getNonce();
    const csp = `
        default-src 'none';
        style-src ${webview.cspSource} 'unsafe-inline';
        script-src 'nonce-${nonce}';
        font-src ${webview.cspSource};
        img-src ${webview.cspSource} data:;
    `;
    
    // Insert CSP meta tag
    html = html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`
    );
    
    // Add nonce to script tags
    html = html.replace(
        /<script/g,
        `<script nonce="${nonce}"`
    );
    
    return html;
}

/**
 * Generate a random nonce for CSP
 */
function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

/**
 * Update the current webview with a new query
 */
export function updateWebviewQuery(sourceQuery?: string, sinkQuery?: string): void {
    if (activePanel) {
        activePanel.webview.postMessage({
            type: 'setQuery',
            source: sourceQuery,
            sink: sinkQuery
        });
    }
}

/**
 * Check if a webview is currently active
 */
export function hasActiveWebview(): boolean {
    return activePanel !== null;
}

/**
 * Get function name at cursor position
 * This is a simplified heuristic - could be improved with LSP
 */
export function getFunctionNameAtCursor(editor: vscode.TextEditor): string | null {
    const document = editor.document;
    const position = editor.selection.active;
    const line = document.lineAt(position.line).text;
    
    // Look for fn keyword on current line or nearby lines
    const fnPatterns = [
        /fn\s+(\w+)\s*[<(]/,           // fn name( or fn name<
        /pub\s+fn\s+(\w+)\s*[<(]/,     // pub fn name(
        /pub\s*\(\s*crate\s*\)\s*fn\s+(\w+)\s*[<(]/,  // pub(crate) fn name(
        /pub\s+spec\s+fn\s+(\w+)\s*[<(]/,   // pub spec fn (Verus)
        /pub\s+proof\s+fn\s+(\w+)\s*[<(]/,  // pub proof fn (Verus)
        /spec\s+fn\s+(\w+)\s*[<(]/,         // spec fn (Verus)
        /proof\s+fn\s+(\w+)\s*[<(]/,        // proof fn (Verus)
    ];
    
    // Check current line
    for (const pattern of fnPatterns) {
        const match = line.match(pattern);
        if (match) {
            return match[1];
        }
    }
    
    // Check a few lines above (function signature might be on previous lines)
    for (let i = 1; i <= 5 && position.line - i >= 0; i++) {
        const prevLine = document.lineAt(position.line - i).text;
        for (const pattern of fnPatterns) {
            const match = prevLine.match(pattern);
            if (match) {
                return match[1];
            }
        }
    }
    
    // Try to get word at cursor position
    const wordRange = document.getWordRangeAtPosition(position);
    if (wordRange) {
        return document.getText(wordRange);
    }
    
    return null;
}

