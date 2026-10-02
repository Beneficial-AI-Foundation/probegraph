// Runs in two-folders.code-workspace (see .vscode-test.mjs): two copies of the
// quicksort fixture, so every relative path exists in both folders.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CallGraphApi } from '../../extension';
import { Protocol, activated, closeAll, folderAt, openFile, placeCursor, sleep, waitFor } from '../helpers';

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
        await api.deliverWebviewMessage({
            type: 'navigate', revision: load.revision, relativePath: 'src/lib.rs', startLine: 4, displayName: 'quicksort',
        });
        const opened = await waitFor('navigation', () => {
            const active = vscode.window.activeTextEditor;
            return active?.selection.active.line === 3 ? active : undefined;
        });
        assert.strictEqual(opened.document.uri.fsPath, path.join(first.uri.fsPath, 'src', 'lib.rs'));
    });

    test('Regenerate does not take the project type from an editor in another folder', async () => {
        const first = folderAt('first');
        const second = folderAt('second');

        // A session for "first" without a graph: its index is pointed at a missing file
        const editor = await openFile(first, 'src', 'lib.rs');
        placeCursor(editor, 18);
        await vscode.commands.executeCommand('callGraph.showAtCursor');
        await waitFor('the graph', () => protocol.loads[0]);
        const firstConfig = vscode.workspace.getConfiguration('callGraph', first);
        await firstConfig.update('indexPath', '.vscode/missing.json', vscode.ConfigurationTarget.WorkspaceFolder);
        await sleep(500);

        // A pipeline that leaves a trace if it is ever started
        const probegraph = fs.mkdtempSync(path.join(os.tmpdir(), 'fake probegraph; '));
        const ranFile = path.join(probegraph, 'ran.txt');
        const binary = path.join(probegraph, 'target', 'release', 'pipeline');
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.writeFileSync(binary, `#!/bin/sh\ntouch '${ranFile}'\n`, { mode: 0o755 });
        const config = vscode.workspace.getConfiguration('callGraph');
        await config.update('defaultScipCallgraphPath', probegraph, vscode.ConfigurationTarget.Workspace);
        try {
            // The active editor is a Rust file, but in the other folder: it says
            // nothing about "first", so no pipeline runs and the command returns
            await openFile(second, 'src', 'lib.rs');
            const outcome = await Promise.race([
                vscode.commands.executeCommand('callGraph.regenerateIndex').then(() => 'returned'),
                sleep(5000).then(() => 'still running'),
            ]);
            assert.strictEqual(outcome, 'returned');
            assert.ok(!fs.existsSync(ranFile), 'the pipeline was started for a folder the editor is not in');
        } finally {
            await config.update('defaultScipCallgraphPath', undefined, vscode.ConfigurationTarget.Workspace);
            await firstConfig.update('indexPath', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
            fs.rmSync(probegraph, { recursive: true, force: true });
        }
    });
});
