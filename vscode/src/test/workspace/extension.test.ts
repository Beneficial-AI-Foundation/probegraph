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

    test('Show Call Graph opens the explorer on the function at the cursor', async () => {
        const messages: string[] = [];
        const selected: (string | null)[] = [];
        const subscription = api.onDidReceiveWebviewMessage((m) => messages.push(m.type));
        const sent = api.onDidSendGraph((m) => selected.push(m.selectedNodeId));
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
            const id = await waitFor('the graph', () => selected[0] ?? undefined);
            assert.match(id, /partition/);
        } finally {
            subscription.dispose();
            sent.dispose();
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });

    test('reads a probe extract set as the index and does not guess outside declarations', async () => {
        const root = workspaceRoot();
        const extract = path.join(root, '.verilib', 'probes', 'probe-rust-extract.json');
        const atom = (name: string, start: number, end: number, dependencies: string[] = []) => ({
            'display-name': name, dependencies, 'code-module': '', 'code-path': 'src/lib.rs',
            'code-text': { 'lines-start': start, 'lines-end': end }, kind: 'exec', language: 'rust',
        });
        fs.mkdirSync(path.dirname(extract), { recursive: true });
        fs.writeFileSync(extract, JSON.stringify({
            schema: 'probe-rust/extract', 'schema-version': '2.0', timestamp: '2026-01-01T00:00:00Z',
            source: { repo: 'https://example.invalid/quicksort.git', commit: 'abc1234', language: 'rust', package: 'quicksort' },
            data: {
                'probe:quicksort': atom('quicksort', 4, 12, ['probe:partition']),
                'probe:partition': atom('partition', 14, 26),
            },
        }));
        const selected: (string | null)[] = [];
        const sent = api.onDidSendGraph((m) => selected.push(m.selectedNodeId));
        const config = vscode.workspace.getConfiguration('callGraph');
        await config.update('indexPath', '.verilib/probes/probe-rust-extract.json', vscode.ConfigurationTarget.Workspace);
        try {
            const editor = await openLibRs();
            const at = async (line: number) => {
                editor.selection = new vscode.Selection(line - 1, 4, line - 1, 4);
                await vscode.commands.executeCommand('callGraph.showGraph');
            };
            await at(1);
            await at(5);
            assert.deepStrictEqual(await waitFor('the graph', () => selected[0] ?? undefined), 'probe:quicksort');
            assert.strictEqual(selected.length, 1, 'line 1 is outside every declaration');
        } finally {
            sent.dispose();
            await config.update('indexPath', undefined, vscode.ConfigurationTarget.Workspace);
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });

    test('checks the enclosing symbol from the language server against the graph', async () => {
        const lines = (start: number, end: number) => new vscode.Range(start - 1, 0, end - 1, 1);
        // VS Code caches symbols per document version, so each name gets its own provider
        const symbolsNaming = (functionName: string) => vscode.languages.registerDocumentSymbolProvider('rust', {
            provideDocumentSymbols: () => {
                const fn = new vscode.DocumentSymbol(functionName, '', vscode.SymbolKind.Function, lines(14, 26), lines(14, 14));
                fn.children = [new vscode.DocumentSymbol('pivot', '', vscode.SymbolKind.Variable, lines(18, 18), lines(18, 18))];
                return [fn];
            },
        });
        const selected: (string | null)[] = [];
        const sent = api.onDidSendGraph((m) => selected.push(m.selectedNodeId));
        let provider = symbolsNaming('partition_renamed');
        try {
            const editor = await openLibRs();
            editor.selection = new vscode.Selection(17, 8, 17, 8);
            await vscode.commands.executeCommand('callGraph.showGraph');
            assert.deepStrictEqual(selected, [], 'a renamed function is not the old one on its lines');

            provider.dispose();
            provider = symbolsNaming('partition');
            await vscode.commands.executeCommand('callGraph.showGraph');
            assert.match(await waitFor('the graph', () => selected[0] ?? undefined), /partition/);
        } finally {
            provider.dispose();
            sent.dispose();
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
