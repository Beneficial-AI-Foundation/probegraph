import { defineConfig } from '@vscode/test-cli';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The workspace tests write settings and index files into the workspace, so
// they run in copies of the fixtures, at a path with a space and a shell
// metacharacter.
const scratch = mkdtempSync(join(tmpdir(), 'call graph; '));
const quicksort = join(scratch, 'quicksort');
cpSync('test-fixtures/quicksort', quicksort, { recursive: true });
const lean = join(scratch, 'lean-ws');
cpSync('test-fixtures/lean-ws', lean, { recursive: true });

// Two folders with the same relative paths, for the navigation test
const twoFolders = join(scratch, 'two-folders.code-workspace');
cpSync('test-fixtures/quicksort', join(scratch, 'first'), { recursive: true });
cpSync('test-fixtures/quicksort', join(scratch, 'second'), { recursive: true });
writeFileSync(twoFolders, JSON.stringify({ folders: [{ path: 'first' }, { path: 'second' }] }));

// The workspace tests wait for the real webview and for file watchers
const mocha = { timeout: 30000 };

export default defineConfig([
	{
		label: 'unit',
		files: 'out/vscode/src/test/unit/**/*.test.js',
	},
	{
		label: 'workspace',
		files: 'out/vscode/src/test/workspace/**/*.test.js',
		workspaceFolder: quicksort,
		launchArgs: ['--disable-extensions'],
		mocha,
	},
	{
		label: 'lean',
		files: 'out/vscode/src/test/lean/**/*.test.js',
		workspaceFolder: lean,
		launchArgs: ['--disable-extensions'],
		mocha,
	},
	{
		label: 'multiroot',
		files: 'out/vscode/src/test/multiroot/**/*.test.js',
		workspaceFolder: twoFolders,
		launchArgs: ['--disable-extensions'],
		mocha,
	},
]);
