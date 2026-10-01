/**
 * IndexLoader - Load and cache the graph the call graph commands use
 *
 * The file may be any format the probegraph viewer reads (probe extract
 * envelopes, atom dicts, the pipeline's D3 index); it goes through the
 * viewer's own normalization and validation.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseAndNormalizeGraph, validateGraph } from '../../web/src/graph-loader';
import { buildLocationIndex, LocationIndex } from '../../web/src/editor-lookup';
import type { D3Graph, D3Node } from '../../web/src/types';

export type { D3Graph, D3Node };

export interface CallGraphIndex {
    graph: D3Graph;
    locations: LocationIndex;
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

let cachedIndex: CallGraphIndex | null = null;
let indexWatcher: vscode.FileSystemWatcher | null = null;

/**
 * Get the index file path for a workspace
 */
export function getIndexPath(workspaceRoot: string): string {
    const config = vscode.workspace.getConfiguration('callGraph');
    const customPath = config.get<string>('indexPath');
    
    if (customPath) {
        if (path.isAbsolute(customPath)) {
            return customPath;
        }
        return path.join(workspaceRoot, customPath);
    }
    
    return path.join(workspaceRoot, DEFAULT_INDEX_PATH);
}

/**
 * Check if the index file exists
 */
export function indexExists(workspaceRoot: string): boolean {
    const indexPath = getIndexPath(workspaceRoot);
    return fs.existsSync(indexPath);
}

/**
 * Load the index, from the cache unless forceReload. Throws if the file is
 * missing or not a graph.
 */
export async function loadIndex(workspaceRoot: string, forceReload: boolean = false): Promise<CallGraphIndex> {
    const indexPath = getIndexPath(workspaceRoot);
    
    if (cachedIndex && !forceReload && cachedIndex.metadata.indexPath === indexPath) {
        return cachedIndex;
    }
    
    if (!fs.existsSync(indexPath)) {
        throw new Error(
            `Call graph index not found: ${indexPath}\n\n` +
            `Set callGraph.indexPath to a probe extract, or run ` +
            `"Call Graph: Regenerate Index" for a Rust project.`
        );
    }
    
    const index = readIndex(indexPath);
    cachedIndex = index;
    setupFileWatcher(workspaceRoot, indexPath);
    console.log(`[IndexLoader] Loaded ${index.graph.nodes.length} nodes from ${indexPath}`);
    return index;
}

function readIndex(indexPath: string): CallGraphIndex {
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch (error: any) {
        throw new Error(`Could not read ${indexPath}: ${error.message}`);
    }
    const graph = parseAndNormalizeGraph(raw);
    const problems = validateGraph(graph);
    if (problems.length > 0) {
        throw new Error(`${indexPath} is not a graph probegraph can show: ${problems.join('; ')}`);
    }
    const extractedAt = graph.metadata?.extracted_at ? new Date(graph.metadata.extracted_at) : undefined;
    return {
        graph,
        locations: buildLocationIndex(graph),
        metadata: {
            indexPath,
            loadedAt: new Date(),
            extractedAt: extractedAt && !isNaN(extractedAt.getTime()) ? extractedAt : undefined,
            sourceCommit: graph.metadata?.source_commit,
        },
    };
}

/**
 * Reload when the file changes. A rewrite that fails to parse or validate
 * (including one caught half-written) keeps the previous index.
 */
function setupFileWatcher(workspaceRoot: string, indexPath: string): void {
    if (indexWatcher) {
        indexWatcher.dispose();
    }
    
    const pattern = new vscode.RelativePattern(path.dirname(indexPath), path.basename(indexPath));
    indexWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    
    const reload = async () => {
        try {
            await loadIndex(workspaceRoot, true);
            vscode.window.showInformationMessage('Call graph index reloaded');
        } catch (error: any) {
            console.error('[IndexLoader] Keeping the previous index:', error.message);
        }
    };
    indexWatcher.onDidChange(reload);
    indexWatcher.onDidCreate(reload);
    indexWatcher.onDidDelete(() => {
        cachedIndex = null;
    });
}

/**
 * Clear the cached index
 */
export function clearCache(): void {
    cachedIndex = null;
    if (indexWatcher) {
        indexWatcher.dispose();
        indexWatcher = null;
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
