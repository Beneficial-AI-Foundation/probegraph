import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Import modules to test
import {
    D3Node,
    D3Graph,
    CallGraphIndex,
    formatTimestamp
} from '../indexLoader';

/**
 * Create a mock D3 graph for testing
 */
function createMockGraph(): D3Graph {
    const nodes: D3Node[] = [
        {
            id: 'func_a',
            display_name: 'function_a',
            symbol: 'crate::module::function_a',
            relative_path: 'src/module.rs',
            file_name: 'module.rs',
            parent_folder: 'src',
            start_line: 10,
            end_line: 20,
            is_libsignal: false,
            dependencies: ['func_b', 'func_c'],
            dependents: [],
            mode: 'exec',
            verification_status: 'verified'
        },
        {
            id: 'func_b',
            display_name: 'function_b',
            symbol: 'crate::module::function_b',
            relative_path: 'src/module.rs',
            file_name: 'module.rs',
            parent_folder: 'src',
            start_line: 25,
            end_line: 35,
            is_libsignal: false,
            dependencies: ['func_d'],
            dependents: ['func_a'],
            mode: 'proof',
            verification_status: 'verified'
        },
        {
            id: 'func_c',
            display_name: 'function_c',
            symbol: 'crate::module::function_c',
            relative_path: 'src/module.rs',
            file_name: 'module.rs',
            parent_folder: 'src',
            start_line: 40,
            end_line: 50,
            is_libsignal: false,
            dependencies: [],
            dependents: ['func_a'],
            mode: 'spec',
            verification_status: 'failed'
        },
        {
            id: 'func_d',
            display_name: 'function_d',
            symbol: 'crate::utils::function_d',
            relative_path: 'src/utils.rs',
            file_name: 'utils.rs',
            parent_folder: 'src',
            start_line: 5,
            end_line: 15,
            is_libsignal: false,
            dependencies: [],
            dependents: ['func_b'],
            mode: 'exec',
            verification_status: 'unverified'
        },
        {
            id: 'func_e',
            display_name: 'function_e',
            symbol: 'crate::other::function_e',
            relative_path: 'src/other.rs',
            file_name: 'other.rs',
            parent_folder: 'src',
            start_line: 1,
            end_line: 10,
            is_libsignal: false,
            dependencies: ['func_a'],
            dependents: [],
            mode: 'exec'
            // No verification_status - unknown
        }
    ];

    return {
        nodes,
        links: [
            { source: 'func_a', target: 'func_b' },
            { source: 'func_a', target: 'func_c' },
            { source: 'func_b', target: 'func_d' },
            { source: 'func_e', target: 'func_a' }
        ],
        metadata: {
            total_nodes: 5,
            total_edges: 4,
            project_root: '/test/project',
            generated_at: new Date().toISOString()
        }
    };
}

/**
 * Build a mock index from the mock graph
 */
function buildMockIndex(graph: D3Graph): CallGraphIndex {
    const nodesById = new Map<string, D3Node>();
    const nodesByDisplayName = new Map<string, D3Node[]>();
    const nodesByFile = new Map<string, D3Node[]>();
    const nodesByLine = new Map<string, Map<number, D3Node>>();

    for (const node of graph.nodes) {
        nodesById.set(node.id, node);

        const displayNameList = nodesByDisplayName.get(node.display_name) || [];
        displayNameList.push(node);
        nodesByDisplayName.set(node.display_name, displayNameList);

        const filePath = node.relative_path || node.file_name;
        if (filePath) {
            const fileList = nodesByFile.get(filePath) || [];
            fileList.push(node);
            nodesByFile.set(filePath, fileList);
        }

        if (filePath && node.start_line !== undefined) {
            let lineMap = nodesByLine.get(filePath);
            if (!lineMap) {
                lineMap = new Map();
                nodesByLine.set(filePath, lineMap);
            }
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
            generatedAt: new Date(graph.metadata?.generated_at || Date.now()),
            indexPath: '/test/index.json',
            loadedAt: new Date()
        }
    };
}

suite('IndexLoader Test Suite', () => {
    test('formatTimestamp should format recent timestamps', () => {
        const now = new Date();
        const result = formatTimestamp(now);
        assert.ok(result.includes('just now'));
    });

    test('formatTimestamp should format timestamps from minutes ago', () => {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const result = formatTimestamp(fiveMinutesAgo);
        assert.ok(result.includes('5 minutes ago'));
    });

    test('formatTimestamp should format timestamps from hours ago', () => {
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const result = formatTimestamp(twoHoursAgo);
        assert.ok(result.includes('2 hours ago'));
    });

    test('Mock graph should have correct structure', () => {
        const graph = createMockGraph();
        assert.strictEqual(graph.nodes.length, 5);
        assert.strictEqual(graph.links.length, 4);
        assert.ok(graph.metadata);
    });

    test('Mock index should build correctly', () => {
        const graph = createMockGraph();
        const index = buildMockIndex(graph);

        assert.strictEqual(index.nodesById.size, 5);
        assert.strictEqual(index.metadata.totalNodes, 5);
        assert.strictEqual(index.metadata.totalEdges, 4);
    });

    test('Index should look up nodes by ID', () => {
        const graph = createMockGraph();
        const index = buildMockIndex(graph);

        const node = index.nodesById.get('func_a');
        assert.ok(node);
        assert.strictEqual(node.display_name, 'function_a');
        assert.strictEqual(node.verification_status, 'verified');
    });

    test('Index should look up nodes by display name', () => {
        const graph = createMockGraph();
        const index = buildMockIndex(graph);

        const nodes = index.nodesByDisplayName.get('function_b');
        assert.ok(nodes);
        assert.strictEqual(nodes.length, 1);
        assert.strictEqual(nodes[0].id, 'func_b');
    });

    test('Index should look up nodes by file', () => {
        const graph = createMockGraph();
        const index = buildMockIndex(graph);

        const nodes = index.nodesByFile.get('src/module.rs');
        assert.ok(nodes);
        assert.strictEqual(nodes.length, 3); // func_a, func_b, func_c
    });

    test('Index should look up nodes by line', () => {
        const graph = createMockGraph();
        const index = buildMockIndex(graph);

        const lineMap = index.nodesByLine.get('src/module.rs');
        assert.ok(lineMap);

        // Line 15 should be in func_a (lines 10-20)
        const node = lineMap.get(15);
        assert.ok(node);
        assert.strictEqual(node.id, 'func_a');
    });
});

suite('Integration Test Suite', () => {
    test('Full workflow: create graph, build index, lookup nodes', () => {
        // Create mock data
        const graph = createMockGraph();
        
        // Build index
        const index = buildMockIndex(graph);
        
        // Verify index structure
        assert.ok(index.nodesById.size > 0);
        assert.ok(index.links.length > 0);
        
        // Lookup by various methods
        const nodeById = index.nodesById.get('func_a');
        assert.ok(nodeById);
        assert.strictEqual(nodeById.display_name, 'function_a');
        
        const nodesByName = index.nodesByDisplayName.get('function_a');
        assert.ok(nodesByName);
        assert.strictEqual(nodesByName.length, 1);
        
        const nodesByFile = index.nodesByFile.get('src/module.rs');
        assert.ok(nodesByFile);
        assert.strictEqual(nodesByFile.length, 3);
    });

    test('Write and read mock index file', () => {
        const tempDir = path.join(os.tmpdir(), 'call-graph-test-' + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });

        try {
            const graph = createMockGraph();
            const indexPath = path.join(tempDir, 'test_index.json');

            // Write the index
            fs.writeFileSync(indexPath, JSON.stringify(graph, null, 2));

            // Read it back
            const content = fs.readFileSync(indexPath, 'utf8');
            const loadedGraph: D3Graph = JSON.parse(content);

            // Verify
            assert.strictEqual(loadedGraph.nodes.length, graph.nodes.length);
            assert.strictEqual(loadedGraph.links.length, graph.links.length);

            // Build index from loaded graph
            const index = buildMockIndex(loadedGraph);
            assert.strictEqual(index.nodesById.size, 5);

        } finally {
            // Cleanup
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('Verification status distribution', () => {
        const graph = createMockGraph();
        const index = buildMockIndex(graph);
        
        // Count verification statuses
        let verified = 0, failed = 0, unverified = 0, unknown = 0;
        for (const node of index.nodesById.values()) {
            switch (node.verification_status) {
                case 'verified': verified++; break;
                case 'failed': failed++; break;
                case 'unverified': unverified++; break;
                default: unknown++; break;
            }
        }
        
        // From our mock data:
        // verified: func_a, func_b (2)
        // failed: func_c (1)
        // unverified: func_d (1)
        // unknown: func_e (1)
        assert.strictEqual(verified, 2);
        assert.strictEqual(failed, 1);
        assert.strictEqual(unverified, 1);
        assert.strictEqual(unknown, 1);
    });
});
