/**
 * Which directory a probe-verus extract's paths are relative to.
 *
 * probe-verus runs on a Cargo package, not on whatever directory it is
 * given: handed a workspace root, it moves to the single member, or to the
 * member `--package` names, and writes paths relative to that
 * (`resolve_workspace_root` in probe-verus). The extract itself does not
 * record the directory, so this mirrors the rule from `Cargo.toml` alone.
 * The manifest is parsed as TOML (smol-toml), as probe-verus's `toml` crate
 * does; of it, only `package.name` and `workspace.members` are read, and
 * member paths are taken literally, as probe-verus takes them (it does not
 * expand globs either).
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';

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

/**
 * The parts of a `Cargo.toml` the root rule reads. Throws on text that is
 * not TOML, as probe-verus would fail on it.
 */
export function parseManifest(text: string): Manifest {
    const toml = parseToml(text);
    const pkg = isTable(toml.package) ? toml.package : undefined;
    const workspace = isTable(toml.workspace) ? toml.workspace : undefined;
    const members = Array.isArray(workspace?.members) ? workspace.members : [];
    const manifest: Manifest = {
        hasPackage: pkg !== undefined,
        members: members.filter((m): m is string => typeof m === 'string'),
    };
    if (typeof pkg?.name === 'string') {
        manifest.packageName = pkg.name;
    }
    return manifest;
}

function isTable(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readManifest(file: string): Manifest | undefined {
    try {
        return parseManifest(fs.readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
}
