/**
 * WebviewLoader - The probegraph viewer in a VS Code webview panel
 *
 * The host side of the protocol in docs/guides/vscode-extension.md ("Editor
 * selections"): every graph goes out with a revision, selections wait for
 * the webview to confirm the graph, and replies for superseded requests are
 * dropped.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { isInside } from './indexLoader';
import type { GraphRevision } from './session';

export type Direction = 'both' | 'callees' | 'callers' | 'none';

export interface Selection {
    nodeId: string;
    direction: Direction;
    /** Always finite */
    depth: number;
}

export type SelectStatus = 'shown' | 'filtered' | 'missing';

export interface SelectResult {
    selection: Selection;
    status: SelectStatus;
    /** `FilterOptions` keys that each, relaxed alone, would show the node */
    filteredBy: string[];
}

/** What the webview posts (the fields the host reads). */
export interface WebviewMessage {
    type: string;
    revision?: number;
    requestId?: number;
    nodes?: number;
    status?: SelectStatus;
    filteredBy?: string[];
    relativePath?: string;
    startLine?: number;
    endLine?: number;
    displayName?: string;
}

/** What the host posts. */
export interface HostMessage {
    type: 'loadGraph' | 'selectNode' | 'relaxFilters';
    revision: number;
    graph?: unknown;
    selection?: Selection;
    requestId?: number;
    keys?: string[];
}

const NO_GRAPH = 'No call graph is loaded. Use "Call Graph: Show at Cursor" in a file of the project.';

export class GraphPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | null = null;
    /** Subscriptions on the current panel, dropped with it */
    private panelDisposables: vscode.Disposable[] = [];
    /** The webview has posted `ready` for this panel */
    private ready = false;
    /** Revision of the last `loadGraph` sent, confirmed or not */
    private sentRevision: number | null = null;
    /** Revision the webview confirmed with `graphLoaded` */
    private loadedRevision: number | null = null;
    /** The one selection waiting for `graphLoaded` */
    private pending: { selection: Selection; requestId: number } | null = null;
    /** The selection the latest request carried, reported with its result */
    private lastSent: Selection | null = null;
    /** The latest selection the user asked for, sent to a fresh webview */
    private lastSelection: Selection | null = null;
    private requestIds = 0;
    /** Column of the most recent text editor, for `navigate` */
    private editorColumn: vscode.ViewColumn | undefined;

    private readonly received = new vscode.EventEmitter<WebviewMessage>();
    /** Every message the webview posts */
    readonly onDidReceiveMessage = this.received.event;
    private readonly posted = new vscode.EventEmitter<HostMessage>();
    /** Every message sent to the webview */
    readonly onDidPostMessage = this.posted.event;
    private readonly selectResults = new vscode.EventEmitter<SelectResult>();
    /** The webview's answer to the latest selection */
    readonly onDidSelect = this.selectResults.event;

    private readonly disposables: vscode.Disposable[] = [];

    /**
     * @param source the session's current graph, read whenever something is
     *   sent, never captured
     */
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly source: () => GraphRevision | null,
    ) {
        this.editorColumn = vscode.window.activeTextEditor?.viewColumn;
        this.disposables.push(
            this.received, this.posted, this.selectResults,
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (editor?.viewColumn !== undefined) {
                    this.editorColumn = editor.viewColumn;
                }
            }),
        );
    }

    /**
     * Show a selection in the panel, opening the panel beside the editor if
     * needed, on the source's current graph. A selection equal to the last
     * one is sent again: the viewer may have moved away from it on its own
     * (the node hidden, the depth changed, a filter ticked off).
     */
    show(selection: Selection): void {
        this.lastSelection = selection;
        const panel = this.panel ?? this.createPanel();
        panel.reveal(undefined, true);
        if (!this.ready) {
            return; // `ready` sends the graph and this selection
        }
        const graph = this.source();
        if (!graph) {
            vscode.window.showWarningMessage(NO_GRAPH);
            return;
        }
        if (this.loadedRevision !== graph.revision) {
            if (this.sentRevision !== graph.revision) {
                this.sendLoad(graph, selection);
            } else {
                // The graph is on its way; this selection replaces any earlier one
                this.pending = { selection, requestId: ++this.requestIds };
            }
            return;
        }
        this.sendSelect(graph.revision, selection, ++this.requestIds);
    }

    /** The source has a new graph: resend it with the latest selection. */
    graphChanged(): void {
        if (!this.panel || !this.ready) {
            return;
        }
        const graph = this.source();
        if (graph && this.sentRevision !== graph.revision) {
            this.sendLoad(graph, this.lastSelection ?? undefined);
        }
    }

    /** Turn off the filters that hid the last selection. */
    relaxFilters(keys: string[]): void {
        if (this.panel && this.loadedRevision !== null) {
            this.post({ type: 'relaxFilters', revision: this.loadedRevision, keys });
        }
    }

    /** Handle a message as if the webview had posted it (the tests use this). */
    async deliver(message: WebviewMessage): Promise<void> {
        this.received.fire(message);
        switch (message.type) {
            case 'ready': {
                this.ready = true;
                const graph = this.source();
                if (graph) {
                    this.sendLoad(graph, this.lastSelection ?? undefined);
                }
                break;
            }
            case 'graphLoaded':
                if (message.revision === this.sentRevision) {
                    this.loadedRevision = message.revision;
                    if (this.pending) {
                        const { selection, requestId } = this.pending;
                        this.pending = null;
                        this.sendSelect(message.revision, selection, requestId);
                    }
                }
                break;
            case 'selectResult':
                if (message.revision === this.loadedRevision && message.requestId === this.requestIds && this.lastSent) {
                    this.selectResults.fire({
                        selection: this.lastSent,
                        status: message.status ?? 'missing',
                        filteredBy: message.filteredBy ?? [],
                    });
                }
                break;
            case 'navigate':
                if (this.isCurrent(message)) {
                    await this.navigate(message);
                }
                break;
            case 'requestRefresh':
                if (this.isCurrent(message)) {
                    await vscode.commands.executeCommand('callGraph.regenerateIndex');
                }
                break;
        }
    }

    /**
     * True when the message is about the source's current graph. A click on
     * a graph the host has already replaced is dropped: its paths would be
     * resolved against the new graph's root.
     */
    private isCurrent(message: WebviewMessage): boolean {
        const graph = this.source();
        if (!graph) {
            vscode.window.showWarningMessage(NO_GRAPH);
            return false;
        }
        return message.revision === graph.revision;
    }

    private createPanel(): vscode.WebviewPanel {
        const panel = vscode.window.createWebviewPanel(
            'callGraphExplorer',
            'Call Graph Explorer',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'webview')],
            }
        );
        this.panel = panel;
        panel.webview.html = getWebviewContent(this.context, panel.webview);
        panel.webview.onDidReceiveMessage((m) => this.deliver(m), undefined, this.panelDisposables);
        panel.onDidDispose(() => {
            // A new panel starts from `ready`; nothing from this one carries over
            for (const d of this.panelDisposables.splice(0)) {
                d.dispose();
            }
            this.panel = null;
            this.ready = false;
            this.sentRevision = null;
            this.loadedRevision = null;
            this.pending = null;
            this.lastSent = null;
        }, null, this.panelDisposables);
        return panel;
    }

    private sendLoad(graph: GraphRevision, selection?: Selection): void {
        this.sentRevision = graph.revision;
        this.loadedRevision = null;
        this.pending = null;
        this.lastSent = selection ?? null;
        const requestId = selection ? ++this.requestIds : undefined;
        this.post({ type: 'loadGraph', revision: graph.revision, graph: graph.index.graph, selection, requestId });
    }

    private sendSelect(revision: number, selection: Selection, requestId: number): void {
        this.lastSent = selection;
        this.post({ type: 'selectNode', revision, requestId, selection });
    }

    private post(message: HostMessage): void {
        this.panel?.webview.postMessage(message);
        this.posted.fire(message);
    }

    /**
     * Open a node's file. The path must be one the graph names and resolve
     * under the project root. The containment is lexical (`path.relative`
     * on the joined path): a symlink inside the root may point outside it.
     */
    private async navigate(message: WebviewMessage): Promise<void> {
        const graph = this.source();
        const relativePath = message.relativePath;
        if (!graph || !relativePath) {
            return;
        }
        if (!graph.index.paths.has(relativePath)) {
            vscode.window.showWarningMessage(`The graph has no file ${relativePath}.`);
            return;
        }
        const filePath = path.resolve(graph.projectRoot, ...relativePath.split('/'));
        if (!isInside(graph.projectRoot, filePath)) {
            vscode.window.showWarningMessage(`${relativePath} is outside the project root ${graph.projectRoot}.`);
            return;
        }
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            const editor = await vscode.window.showTextDocument(doc, { viewColumn: this.navigationColumn(), preserveFocus: false });
            if (message.startLine) {
                const position = new vscode.Position(message.startLine - 1, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            }
        } catch (error) {
            console.error('Failed to navigate to file:', error);
            vscode.window.showErrorMessage(`Could not open file: ${relativePath}`);
        }
    }

    /**
     * The group of the most recent text editor, unless the panel is in it;
     * then a new group beside the panel.
     */
    private navigationColumn(): vscode.ViewColumn {
        if (this.editorColumn === undefined || this.editorColumn === this.panel?.viewColumn) {
            return vscode.ViewColumn.Beside;
        }
        return this.editorColumn;
    }

    dispose(): void {
        this.panel?.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
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
