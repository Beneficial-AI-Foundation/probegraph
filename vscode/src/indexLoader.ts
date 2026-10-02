/**
 * IndexLoader - Read the graph file the call graph commands use
 *
 * The file may be any format the probegraph viewer reads (probe extract
 * envelopes, atom dicts, the pipeline's D3 index); it goes through the
 * viewer's own normalization and validation. Which file, and which project
 * root its paths are relative to, follow the rules in
 * docs/plans/editor-graph-navigation.md.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseAndNormalizeGraph, validateGraph } from '../../web/src/graph-loader';
import { buildLocationIndex, LocationIndex } from '../../web/src/editor-lookup';
import type { D3Graph, D3Node } from '../../web/src/types';
import { cargoPackageRoot, nearestCargoDir } from './cargoRoot';

export type { D3Graph, D3Node };

export interface CallGraphIndex {
    graph: D3Graph;
    locations: LocationIndex;
    /** Every path a node names, for checking `navigate` requests */
    paths: Set<string>;
    metadata: {
        indexPath: string;
        loadedAt: Date;
        /** When the extractor ran, if the file says */
        extractedAt?: Date;
        sourceCommit?: string;
    };
}

/**
 * Default index file path relative to workspace
 */
const DEFAULT_INDEX_PATH = '.vscode/call_graph_index.json';

/** True when `child` is `parent` or inside it. */
export function isInside(parent: string, child: string): boolean {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The graph file for a workspace folder: `callGraph.indexPath` read with the
 * folder as the configuration scope, resolved against the folder. Throws
 * when the result is outside the folder (and outside `storageRoot`, where
 * downloads will live).
 */
export function resolveIndexPath(folder: vscode.WorkspaceFolder, storageRoot?: string): string {
    const config = vscode.workspace.getConfiguration('callGraph', folder);
    const configured = config.get<string>('indexPath') || DEFAULT_INDEX_PATH;
    const root = folder.uri.fsPath;
    const indexPath = path.resolve(root, configured);
    if (isInside(root, indexPath) || (storageRoot && isInside(storageRoot, indexPath))) {
        return indexPath;
    }
    throw new Error(
        `callGraph.indexPath resolves to ${indexPath}, outside the workspace folder ${root}. ` +
        `The graph file must be inside the folder.`
    );
}

/**
 * Read, normalize and validate the graph file. Throws if it is missing, not
 * JSON, or not a graph the viewer can show.
 */
export async function readIndex(indexPath: string): Promise<CallGraphIndex> {
    let text: string;
    try {
        text = await fs.promises.readFile(indexPath, 'utf8');
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            const notFound = new Error(
                `Call graph index not found: ${indexPath}\n\n` +
                `Set callGraph.indexPath to a probe extract, or run ` +
                `"Call Graph: Regenerate Index" for a Rust project.`
            );
            (notFound as NodeJS.ErrnoException).code = 'ENOENT';
            throw notFound;
        }
        throw new Error(`Could not read ${indexPath}: ${error.message}`);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error: any) {
        throw new Error(`${indexPath} is not JSON: ${error.message}`);
    }
    const graph = parseAndNormalizeGraph(raw);
    const problems = validateGraph(graph);
    if (problems.length > 0) {
        throw new Error(`${indexPath} is not a graph probegraph can show: ${problems.join('; ')}`);
    }
    const extractedAt = graph.metadata?.extracted_at ? new Date(graph.metadata.extracted_at) : undefined;
    const paths = new Set<string>();
    for (const node of graph.nodes) {
        if (node.relative_path) {
            paths.add(node.relative_path);
        }
    }
    for (const node of graph.blueprintLayer?.nodes ?? []) {
        if (node.blueprint?.sourcePath) {
            paths.add(node.blueprint.sourcePath);
        }
    }
    return {
        graph,
        locations: buildLocationIndex(graph),
        paths,
        metadata: {
            indexPath,
            loadedAt: new Date(),
            extractedAt: extractedAt && !isNaN(extractedAt.getTime()) ? extractedAt : undefined,
            sourceCommit: graph.metadata?.source_commit,
        },
    };
}

const LAKEFILES = ['lakefile.lean', 'lakefile.toml'];

/**
 * The directory the graph's paths are relative to:
 *
 * 1. `callGraph.projectRoot`, relative to the folder, if set.
 * 2. The index's `metadata.project_root` if it is an existing directory
 *    inside the folder (a root from another machine is ignored).
 * 3. For a Lean graph, the Lake root containing the index file's folder, if
 *    there is exactly one between it and the workspace folder. For a Rust
 *    graph, the Cargo package probe-verus would run on from the nearest
 *    directory with a `Cargo.toml` between the index file and the workspace
 *    folder: that directory, or, when it is a workspace root, its one
 *    member or the member whose package the extract names (`cargoRoot.ts`).
 * 4. The workspace folder.
 */
export function resolveProjectRoot(folder: vscode.WorkspaceFolder, indexPath: string, graph: D3Graph): string {
    const root = folder.uri.fsPath;
    const configured = vscode.workspace.getConfiguration('callGraph', folder).get<string>('projectRoot');
    if (configured) {
        return path.resolve(root, configured);
    }

    const declared = graph.metadata?.project_root;
    if (declared) {
        const candidate = path.resolve(root, declared);
        if (isInside(root, candidate) && isDirectory(candidate)) {
            return candidate;
        }
    }

    if (isLeanGraph(graph)) {
        const lakeRoots: string[] = [];
        let dir = path.dirname(indexPath);
        while (isInside(root, dir)) {
            if (LAKEFILES.some(f => fs.existsSync(path.join(dir, f)))) {
                lakeRoots.push(dir);
            }
            const parent = path.dirname(dir);
            if (parent === dir) {
                break;
            }
            dir = parent;
        }
        if (lakeRoots.length === 1) {
            return lakeRoots[0];
        }
    } else if (isRustGraph(graph)) {
        const cargoDir = nearestCargoDir(root, path.dirname(indexPath));
        if (cargoDir) {
            const pkg = graph.metadata?.source_configs?.find(s => s.language === 'rust')?.package;
            return cargoPackageRoot(cargoDir, pkg);
        }
    }

    return root;
}

/** True when the graph has Lean nodes or was extracted from a Lean source. */
export function isLeanGraph(graph: D3Graph): boolean {
    return graph.nodes.some(n => n.language === 'lean')
        || (graph.metadata?.source_configs ?? []).some(s => s.language === 'lean');
}

/** True when the graph has Rust or Verus nodes or was extracted from a Rust source. */
export function isRustGraph(graph: D3Graph): boolean {
    return graph.nodes.some(n => n.language === 'rust' || n.language === 'verus')
        || (graph.metadata?.source_configs ?? []).some(s => s.language === 'rust');
}

function isDirectory(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Format a timestamp for display
 */
export function formatTimestamp(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    let relative: string;
    if (diffMins < 1) {
        relative = 'just now';
    } else if (diffMins < 60) {
        relative = `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
    } else if (diffHours < 24) {
        relative = `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
    } else {
        relative = `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
    }
    
    const formatted = date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
    
    return `${formatted} (${relative})`;
}
