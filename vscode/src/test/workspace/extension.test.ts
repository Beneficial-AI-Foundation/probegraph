// Runs in a copy of test-fixtures/quicksort (see .vscode-test.mjs).
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CallGraphApi } from '../../extension';
import { runPipeline } from '../../pipelineRunner';

const EXTENSION_ID = 'beneficial-ai-foundation.call-graph-visualizer';

function workspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'no workspace folder');
    return folder.uri.fsPath;
}

async function openLibRs(): Promise<vscode.TextEditor> {
    const uri = vscode.Uri.file(path.join(workspaceRoot(), 'src', 'lib.rs'));
    return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
}

async function waitFor<T>(what: string, poll: () => T | undefined, timeoutMs = 15000): Promise<T> {
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

suite('Extension in a Rust workspace', () => {
    let api: CallGraphApi;

    suiteSetup(async () => {
        await openLibRs();
        const ext = vscode.extensions.getExtension<CallGraphApi>(EXTENSION_ID);
        assert.ok(ext, `${EXTENSION_ID} not installed`);
        api = await waitFor('activation on a Rust file', () => (ext.isActive ? ext.exports : undefined));
    });

    test('registers every contributed command', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
        const contributed: string[] = ext.packageJSON.contributes.commands.map((c: { command: string }) => c.command);
        const registered = new Set(await vscode.commands.getCommands(true));
        assert.deepStrictEqual(contributed.filter((c) => !registered.has(c)), []);
    });

    test('Show Call Graph opens the explorer and the viewer starts in it', async () => {
        const messages: string[] = [];
        const subscription = api.onDidReceiveWebviewMessage((m) => messages.push(m.type));
        try {
            const editor = await openLibRs();
            // Inside partition (lines 14-26)
            const inPartition = new vscode.Position(17, 8);
            editor.selection = new vscode.Selection(inPartition, inPartition);

            await vscode.commands.executeCommand('callGraph.showGraph');

            await waitFor('the Call Graph Explorer tab', () =>
                vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) =>
                    t.input instanceof vscode.TabInputWebview && t.label === 'Call Graph Explorer'));
            // ready is posted by the viewer's script, so the bundled viewer loaded
            // under the extension's Content Security Policy
            await waitFor('ready from the webview', () => (messages.includes('ready') ? true : undefined));
        } finally {
            subscription.dispose();
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });

    test('Regenerate passes paths with spaces and shell characters to the pipeline unchanged', async () => {
        const probegraph = fs.mkdtempSync(path.join(os.tmpdir(), 'fake probegraph; '));
        const binary = path.join(probegraph, 'target', 'release', 'pipeline');
        const argsFile = path.join(probegraph, 'args.txt');
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\n`, { mode: 0o755 });

        const config = vscode.workspace.getConfiguration('callGraph');
        await config.update('defaultScipCallgraphPath', probegraph, vscode.ConfigurationTarget.Workspace);
        try {
            await runPipeline();
            const root = workspaceRoot();
            const args = fs.readFileSync(argsFile, 'utf8').split('\n');
            assert.deepStrictEqual(args.slice(0, 3), [
                root, '-o', path.join(root, '.vscode', 'call_graph_index.json'),
            ]);
        } finally {
            await config.update('defaultScipCallgraphPath', undefined, vscode.ConfigurationTarget.Workspace);
            fs.rmSync(probegraph, { recursive: true, force: true });
        }
    });
});
