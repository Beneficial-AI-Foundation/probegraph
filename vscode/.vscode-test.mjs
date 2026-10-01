import { defineConfig } from '@vscode/test-cli';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The workspace tests write settings into the workspace, so they run in a copy
// of the fixture, at a path with a space and a shell metacharacter.
const workspace = join(mkdtempSync(join(tmpdir(), 'call graph; ')), 'quicksort');
cpSync('test-fixtures/quicksort', workspace, { recursive: true });

export default defineConfig([
	{
		label: 'unit',
		files: 'out/vscode/src/test/unit/**/*.test.js',
	},
	{
		label: 'workspace',
		files: 'out/vscode/src/test/workspace/**/*.test.js',
		workspaceFolder: workspace,
		launchArgs: ['--disable-extensions'],
	},
]);
