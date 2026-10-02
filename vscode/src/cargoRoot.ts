/**
 * Which directory a probe-verus extract's paths are relative to.
 *
 * probe-verus runs on a Cargo package, not on whatever directory it is
 * given: handed a workspace root, it moves to the single member, or to the
 * member `--package` names, and writes paths relative to that
 * (`resolve_workspace_root` in probe-verus). The extract itself does not
 * record the directory, so this mirrors the rule from `Cargo.toml` alone.
 * Only the shapes probe-verus handles are read here: literal member paths
 * (it does not expand globs either) and a `name = "…"` under `[package]`.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * The directory probe-verus would write paths relative to when run on `dir`,
 * with `--package <pkg>` when `pkg` is given: `dir` itself when its
 * `Cargo.toml` has a `[package]` (or is missing or unreadable); the one
 * member of a workspace; the member whose package is `pkg`. When the rule
 * cannot decide, `dir`.
 */
export function cargoPackageRoot(dir: string, pkg?: string): string {
    const manifest = readManifest(path.join(dir, 'Cargo.toml'));
    if (!manifest || manifest.hasPackage) {
        return dir;
    }
    const members = manifest.members.map(m => path.join(dir, m));
    if (pkg) {
        const named = members.find(m => readManifest(path.join(m, 'Cargo.toml'))?.packageName === pkg);
        if (named) {
            return named;
        }
    }
    if (members.length === 1 && fs.existsSync(members[0])) {
        return members[0];
    }
    return dir;
}

/** The nearest directory with a `Cargo.toml` from `start` up to `top`, both inclusive. */
export function nearestCargoDir(top: string, start: string): string | undefined {
    let dir = start;
    for (;;) {
        if (fs.existsSync(path.join(dir, 'Cargo.toml'))) {
            return dir;
        }
        if (dir === top) {
            return undefined;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
}

interface Manifest {
    hasPackage: boolean;
    packageName?: string;
    members: string[];
}

/** The parts of a `Cargo.toml` the root rule reads. */
export function parseManifest(text: string): Manifest {
    const lines = text.split(/\r?\n/).map(stripComment);
    const manifest: Manifest = { hasPackage: false, members: [] };
    let table = '';
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
        if (header) {
            table = header[1];
            if (table === 'package') {
                manifest.hasPackage = true;
            }
            continue;
        }
        if (table === 'package') {
            const name = /^name\s*=\s*"([^"]*)"/.exec(line);
            if (name) {
                manifest.packageName = name[1];
            }
        } else if (table === 'workspace') {
            const members = /^members\s*=\s*(\[.*)$/.exec(line);
            if (members) {
                // The array may run over several lines
                let array = members[1];
                while (!array.includes(']') && i + 1 < lines.length) {
                    array += lines[++i];
                }
                manifest.members = [...array.matchAll(/"([^"]*)"/g)].map(m => m[1]);
            }
        }
    }
    return manifest;
}

function readManifest(file: string): Manifest | undefined {
    try {
        return parseManifest(fs.readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
}

/** The line without a `#` comment, leaving `#` inside a string alone. */
function stripComment(line: string): string {
    let inString = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"' && line[i - 1] !== '\\') {
            inString = !inString;
        } else if (c === '#' && !inString) {
            return line.slice(0, i);
        }
    }
    return line;
}
