// Runs in a copy of test-fixtures/lean-ws (see .vscode-test.mjs): the Lake
// project is in demo/, the extract in demo/.verilib/probes/, and the graph's
// paths are relative to demo/.
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { CallGraphApi } from '../../extension';
import { Protocol, activated, closeAll, explorerTab, folderAt, openFile, placeCursor, waitFor } from '../helpers';

// demo/Demo/Basic.lean: succ on lines 4-5, succ_pos on 7-8, twice on 10
const IN_SUCC_POS = 8;

suite('Extension in a Lean workspace', () => {
    let api: CallGraphApi;
    let protocol: Protocol;
    const folder = () => folderAt(0);
    const openBasic = () => openFile(folder(), 'demo', 'Demo', 'Basic.lean');

    suiteSetup(async () => {
        await openBasic();
        api = await activated();
    });

    setup(() => {
        protocol = new Protocol(api);
    });

    teardown(async () => {
        protocol.dispose();
        await closeAll();
    });

    async function showAt(line: number): Promise<vscode.TextEditor> {
        const editor = await openBasic();
        placeCursor(editor, line);
        await vscode.commands.executeCommand('callGraph.showAtCursor');
        return editor;
    }

    test('resolves the cursor by line against the Lake root, without a symbol provider', async () => {
        const editor = await showAt(IN_SUCC_POS);
        assert.strictEqual(editor.document.languageId, 'lean4');

        const load = await waitFor('the graph', () => protocol.loads[0]);
        assert.strictEqual(load.selection!.nodeId, 'probe:Demo.succ_pos');
        const loaded = await protocol.loaded(load.revision);
        assert.strictEqual(loaded.nodes, 3);
        const result = await protocol.result(load.requestId!);
        assert.strictEqual(result.status, 'shown');
    });

    test('checks the Lean server\'s symbol, with its namespace, against the graph', async () => {
        const lines = (start: number, end: number) => new vscode.Range(start - 1, 0, end - 1, 1);
        // The Lean server reports dotted names inside a namespace symbol; VS Code
        // caches symbols per document version, so each name gets its own provider
        const symbolsNaming = (name: string) => vscode.languages.registerDocumentSymbolProvider('lean4', {
            provideDocumentSymbols: () => {
                const ns = new vscode.DocumentSymbol('Demo', '', vscode.SymbolKind.Namespace, lines(1, 12), lines(1, 1));
                ns.children = [
                    new vscode.DocumentSymbol('Demo.succ', '', vscode.SymbolKind.Function, lines(4, 5), lines(4, 4)),
                    new vscode.DocumentSymbol(name, '', vscode.SymbolKind.Function, lines(7, 8), lines(7, 7)),
                    new vscode.DocumentSymbol('Demo.twice', '', vscode.SymbolKind.Function, lines(10, 10), lines(10, 10)),
                ];
                return [ns];
            },
        });
        let provider = symbolsNaming('Demo.succ_pos_renamed');
        try {
            await showAt(IN_SUCC_POS);
            assert.strictEqual(explorerTab(), undefined, 'a renamed theorem is not the old one on its lines');

            provider.dispose();
            provider = symbolsNaming('Demo.succ_pos');
            await showAt(IN_SUCC_POS);
            const load = await waitFor('the graph', () => protocol.loads[0]);
            assert.strictEqual(load.selection!.nodeId, 'probe:Demo.succ_pos');
        } finally {
            provider.dispose();
        }
    });
});
