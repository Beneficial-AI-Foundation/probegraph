/**
 * Session - one workspace folder, one graph file
 *
 * A session reads the graph for its folder, numbers each graph it reads with
 * a revision, watches the file, and keeps the last good graph when a rewrite
 * is invalid. The status bar shows the current session's state.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    CallGraphIndex,
    formatTimestamp,
    readIndex,
    resolveIndexPath,
    resolveProjectRoot,
} from './indexLoader';

export type IndexState = 'none' | 'loading' | 'loaded' | 'invalid';

/** A graph as read at one moment, and the root its paths are relative to. */
export interface GraphRevision {
    revision: number;
    index: CallGraphIndex;
    projectRoot: string;
}

const WATCHER_DEBOUNCE_MS = 500;
/** Stat interval of the fallback for file systems where `fs.watch` fails (inotify limits, network drives) */
const POLL_INTERVAL_MS = 2000;

// Revisions never repeat, even across sessions, so a reply for a graph the
// webview loaded from an earlier session cannot be mistaken for a current one
let lastRevision = 0;

export class GraphSession implements vscode.Disposable {
    readonly folder: vscode.WorkspaceFolder;
    readonly indexPath: string;

    private current: GraphRevision | null = null;
    private state: IndexState = 'none';
    private error: string | null = null;
    private reading: Promise<GraphRevision> | null = null;
    private debounce: NodeJS.Timeout | null = null;
    private readonly disposables: vscode.Disposable[] = [];

    private readonly graphChanged = new vscode.EventEmitter<GraphRevision>();
    /** A new graph replaced the current one (first read included). */
    readonly onDidChangeGraph = this.graphChanged.event;

    private readonly stateChanged = new vscode.EventEmitter<IndexState>();
    readonly onDidChangeState = this.stateChanged.event;

    /** Throws when `callGraph.indexPath` is outside the folder. */
    constructor(folder: vscode.WorkspaceFolder, storageRoot?: string) {
        this.folder = folder;
        this.indexPath = resolveIndexPath(folder, storageRoot);

        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(path.dirname(this.indexPath), path.basename(this.indexPath))
        );
        watcher.onDidChange(() => this.scheduleReload());
        watcher.onDidCreate(() => this.scheduleReload());
        watcher.onDidDelete(() => this.scheduleReload());
        // Both fire for one write; the debounce folds them into one read
        const onStat = (current: fs.Stats, previous: fs.Stats) => {
            if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) {
                this.scheduleReload();
            }
        };
        fs.watchFile(this.indexPath, { interval: POLL_INTERVAL_MS, persistent: false }, onStat);
        this.disposables.push(
            watcher,
            { dispose: () => fs.unwatchFile(this.indexPath, onStat) },
            this.graphChanged,
            this.stateChanged,
        );
    }

    /** The last good graph, or null before the first successful read. */
    get graph(): GraphRevision | null {
        return this.current;
    }

    get indexState(): IndexState {
        return this.state;
    }

    /** Why the last read failed, when `indexState` is `invalid` or `none`. */
    get lastError(): string | null {
        return this.error;
    }

    /** The current graph, reading the file first if it has never been read. */
    load(): Promise<GraphRevision> {
        if (this.current) {
            return Promise.resolve(this.current);
        }
        return this.reload();
    }

    /**
     * Read the file again. A file that is missing or invalid leaves the
     * current graph in place and rejects.
     */
    reload(): Promise<GraphRevision> {
        if (this.reading) {
            return this.reading;
        }
        this.setState('loading');
        this.reading = (async () => {
            try {
                const index = await readIndex(this.indexPath);
                const projectRoot = resolveProjectRoot(this.folder, this.indexPath, index.graph);
                const next = { revision: ++lastRevision, index, projectRoot };
                this.current = next;
                this.error = null;
                this.setState('loaded');
                console.log(`[Session] Revision ${next.revision}: ${index.graph.nodes.length} nodes from ${this.indexPath}`);
                this.graphChanged.fire(next);
                return next;
            } catch (error: any) {
                this.error = error.message;
                this.setState(isNotFound(error) ? 'none' : 'invalid');
                throw error;
            } finally {
                this.reading = null;
            }
        })();
        return this.reading;
    }

    private scheduleReload(): void {
        if (this.debounce) {
            clearTimeout(this.debounce);
        }
        this.debounce = setTimeout(() => {
            this.debounce = null;
            this.reload().catch((error) => {
                console.warn('[Session] Keeping the previous graph:', error.message);
            });
        }, WATCHER_DEBOUNCE_MS);
    }

    private setState(state: IndexState): void {
        this.state = state;
        this.stateChanged.fire(state);
    }

    dispose(): void {
        if (this.debounce) {
            clearTimeout(this.debounce);
        }
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}

function isNotFound(error: any): boolean {
    return error?.code === 'ENOENT';
}

/**
 * The one active session, the status bar for it, and the switch between
 * folders.
 */
export class Sessions implements vscode.Disposable {
    private current: GraphSession | null = null;
    private readonly statusBar: vscode.StatusBarItem;
    private readonly sessionDisposables: vscode.Disposable[] = [];
    private readonly disposables: vscode.Disposable[] = [];

    private readonly graphChanged = new vscode.EventEmitter<GraphRevision>();
    /** The current session read a new graph. */
    readonly onDidChangeGraph = this.graphChanged.event;

    constructor(private readonly storageRoot?: string) {
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
        this.statusBar.command = 'callGraph.showAtCursor';
        this.disposables.push(
            this.statusBar,
            this.graphChanged,
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (this.current && e.affectsConfiguration('callGraph', this.current.folder.uri)) {
                    // A new index path or project root: start over in the same folder
                    this.bind(this.current.folder);
                }
            }),
            vscode.workspace.onDidChangeWorkspaceFolders((e) => {
                if (this.current && e.removed.includes(this.current.folder)) {
                    this.bind(null);
                }
            }),
        );
    }

    get session(): GraphSession | null {
        return this.current;
    }

    /** The current graph, if a session has read one. */
    get graph(): GraphRevision | null {
        return this.current?.graph ?? null;
    }

    /**
     * The session for a folder. With a session bound to another folder, asks
     * before switching; null when the user declines. Throws when the folder's
     * `callGraph.indexPath` is outside it.
     */
    async forFolder(folder: vscode.WorkspaceFolder): Promise<GraphSession | null> {
        if (this.current?.folder.uri.toString() === folder.uri.toString()) {
            return this.current;
        }
        if (this.current) {
            const choice = await vscode.window.showInformationMessage(
                `The call graph is bound to the folder "${this.current.folder.name}". Switch to "${folder.name}"?`,
                'Switch', 'Cancel'
            );
            if (choice !== 'Switch') {
                return null;
            }
        }
        return this.bind(folder);
    }

    /** Bind to a folder (or to none), replacing the current session. */
    bind(folder: vscode.WorkspaceFolder | null): GraphSession | null {
        for (const d of this.sessionDisposables.splice(0)) {
            d.dispose();
        }
        this.current = null;
        if (!folder) {
            this.updateStatusBar();
            return null;
        }
        try {
            const session = new GraphSession(folder, this.storageRoot);
            this.current = session;
            this.sessionDisposables.push(
                session,
                session.onDidChangeGraph((g) => this.graphChanged.fire(g)),
                session.onDidChangeState(() => this.updateStatusBar()),
            );
        } catch (error: any) {
            vscode.window.showErrorMessage(error.message);
        }
        this.updateStatusBar();
        return this.current;
    }

    private updateStatusBar(): void {
        const session = this.current;
        if (!session) {
            this.statusBar.hide();
            return;
        }
        const file = path.basename(session.indexPath);
        switch (session.indexState) {
            case 'none':
                this.statusBar.text = '$(graph) Call Graph: no index';
                this.statusBar.tooltip = session.lastError ?? `No graph file at ${session.indexPath}`;
                this.statusBar.backgroundColor = undefined;
                break;
            case 'loading':
                this.statusBar.text = '$(sync~spin) Call Graph: loading';
                this.statusBar.tooltip = `Reading ${session.indexPath}`;
                this.statusBar.backgroundColor = undefined;
                break;
            case 'invalid':
                this.statusBar.text = '$(warning) Call Graph: invalid index';
                this.statusBar.tooltip = `${session.lastError}\n\nShowing the previous graph.`;
                this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                break;
            case 'loaded': {
                const graph = session.graph!;
                const { extractedAt, sourceCommit } = graph.index.metadata;
                const when = extractedAt ? `extracted ${formatTimestamp(extractedAt)}` : 'extraction time unknown';
                this.statusBar.text = `$(graph) Call Graph: ${graph.index.graph.nodes.length} nodes`;
                this.statusBar.tooltip = [
                    `${file} in ${session.folder.name}`,
                    when,
                    sourceCommit ? `commit ${sourceCommit.slice(0, 7)}` : 'commit unknown',
                    `paths relative to ${graph.projectRoot}`,
                ].join('\n');
                this.statusBar.backgroundColor = undefined;
                break;
            }
        }
        this.statusBar.show();
    }

    dispose(): void {
        this.bind(null);
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
