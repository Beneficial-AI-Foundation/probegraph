/**
 * IndexLoader - Load and cache the D3 graph index from scip-callgraph pipeline
 * 
 * This module handles:
 * - Loading the call_graph_index.json file
 * - Building in-memory indices for O(1) lookup
 * - Caching and hot-reloading when the index changes
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Verification status from Verus
 */
export type VerificationStatus = 'verified' | 'failed' | 'unverified';

/**
 * Verus function mode
 */
export type FunctionMode = 'exec' | 'proof' | 'spec';

/**
 * D3 Node from scip-callgraph pipeline output
 */
export interface D3Node {
    id: string;
    display_name: string;
    symbol: string;
    relative_path: string;
    file_name: string;
    parent_folder: string;
    start_line?: number;
    end_line?: number;
    is_libsignal: boolean;
    dependencies: string[];   // IDs of functions this calls
    dependents: string[];     // IDs of functions that call this
    mode?: FunctionMode;
    verification_status?: VerificationStatus;
    full_path?: string;
}

/**
 * D3 Link (edge) from the graph
 */
export interface D3Link {
    source: string;
    target: string;
    type?: string;  // 'inner', 'precondition', 'postcondition'
}

/**
 * Metadata about the index
 */
export interface IndexMetadata {
    total_nodes: number;
    total_edges: number;
    project_root: string;
    generated_at: string;
    github_url?: string;
}

/**
 * Raw D3 graph JSON format from scip-callgraph
 */
export interface D3Graph {
    nodes: D3Node[];
    links: D3Link[];
    metadata?: IndexMetadata;
}

/**
 * In-memory index with multiple lookup strategies
 */
export interface CallGraphIndex {
    // Primary index: O(1) lookup by full symbol ID
    nodesById: Map<string, D3Node>;
    
    // Secondary indices for user queries
    nodesByDisplayName: Map<string, D3Node[]>;  // "my_function" → [node1, node2]
    nodesByFile: Map<string, D3Node[]>;         // "src/module.rs" → [...]
    nodesByLine: Map<string, Map<number, D3Node>>; // file → line → node
    
    // All links for reference
    links: D3Link[];
    
    // Metadata
    metadata: {
        totalNodes: number;
        totalEdges: number;
        projectRoot: string;
        generatedAt: Date;
        indexPath: string;
        loadedAt: Date;
    };
}

/**
 * Default index file path relative to workspace
 */
const DEFAULT_INDEX_PATH = '.vscode/call_graph_index.json';

/**
 * Singleton instance of the loaded index
 */
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
 * Get metadata about the index without loading it fully
 */
export function getIndexInfo(workspaceRoot: string): { exists: boolean; path: string; generatedAt?: Date; size?: number } {
    const indexPath = getIndexPath(workspaceRoot);
    
    if (!fs.existsSync(indexPath)) {
        return { exists: false, path: indexPath };
    }
    
    const stats = fs.statSync(indexPath);
    
    // Try to read just the metadata
    try {
        const content = fs.readFileSync(indexPath, 'utf8');
        const graph: D3Graph = JSON.parse(content);
        
        return {
            exists: true,
            path: indexPath,
            generatedAt: graph.metadata?.generated_at ? new Date(graph.metadata.generated_at) : stats.mtime,
            size: stats.size
        };
    } catch {
        return {
            exists: true,
            path: indexPath,
            generatedAt: stats.mtime,
            size: stats.size
        };
    }
}

/**
 * Load and parse the D3 graph index
 */
export async function loadIndex(workspaceRoot: string, forceReload: boolean = false): Promise<CallGraphIndex> {
    const indexPath = getIndexPath(workspaceRoot);
    
    // Return cached index if available and not forcing reload
    if (cachedIndex && !forceReload && cachedIndex.metadata.indexPath === indexPath) {
        console.log('[IndexLoader] Using cached index');
        return cachedIndex;
    }
    
    console.log(`[IndexLoader] Loading index from: ${indexPath}`);
    
    if (!fs.existsSync(indexPath)) {
        throw new Error(
            `Call graph index not found: ${indexPath}\n\n` +
            `To generate the index, run:\n` +
            `  Command Palette → "Call Graph: Regenerate Index"\n\n` +
            `Or manually:\n` +
            `  cd /path/to/scip-callgraph\n` +
            `  cargo run --release -p metrics-cli --bin pipeline -- \\\n` +
            `    ${workspaceRoot} -o ${indexPath} --skip-similar-lemmas`
        );
    }
    
    // Read and parse the JSON file
    const content = fs.readFileSync(indexPath, 'utf8');
    const graph: D3Graph = JSON.parse(content);
    
    console.log(`[IndexLoader] Parsed ${graph.nodes.length} nodes and ${graph.links.length} links`);
    
    // Build the index
    const index = buildIndex(graph, indexPath);
    
    // Cache the index
    cachedIndex = index;
    
    // Setup file watcher for hot-reload
    setupFileWatcher(workspaceRoot, indexPath);
    
    console.log(`[IndexLoader] Index loaded successfully`);
    return index;
}

/**
 * Build in-memory indices from the raw graph
 */
function buildIndex(graph: D3Graph, indexPath: string): CallGraphIndex {
    const nodesById = new Map<string, D3Node>();
    const nodesByDisplayName = new Map<string, D3Node[]>();
    const nodesByFile = new Map<string, D3Node[]>();
    const nodesByLine = new Map<string, Map<number, D3Node>>();
    
    for (const node of graph.nodes) {
        // Primary index by ID
        nodesById.set(node.id, node);
        
        // Index by display name
        const displayNameList = nodesByDisplayName.get(node.display_name) || [];
        displayNameList.push(node);
        nodesByDisplayName.set(node.display_name, displayNameList);
        
        // Index by file path
        const filePath = node.relative_path || node.file_name;
        if (filePath) {
            const fileList = nodesByFile.get(filePath) || [];
            fileList.push(node);
            nodesByFile.set(filePath, fileList);
        }
        
        // Index by file + line for cursor position lookup
        if (filePath && node.start_line !== undefined) {
            let lineMap = nodesByLine.get(filePath);
            if (!lineMap) {
                lineMap = new Map();
                nodesByLine.set(filePath, lineMap);
            }
            
            // Index all lines in the function's range
            const endLine = node.end_line || node.start_line;
            for (let line = node.start_line; line <= endLine; line++) {
                lineMap.set(line, node);
            }
        }
    }
    
    return {
        nodesById,
        nodesByDisplayName,
        nodesByFile,
        nodesByLine,
        links: graph.links,
        metadata: {
            totalNodes: graph.nodes.length,
            totalEdges: graph.links.length,
            projectRoot: graph.metadata?.project_root || '',
            generatedAt: graph.metadata?.generated_at ? new Date(graph.metadata.generated_at) : new Date(),
            indexPath,
            loadedAt: new Date()
        }
    };
}

/**
 * Setup file watcher to reload index when it changes
 */
function setupFileWatcher(workspaceRoot: string, indexPath: string): void {
    // Dispose existing watcher
    if (indexWatcher) {
        indexWatcher.dispose();
    }
    
    // Create new watcher
    const pattern = new vscode.RelativePattern(workspaceRoot, path.relative(workspaceRoot, indexPath));
    indexWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    
    indexWatcher.onDidChange(async () => {
        console.log('[IndexLoader] Index file changed, reloading...');
        try {
            await loadIndex(workspaceRoot, true);
            vscode.window.showInformationMessage('Call graph index reloaded');
        } catch (error: any) {
            console.error('[IndexLoader] Failed to reload index:', error);
        }
    });
    
    indexWatcher.onDidDelete(() => {
        console.log('[IndexLoader] Index file deleted');
        cachedIndex = null;
    });
}

/**
 * Find a node by cursor position (file + line)
 */
export function findNodeAtPosition(
    index: CallGraphIndex,
    filePath: string,
    line: number
): D3Node | null {
    // Normalize file path (try both relative and absolute)
    const relativePath = filePath.includes('/src/') 
        ? filePath.substring(filePath.indexOf('/src/') + 1)
        : path.basename(filePath);
    
    // Try to find by relative path first
    let lineMap = index.nodesByLine.get(relativePath);
    
    // If not found, try just the filename
    if (!lineMap) {
        const fileName = path.basename(filePath);
        for (const [key, map] of index.nodesByLine) {
            if (key.endsWith(fileName) || key.endsWith('/' + fileName)) {
                lineMap = map;
                break;
            }
        }
    }
    
    if (!lineMap) {
        return null;
    }
    
    return lineMap.get(line) || null;
}

/**
 * Find nodes by display name (function name)
 */
export function findNodesByName(index: CallGraphIndex, name: string): D3Node[] {
    return index.nodesByDisplayName.get(name) || [];
}

/**
 * Find node by full symbol ID
 */
export function findNodeById(index: CallGraphIndex, id: string): D3Node | null {
    return index.nodesById.get(id) || null;
}

/**
 * Get the cached index if available
 */
export function getCachedIndex(): CallGraphIndex | null {
    return cachedIndex;
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

