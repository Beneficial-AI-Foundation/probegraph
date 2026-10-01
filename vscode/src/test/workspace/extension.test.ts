// Runs in a copy of test-fixtures/quicksort (see .vscode-test.mjs).
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CallGraphApi } from '../../extension';
import { runPipeline } from '../../pipelineRunner';
import {
    EXTENSION_ID, Protocol, activated, closeAll, explorerTab, folderAt, openFile, placeCursor, sleep, waitFor,
} from '../helpers';

// src/lib.rs: quicksort on lines 4-12, partition on 14-26, test_quicksort on 33-37
const IN_QUICKSORT = 5;
const IN_PARTITION = 18;

suite('Extension in a Rust workspace', () => {
    let api: CallGraphApi;
    let protocol: Protocol;
    let originalIndex: string;
    const folder = () => folderAt(0);
    const indexPath = () => path.join(folder().uri.fsPath, '.vscode', 'call_graph_index.json');

    suiteSetup(async () => {
        originalIndex = fs.readFileSync(indexPath(), 'utf8');
        await openFile(folder(), 'src', 'lib.rs');
        api = await activated();
    });

    setup(() => {
        protocol = new Protocol(api);
    });

    teardown(async () => {
        protocol.dispose();
        await closeAll();
    });

    suiteTeardown(() => {
        fs.writeFileSync(indexPath(), originalIndex);
    });

    async function showAt(line: number, command = 'callGraph.showAtCursor'): Promise<vscode.TextEditor> {
        const editor = await openFile(folder(), 'src', 'lib.rs');
        placeCursor(editor, line);
        await vscode.commands.executeCommand(command);
        return editor;
    }

    /** Show a node in a fresh panel and wait until the webview has drawn it. */
    async function showAndSettle(line: number) {
        await showAt(line);
        const load = await waitFor('the graph', () => protocol.loads[0]);
        await protocol.loaded(load.revision);
        const result = await protocol.result(load.requestId!);
        assert.strictEqual(result.status, 'shown');
        return load;
    }

    test('registers every contributed command', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
        const contributed: string[] = ext.packageJSON.contributes.commands.map((c: { command: string }) => c.command);
        const registered = new Set(await vscode.commands.getCommands(true));
        assert.deepStrictEqual(contributed.filter((c) => !registered.has(c)), []);
    });

    test('Show at Cursor opens the explorer beside the editor and selects the function', async () => {
        const editor = await showAt(IN_PARTITION);

        const tab = await waitFor('the Call Graph Explorer tab', explorerTab);
        assert.notStrictEqual(tab.group.viewColumn, editor.viewColumn, 'the panel covers the code');
        assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, editor.document.uri.fsPath,
            'the editor lost focus');

        // ready is posted by the viewer's script, so the bundled viewer loaded
        // under the extension's Content Security Policy
        await waitFor('ready from the webview', () => protocol.received.find(m => m.type === 'ready'));
        const load = await waitFor('the graph', () => protocol.loads[0]);
        assert.match(load.selection!.nodeId, /partition/);
        assert.deepStrictEqual([load.selection!.direction, load.selection!.depth], ['both', 3]);
        const loaded = await protocol.loaded(load.revision);
        assert.strictEqual(loaded.nodes, 6);
        const result = await protocol.result(load.requestId!);
        assert.strictEqual(result.status, 'shown');
    });

    test('a second Show at Cursor sends selectNode, and an equal one nothing', async () => {
        const load = await showAndSettle(IN_PARTITION);

        const mark = protocol.posted.length;
        await showAt(IN_QUICKSORT);
        const next = protocol.since(mark);
        assert.deepStrictEqual(next.map(m => m.type), ['selectNode']);
        assert.strictEqual(next[0].revision, load.revision);
        assert.match(next[0].selection!.nodeId, /quicksort/);
        const result = await protocol.result(next[0].requestId!);
        assert.strictEqual(result.status, 'shown');

        await showAt(IN_QUICKSORT);
        assert.strictEqual(protocol.since(mark).length, 1, 'the same selection was sent again');
    });

    test('rapid selections: only the last one is shown', async () => {
        // Before the webview is ready, both commands run and one graph goes
        // out with one selection
        const editor = await openFile(folder(), 'src', 'lib.rs');
        placeCursor(editor, IN_PARTITION);
        await Promise.all([
            vscode.commands.executeCommand('callGraph.showDependents'),
            vscode.commands.executeCommand('callGraph.showAtCursor'),
        ]);
        const load = await waitFor('the graph', () => protocol.loads[0]);
        await protocol.loaded(load.revision);
        await protocol.result(load.requestId!);
        assert.deepStrictEqual(protocol.selections.length, 1, 'more than one selection was sent');

        // Once loaded, selections go out in order and the last one is answered
        const mark = protocol.posted.length;
        await Promise.all([
            vscode.commands.executeCommand('callGraph.showDependents'),
            vscode.commands.executeCommand('callGraph.showDependencies'),
        ]);
        const next = protocol.since(mark);
        assert.deepStrictEqual(next.map(m => m.type), ['selectNode', 'selectNode']);
        assert.notStrictEqual(next[0].selection!.direction, next[1].selection!.direction);
        const result = await protocol.result(next[1].requestId!);
        assert.strictEqual(result.status, 'shown');
    });

    test('replacing the index during a lookup ends on the new revision with the latest selection', async () => {
        const first = await showAndSettle(IN_PARTITION);

        // The symbol provider rewrites the index and returns only once the
        // extension has read it, so the lookup finishes on the new revision
        const rewritten = JSON.parse(originalIndex);
        rewritten.metadata.generated_at = new Date().toISOString();
        const slow = vscode.languages.registerDocumentSymbolProvider('rust', {
            provideDocumentSymbols: async () => {
                fs.writeFileSync(indexPath(), JSON.stringify(rewritten));
                await waitFor('the rewritten index to be sent', () => protocol.loads[1]);
                return [];
            },
        });
        try {
            await showAt(IN_QUICKSORT);
        } finally {
            slow.dispose();
        }

        const loads = protocol.loads;
        assert.strictEqual(loads.length, 2, 'the rewritten index was not sent');
        assert.ok(loads[1].revision > first.revision);
        const last = protocol.selections[protocol.selections.length - 1];
        assert.strictEqual(last.type, 'selectNode');
        assert.strictEqual(last.revision, loads[1].revision);
        assert.match(last.selection!.nodeId, /quicksort/);
        const result = await protocol.result(last.requestId!);
        assert.strictEqual(result.status, 'shown');
    });

    test('an invalid index file leaves the previous graph loaded', async () => {
        const load = await showAndSettle(IN_PARTITION);

        fs.writeFileSync(indexPath(), '{ "nodes": [ {');
        // Longer than the watcher's poll interval and debounce together
        await sleep(4000);
        assert.strictEqual(protocol.loads.length, 1, 'a graph was sent for the invalid file');

        const mark = protocol.posted.length;
        await showAt(IN_QUICKSORT);
        const next = protocol.since(mark);
        assert.deepStrictEqual(next.map(m => [m.type, m.revision]), [['selectNode', load.revision]]);

        fs.writeFileSync(indexPath(), originalIndex);
        const reload = await waitFor('the restored index', () => protocol.loads[1]);
        assert.ok(reload.revision > load.revision);
        assert.match(reload.selection!.nodeId, /quicksort/, 'the latest selection goes with the new graph');
        await protocol.loaded(reload.revision);
    });

    test('navigate opens only files the graph names, under the project root', async () => {
        await showAndSettle(IN_PARTITION);
        await closeAll();

        await api.deliverWebviewMessage({ type: 'navigate', relativePath: 'src/other.rs', startLine: 1, displayName: 'x' });
        await api.deliverWebviewMessage({ type: 'navigate', relativePath: '../quicksort/src/lib.rs', startLine: 1, displayName: 'x' });
        await sleep(300);
        assert.strictEqual(vscode.window.activeTextEditor, undefined, 'a refused path was opened');

        await api.deliverWebviewMessage({ type: 'navigate', relativePath: 'src/lib.rs', startLine: 14, displayName: 'partition' });
        const editor = await waitFor('the editor', () => vscode.window.activeTextEditor);
        assert.strictEqual(editor.document.uri.fsPath, path.join(folder().uri.fsPath, 'src', 'lib.rs'));
        assert.strictEqual(editor.selection.active.line, 13);
    });

    test('closing and reopening the panel starts from ready', async () => {
        await showAndSettle(IN_PARTITION);
        await vscode.window.tabGroups.close(explorerTab()!);
        await waitFor('the panel to close', () => (explorerTab() ? undefined : true));

        const mark = protocol.posted.length;
        await showAt(IN_QUICKSORT);
        const load = await waitFor('the graph again', () => protocol.since(mark).find(m => m.type === 'loadGraph'));
        assert.deepStrictEqual(protocol.since(mark).filter(m => m.type === 'selectNode'), []);
        assert.match(load.selection!.nodeId, /quicksort/);
        await protocol.loaded(load.revision);
        const result = await protocol.result(load.requestId!);
        assert.strictEqual(result.status, 'shown');
    });

    test('reads a probe extract set as the index and does not guess outside declarations', async () => {
        const root = folder().uri.fsPath;
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
        const config = vscode.workspace.getConfiguration('callGraph');
        await config.update('indexPath', '.verilib/probes/probe-rust-extract.json', vscode.ConfigurationTarget.Workspace);
        try {
            await showAt(1);
            assert.strictEqual(explorerTab(), undefined, 'line 1 is outside every declaration');
            await showAt(IN_QUICKSORT);
            const load = await waitFor('the graph', () => protocol.loads[0]);
            assert.strictEqual(load.selection!.nodeId, 'probe:quicksort');
            assert.strictEqual(protocol.selections.length, 1);
        } finally {
            await config.update('indexPath', undefined, vscode.ConfigurationTarget.Workspace);
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
        let provider = symbolsNaming('partition_renamed');
        try {
            await showAt(IN_PARTITION);
            assert.strictEqual(explorerTab(), undefined, 'a renamed function is not the old one on its lines');

            provider.dispose();
            provider = symbolsNaming('partition');
            await showAt(IN_PARTITION);
            const load = await waitFor('the graph', () => protocol.loads[0]);
            assert.match(load.selection!.nodeId, /partition/);
        } finally {
            provider.dispose();
        }
    });

    test('Regenerate finds the binary under CARGO_TARGET_DIR, writes beside the index and renames over it', async () => {
        const probegraph = fs.mkdtempSync(path.join(os.tmpdir(), 'fake probegraph; '));
        const targetDir = path.join(probegraph, 'custom-target');
        const binary = path.join(targetDir, 'release', 'pipeline');
        const argsFile = path.join(probegraph, 'args.txt');
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        // Records its arguments and writes the current index to the -o path
        fs.writeFileSync(binary,
            `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncat '${indexPath()}' > "$3"\n`,
            { mode: 0o755 });

        const config = vscode.workspace.getConfiguration('callGraph');
        await config.update('defaultScipCallgraphPath', probegraph, vscode.ConfigurationTarget.Workspace);
        const previousTargetDir = process.env.CARGO_TARGET_DIR;
        process.env.CARGO_TARGET_DIR = targetDir;
        const before = fs.readFileSync(indexPath(), 'utf8');
        try {
            await runPipeline(folder());
            const root = folder().uri.fsPath;
            const args = fs.readFileSync(argsFile, 'utf8').split('\n');
            assert.deepStrictEqual(args.slice(0, 2), [root, '-o']);
            assert.strictEqual(path.dirname(args[2]), path.dirname(indexPath()));
            assert.notStrictEqual(args[2], indexPath(), 'the pipeline wrote straight to the index');
            assert.ok(!fs.existsSync(args[2]), 'the temporary file was left behind');
            assert.strictEqual(fs.readFileSync(indexPath(), 'utf8'), before);
        } finally {
            if (previousTargetDir === undefined) {
                delete process.env.CARGO_TARGET_DIR;
            } else {
                process.env.CARGO_TARGET_DIR = previousTargetDir;
            }
            await config.update('defaultScipCallgraphPath', undefined, vscode.ConfigurationTarget.Workspace);
            fs.rmSync(probegraph, { recursive: true, force: true });
        }
    });
});
