// Runs in two-folders.code-workspace (see .vscode-test.mjs): two copies of the
// quicksort fixture, so every relative path exists in both folders.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CallGraphApi } from '../../extension';
import { Protocol, activated, closeAll, folderAt, openFile, placeCursor, waitFor } from '../helpers';

suite('Extension with two workspace folders', () => {
    let api: CallGraphApi;
    let protocol: Protocol;

    suiteSetup(async () => {
        await openFile(folderAt('first'), 'src', 'lib.rs');
        api = await activated();
    });

    setup(() => {
        protocol = new Protocol(api);
    });

    teardown(async () => {
        protocol.dispose();
        await closeAll();
    });

    test('navigation opens the session folder\'s file, not the active folder\'s', async () => {
        const first = folderAt('first');
        const second = folderAt('second');

        const editor = await openFile(first, 'src', 'lib.rs');
        placeCursor(editor, 18);
        await vscode.commands.executeCommand('callGraph.showAtCursor');
        const load = await waitFor('the graph', () => protocol.loads[0]);
        assert.match(load.selection!.nodeId, /partition/);

        // The same relative path exists in the second folder, which is now active
        await openFile(second, 'src', 'lib.rs');
        await api.deliverWebviewMessage({ type: 'navigate', relativePath: 'src/lib.rs', startLine: 4, displayName: 'quicksort' });
        const opened = await waitFor('navigation', () => {
            const active = vscode.window.activeTextEditor;
            return active?.selection.active.line === 3 ? active : undefined;
        });
        assert.strictEqual(opened.document.uri.fsPath, path.join(first.uri.fsPath, 'src', 'lib.rs'));
    });
});
