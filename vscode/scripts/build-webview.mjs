// Builds the probegraph viewer for webview embedding and copies it to webview/.
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, '..', 'web');

execFileSync('npm', ['run', 'build:vscode'], { cwd: web, stdio: 'inherit' });
rmSync(join(root, 'webview'), { recursive: true, force: true });
cpSync(join(web, 'dist-vscode'), join(root, 'webview'), { recursive: true });
