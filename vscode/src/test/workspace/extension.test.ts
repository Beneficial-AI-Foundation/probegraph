// Runs in a copy of test-fixtures/quicksort (see .vscode-test.mjs).
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CallGraphApi } from '../../extension';
// The bundled extension has its own instance of this module; a run started
// here can only be cancelled here
import { cancelGenerator, runGenerator } from '../../generator';
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

    test('a second Show at Cursor sends selectNode, and an equal one is sent again', async () => {
        const load = await showAndSettle(IN_PARTITION);

        const mark = protocol.posted.length;
        await showAt(IN_QUICKSORT);
        const next = protocol.since(mark);
        assert.deepStrictEqual(next.map(m => m.type), ['selectNode']);
        assert.strictEqual(next[0].revision, load.revision);
        assert.match(next[0].selection!.nodeId, /quicksort/);
        const result = await protocol.result(next[0].requestId!);
        assert.strictEqual(result.status, 'shown');

        // The viewer may have moved away from the selection on its own (the
        // node hidden, the depth changed), so the host does not skip it
        await showAt(IN_QUICKSORT);
        const again = protocol.since(mark);
        assert.deepStrictEqual(again.map(m => m.type), ['selectNode', 'selectNode']);
        assert.deepStrictEqual(again[1].selection, again[0].selection);
        assert.strictEqual((await protocol.result(again[1].requestId!)).status, 'shown');
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
        // The selection waits for the webview to confirm the new revision
        const last = await waitFor('the selection on the new revision', () =>
            protocol.selections.find(m => m.type === 'selectNode' && m.revision === loads[1].revision));
        assert.strictEqual(protocol.selections[protocol.selections.length - 1], last);
        assert.match(last.selection!.nodeId, /quicksort/);
        const result = await protocol.result(last.requestId!);
        assert.strictEqual(result.status, 'shown');
    });

    test('one write to the index is read once, though two watchers report it', async () => {
        const first = await showAndSettle(IN_PARTITION);

        const rewritten = JSON.parse(originalIndex);
        rewritten.metadata.generated_at = new Date().toISOString();
        fs.writeFileSync(indexPath(), JSON.stringify(rewritten));
        // Longer than the debounce and the stat poll together
        await sleep(4000);
        assert.deepStrictEqual(protocol.loads.map(l => l.revision > first.revision), [false, true],
            'the write was read more than once');
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

    test('navigate opens only files the graph names, under the project root, for the current revision', async () => {
        const { revision } = await showAndSettle(IN_PARTITION);
        await closeAll();

        const navigate = (relativePath: string, startLine: number, rev = revision) =>
            api.deliverWebviewMessage({ type: 'navigate', revision: rev, relativePath, startLine, displayName: 'x' });
        await navigate('src/other.rs', 1);
        await navigate('../quicksort/src/lib.rs', 1);
        // A click on a graph the host has since replaced
        await navigate('src/lib.rs', 1, revision - 1);
        await sleep(300);
        assert.strictEqual(vscode.window.activeTextEditor, undefined, 'a refused path was opened');

        await navigate('src/lib.rs', 14);
        const editor = await waitFor('the editor', () => vscode.window.activeTextEditor);
        assert.strictEqual(editor.document.uri.fsPath, path.join(folder().uri.fsPath, 'src', 'lib.rs'));
        assert.strictEqual(editor.selection.active.line, 13);
    });

    test('a settings change that does not name the file keeps the graph, so navigate still works', async () => {
        const { revision } = await showAndSettle(IN_PARTITION);
        await closeAll();

        const config = vscode.workspace.getConfiguration('callGraph');
        await config.update('depth', 5, vscode.ConfigurationTarget.Workspace);
        try {
            await sleep(300);
            assert.strictEqual(protocol.loads.length, 1, 'the graph was reloaded for an unrelated setting');
            await api.deliverWebviewMessage({ type: 'navigate', revision, relativePath: 'src/lib.rs', startLine: 14, displayName: 'partition' });
            const editor = await waitFor('the editor', () => vscode.window.activeTextEditor);
            assert.strictEqual(editor.selection.active.line, 13);
        } finally {
            await config.update('depth', undefined, vscode.ConfigurationTarget.Workspace);
        }
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

    /**
     * A probe-verus stand-in at a path with a space and a `;`: records its
     * arguments, and on `extract` copies the current index to the `-o` path
     * (so the test can see the rename) unless `exitCode` says to fail. With
     * `hang`, `extract` instead starts a `sleep` (standing in for `cargo
     * verus`), records its pid in `childPid` and waits for it.
     */
    function fakeProbeVerus(exitCode = 0, hang = false): {
        dir: string; binary: string; childPid: string; args: () => string[];
    } {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake probe-verus; '));
        const binary = path.join(dir, 'probe-verus');
        const argsFile = path.join(dir, 'args.txt');
        const childPid = path.join(dir, 'child.pid');
        const extract = hang
            ? `sleep 60 & echo $! > '${childPid}'; wait`
            : `cat '${indexPath()}' > "$4"; exit ${exitCode}`;
        fs.writeFileSync(binary, [
            '#!/bin/sh',
            `printf '%s\\n' "$@" >> '${argsFile}'`,
            'case "$1" in',
            '  --version) echo "probe-verus 0.0.0-fake" ;;',
            '  setup) printf "Tool  Status  Location\\nverus-analyzer  PATH  /x\\nscip  PATH  /x\\nverus  managed  /x\\n" ;;',
            `  extract) ${extract} ;;`,
            'esac',
            '',
        ].join('\n'), { mode: 0o755 });
        return {
            dir, binary, childPid,
            args: () => fs.readFileSync(argsFile, 'utf8').split('\n'),
        };
    }

    test('Cancel Regenerate stops probe-verus and what it spawned', async function () {
        if (process.platform === 'win32') {
            this.skip();
        }
        const fake = fakeProbeVerus(0, true);
        const config = vscode.workspace.getConfiguration('callGraph');
        await config.update('probeVerusPath', fake.binary, vscode.ConfigurationTarget.Workspace);
        const before = fs.readFileSync(indexPath(), 'utf8');
        try {
            const run = runGenerator(folder());
            await waitFor('the fake to start its child', () => fs.existsSync(fake.childPid) || undefined);
            const pid = Number(fs.readFileSync(fake.childPid, 'utf8').trim());
            assert.ok(pid > 0);
            cancelGenerator();
            await run;
            // A killed process may linger as a zombie until reaped, but is not
            // runnable; `kill -0` on a reaped pid throws ESRCH
            await waitFor('the grandchild to be gone', () => {
                try {
                    process.kill(pid, 0);
                    return undefined;
                } catch {
                    return true;
                }
            });
            assert.ok(!fs.existsSync(fake.args()[3]), 'the temporary file was left behind');
            assert.strictEqual(fs.readFileSync(indexPath(), 'utf8'), before);
        } finally {
            await config.update('probeVerusPath', undefined, vscode.ConfigurationTarget.Workspace);
            fs.rmSync(fake.dir, { recursive: true, force: true });
        }
    });

    test('Regenerate runs probe-verus extract, writes beside the index and renames over it', async () => {
        const fake = fakeProbeVerus();
        const config = vscode.workspace.getConfiguration('callGraph');
        await config.update('probeVerusPath', fake.binary, vscode.ConfigurationTarget.Workspace);
        await config.update('skipVerification', true, vscode.ConfigurationTarget.Workspace);
        const before = fs.readFileSync(indexPath(), 'utf8');
        try {
            await runGenerator(folder());
            const root = folder().uri.fsPath;
            const args = fake.args();
            assert.deepStrictEqual(args.slice(0, 3), ['extract', root, '-o']);
            assert.strictEqual(path.dirname(args[3]), path.dirname(indexPath()));
            assert.notStrictEqual(args[3], indexPath(), 'probe-verus wrote straight to the index');
            assert.ok(!fs.existsSync(args[3]), 'the temporary file was left behind');
            assert.deepStrictEqual(args.slice(4, 5), ['--skip-verify']);
            assert.strictEqual(fs.readFileSync(indexPath(), 'utf8'), before);
        } finally {
            await config.update('probeVerusPath', undefined, vscode.ConfigurationTarget.Workspace);
            await config.update('skipVerification', undefined, vscode.ConfigurationTarget.Workspace);
            fs.rmSync(fake.dir, { recursive: true, force: true });
        }
    });

    test('a failed probe-verus run leaves the index and no temporary file behind', async () => {
        const fake = fakeProbeVerus(3);
        const config = vscode.workspace.getConfiguration('callGraph');
        await config.update('probeVerusPath', fake.binary, vscode.ConfigurationTarget.Workspace);
        const before = fs.readFileSync(indexPath(), 'utf8');
        try {
            await runGenerator(folder());
            const temp = fake.args()[3];
            assert.ok(!fs.existsSync(temp), 'the temporary file was left behind');
            assert.strictEqual(fs.readFileSync(indexPath(), 'utf8'), before);
        } finally {
            await config.update('probeVerusPath', undefined, vscode.ConfigurationTarget.Workspace);
            fs.rmSync(fake.dir, { recursive: true, force: true });
        }
    });

    /**
     * A second crate `sub/` in the workspace folder, and a probe-verus
     * extract of it at `extractRel` (relative to the folder) whose paths are
     * relative to `sub/`, as probe-verus writes them. Returns the cleanup.
     */
    function writeSubCrate(extractRel: string): () => void {
        const root = folder().uri.fsPath;
        const sub = path.join(root, 'sub');
        const extract = path.join(root, extractRel);
        fs.mkdirSync(path.join(sub, 'src'), { recursive: true });
        fs.mkdirSync(path.dirname(extract), { recursive: true });
        fs.writeFileSync(path.join(sub, 'Cargo.toml'), '[package]\nname = "sub"\nversion = "0.1.0"\n');
        fs.writeFileSync(path.join(sub, 'src', 'lib.rs'), 'pub fn alpha() -> u32 {\n    1\n}\n');
        fs.writeFileSync(extract, JSON.stringify({
            schema: 'probe-verus/extract', 'schema-version': '2.0', timestamp: '2026-01-01T00:00:00Z',
            source: { repo: 'https://example.invalid/sub.git', commit: 'abc1234', language: 'rust', package: 'sub' },
            data: {
                'probe:alpha': {
                    'display-name': 'alpha', dependencies: [], 'code-module': '', 'code-path': 'src/lib.rs',
                    'code-text': { 'lines-start': 1, 'lines-end': 3 }, kind: 'exec', language: 'verus',
                },
            },
        }));
        return () => {
            fs.rmSync(sub, { recursive: true, force: true });
            fs.rmSync(extract, { force: true });
        };
    }

    async function expectAlphaInSub(): Promise<void> {
        const editor = await openFile(folder(), 'sub', 'src', 'lib.rs');
        placeCursor(editor, 2);
        await vscode.commands.executeCommand('callGraph.showAtCursor');
        const load = await waitFor('the graph', () => protocol.loads[0]);
        assert.strictEqual(load.selection!.nodeId, 'probe:alpha');
    }

    test('a probe-verus extract inside a Cargo project under the folder resolves paths against that project', async () => {
        // The extract where probe-verus puts it; the folder's own Cargo.toml
        // must not win, since the extract's paths are relative to `sub/`
        const cleanup = writeSubCrate('sub/.verilib/probes/verus_sub_0.1.0.json');
        const config = vscode.workspace.getConfiguration('callGraph');
        await config.update('indexPath', 'sub/.verilib/probes/verus_sub_0.1.0.json', vscode.ConfigurationTarget.Workspace);
        try {
            await expectAlphaInSub();
        } finally {
            await config.update('indexPath', undefined, vscode.ConfigurationTarget.Workspace);
            cleanup();
        }
    });

    test('an extract under a one-member workspace root resolves paths against the member, as probe-verus ran on it', async () => {
        // "Regenerate Index" on a workspace folder that is a Cargo workspace
        // writes the extract under the folder, but probe-verus ran on the
        // member and the paths are relative to it
        const cleanup = writeSubCrate('.vscode/sub-extract.json');
        const manifest = path.join(folder().uri.fsPath, 'Cargo.toml');
        const original = fs.readFileSync(manifest, 'utf8');
        fs.writeFileSync(manifest, '[workspace]\nmembers = [\n    "sub",\n]\n');
        const config = vscode.workspace.getConfiguration('callGraph');
        await config.update('indexPath', '.vscode/sub-extract.json', vscode.ConfigurationTarget.Workspace);
        try {
            await expectAlphaInSub();
        } finally {
            await config.update('indexPath', undefined, vscode.ConfigurationTarget.Workspace);
            fs.writeFileSync(manifest, original);
            cleanup();
        }
    });
});
