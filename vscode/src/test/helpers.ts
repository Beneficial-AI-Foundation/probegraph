// Shared by the workspace suites, which run in real VS Code against copies of
// the fixtures (see .vscode-test.mjs).
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CallGraphApi } from '../extension';
import type { HostMessage, WebviewMessage } from '../webviewLoader';

export const EXTENSION_ID = 'beneficial-ai-foundation.call-graph-visualizer';

export function folderAt(indexOrName: number | string): vscode.WorkspaceFolder {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = typeof indexOrName === 'number'
        ? folders[indexOrName]
        : folders.find(f => f.name === indexOrName);
    assert.ok(folder, `no workspace folder ${indexOrName}`);
    return folder;
}

export async function openFile(folder: vscode.WorkspaceFolder, ...segments: string[]): Promise<vscode.TextEditor> {
    const uri = vscode.Uri.file(path.join(folder.uri.fsPath, ...segments));
    return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), vscode.ViewColumn.One);
}

export function placeCursor(editor: vscode.TextEditor, line: number, character = 4): void {
    const position = new vscode.Position(line - 1, character);
    editor.selection = new vscode.Selection(position, position);
}

export async function waitFor<T>(what: string, poll: () => T | undefined, timeoutMs = 15000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = poll();
        if (value !== undefined) {
            return value;
        }
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((r) => setTimeout(r, 100));
    }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The extension's API once it has activated (opening a file in a supported language activates it). */
export async function activated(): Promise<CallGraphApi> {
    const ext = vscode.extensions.getExtension<CallGraphApi>(EXTENSION_ID);
    assert.ok(ext, `${EXTENSION_ID} not installed`);
    return waitFor('activation', () => (ext.isActive ? ext.exports : undefined));
}

/** Everything that crosses between the host and the webview, in order. */
export class Protocol implements vscode.Disposable {
    readonly posted: HostMessage[] = [];
    readonly received: WebviewMessage[] = [];
    private readonly subscriptions: vscode.Disposable[];

    constructor(api: CallGraphApi) {
        this.subscriptions = [
            api.onDidPostMessage((m) => this.posted.push(m)),
            api.onDidReceiveWebviewMessage((m) => this.received.push(m)),
        ];
    }

    /** Messages that carry a selection, in order: `loadGraph` with one, and `selectNode`. */
    get selections(): HostMessage[] {
        return this.posted.filter(m => m.selection);
    }

    get loads(): HostMessage[] {
        return this.posted.filter(m => m.type === 'loadGraph');
    }

    /** The host messages since `mark` */
    since(mark: number): HostMessage[] {
        return this.posted.slice(mark);
    }

    /** Wait for the webview to answer the request with this ID. */
    result(requestId: number, timeoutMs?: number): Promise<WebviewMessage> {
        return waitFor(`selectResult ${requestId}`, () =>
            this.received.find(m => m.type === 'selectResult' && m.requestId === requestId), timeoutMs);
    }

    /** Wait for the webview to confirm a revision. */
    loaded(revision: number): Promise<WebviewMessage> {
        return waitFor(`graphLoaded ${revision}`, () =>
            this.received.find(m => m.type === 'graphLoaded' && m.revision === revision));
    }

    dispose(): void {
        for (const s of this.subscriptions) {
            s.dispose();
        }
    }
}

export function explorerTab(): vscode.Tab | undefined {
    return vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) =>
        t.input instanceof vscode.TabInputWebview && t.label === 'Call Graph Explorer');
}

export async function closeAll(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor('editors to close', () => (explorerTab() ? undefined : true));
}
