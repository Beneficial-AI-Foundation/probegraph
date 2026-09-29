/**
 * Golden/snapshot integration tests for the query pipeline.
 *
 * These tests load REAL graph data through the CURRENT applyFilters() and
 * assert exact outputs.  They serve as the immutable regression safety net:
 * any refactoring that changes these values has introduced a behavioral
 * difference.
 *
 * Tier 2 tests from the plan (composable query pipeline).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFilters } from './filters';
import { parseAndNormalizeGraph } from './graph-loader';
import { D3Graph, FilterOptions, detectProjectLanguage, extractCrateName } from './types';
import { NONE_INTENT, textIntent } from './intent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFilters(overrides: Partial<FilterOptions> = {}): FilterOptions {
  return {
    showLibsignal: true,
    showNonLibsignal: true,
    showInnerCalls: true,
    showPreconditionCalls: true,
    showPostconditionCalls: true,
    showMappingLinks: true,
    showSpecLinks: true,
    showExecFunctions: true,
    showProofFunctions: true,
    showSpecFunctions: true,
    showAxioms: true,
    showTypes: true,
    showProjections: true,
    showInstances: true,
    showRustNodes: true,
    showLeanNodes: true,
    showVerifiedNodes: true,
    showFailedNodes: true,
    showUnverifiedNodes: true,
    excludeNamePatterns: '',
    excludePathPatterns: '',
    includeFiles: '',
    maxDepth: null,
    intent: NONE_INTENT,
    selectedNodes: new Set(),
    expandedNodes: new Set(),
    hiddenNodes: new Set(),
    ...overrides,
  };
}

function loadJsonFile(filePath: string): unknown {
  const text = readFileSync(filePath, 'utf8');
  return JSON.parse(text);
}

/** Backfill crate_name the same way loadGraph() does in main.ts */
function backfillCrateNames(graph: D3Graph): void {
  const lang = detectProjectLanguage(graph);
  for (const node of graph.nodes) {
    node.crate_name = extractCrateName(node, lang);
  }
}

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const GRAPH_TMP_PATH = resolve(__dirname, '../public/graph_tmp.json');
const MERGED_ATOMS_PATH = resolve(__dirname, '../public/merged_rust_lean_atoms.json');
const PMEMLOG_PATH = '/home/lacra/git_repos/baif/verus_projects/pmemlog/.verilib/atoms.json';
const KATYDID_PATH = '/home/lacra/git_repos/baif/katydid-proofs/.verilib/atoms.json';

// ============================================================================
// graph_tmp.json  (1 130 Verus nodes, D3Graph format, has mode/verification_status/link types)
// ============================================================================

describe.skipIf(!existsSync(GRAPH_TMP_PATH))('Golden: graph_tmp.json (Verus)', () => {
  let graph: D3Graph;

  beforeAll(() => {
    const raw = loadJsonFile(GRAPH_TMP_PATH);
    graph = parseAndNormalizeGraph(raw);
    backfillCrateNames(graph);
  });

  it('full graph (no filters) has exact node/link counts', () => {
    const result = applyFilters(graph, createFilters());
    // 1130 total nodes minus 55 isolated = 1075 connected nodes
    expect(result.nodes.length).toBe(1075);
    expect(result.links.length).toBe(4372);
  });

  it('forward traversal: source=decompress depth=2', () => {
    const filters = createFilters({ intent: textIntent('decompress', ''), maxDepth: 2 });
    const result = applyFilters(graph, filters);

    // Pinned golden values
    expect(result.nodes.length).toBeGreaterThan(0);
    // The "decompress" nodes should be present
    const names = new Set(result.nodes.map(n => n.display_name));
    expect(names.has('decompress')).toBe(true);

    // Snapshot the exact count so future changes break loudly
    expect(result.nodes.length).toMatchSnapshot();
    expect(result.links.length).toMatchSnapshot();
  });

  it('backward traversal: sink=lemma_bridge_pow_as_nat_to_spec depth=1', () => {
    const filters = createFilters({
      intent: textIntent('', 'lemma_bridge_pow_as_nat_to_spec'),
      maxDepth: 1,
    });
    const result = applyFilters(graph, filters);

    expect(result.nodes.length).toBeGreaterThan(0);
    const names = new Set(result.nodes.map(n => n.display_name));
    expect(names.has('lemma_bridge_pow_as_nat_to_spec')).toBe(true);
    // Known callers: pow_p58, pow22501
    expect(names.has('pow_p58')).toBe(true);
    expect(names.has('pow22501')).toBe(true);

    expect(result.nodes.length).toMatchSnapshot();
    expect(result.links.length).toMatchSnapshot();
  });

  it('path finding: source=mul, sink=spec_sqrt_ad_minus_one', () => {
    const filters = createFilters({
      intent: textIntent('mul', 'spec_sqrt_ad_minus_one'),
    });
    const result = applyFilters(graph, filters);

    expect(result.nodes.length).toMatchSnapshot();
    expect(result.links.length).toMatchSnapshot();
  });

  it('neighborhood: source=sink=decompress depth=1', () => {
    const filters = createFilters({
      intent: textIntent('decompress', 'decompress'),
      maxDepth: 1,
    });
    const result = applyFilters(graph, filters);

    expect(result.nodes.length).toMatchSnapshot();
    expect(result.links.length).toMatchSnapshot();
  });

  it('link type filtering: showPreconditionCalls=false', () => {
    const filters = createFilters({ showPreconditionCalls: false });
    const result = applyFilters(graph, filters);

    const precondLinks = result.links.filter(l => l.type === 'precondition');
    expect(precondLinks.length).toBe(0);

    expect(result.nodes.length).toMatchSnapshot();
    expect(result.links.length).toMatchSnapshot();
  });

  it('link type filtering: only inner calls', () => {
    const filters = createFilters({
      showPreconditionCalls: false,
      showPostconditionCalls: false,
    });
    const result = applyFilters(graph, filters);

    const nonInner = result.links.filter(l => l.type !== 'inner');
    expect(nonInner.length).toBe(0);

    expect(result.nodes.length).toMatchSnapshot();
    expect(result.links.length).toMatchSnapshot();
  });

  it('include files: edwards.rs', () => {
    const filters = createFilters({ includeFiles: 'edwards.rs' });
    const result = applyFilters(graph, filters);

    expect(result.nodes.length).toMatchSnapshot();
    expect(result.links.length).toMatchSnapshot();
  });

  it('exclude name pattern: *_comm*', () => {
    const filters = createFilters({ excludeNamePatterns: '*_comm*' });
    const result = applyFilters(graph, filters);

    const commNodes = result.nodes.filter(n => n.display_name.includes('_comm'));
    expect(commNodes.length).toBe(0);

    expect(result.nodes.length).toMatchSnapshot();
    expect(result.links.length).toMatchSnapshot();
  });

  it('crate boundary: source=crate:curve25519-dalek, sink=crate:curve25519-dalek (self)', () => {
    const filters = createFilters({
      intent: textIntent('crate:curve25519-dalek', 'crate:curve25519-dalek'),
    });
    const result = applyFilters(graph, filters);

    expect(result.nodes.length).toMatchSnapshot();
    expect(result.links.length).toMatchSnapshot();
  });
});

// ============================================================================
// pmemlog atoms.json  (109 Verus atoms, atom dict format)
// ============================================================================

describe.skipIf(!existsSync(PMEMLOG_PATH))('Golden: pmemlog atoms.json (Verus atom dict)', () => {
  let graph: D3Graph;

  beforeAll(() => {
    const raw = loadJsonFile(PMEMLOG_PATH);
    graph = parseAndNormalizeGraph(raw);
    backfillCrateNames(graph);
  });

  it('loads correct number of nodes and links', () => {
    expect(graph.nodes.length).toBe(109);
    expect(graph.links.length).toMatchSnapshot();
  });

  it('source query for known function', () => {
    const filters = createFilters({ intent: textIntent('valid', ''), maxDepth: 2 });
    const result = applyFilters(graph, filters);

    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes.length).toMatchSnapshot();
    expect(result.links.length).toMatchSnapshot();
  });

  it('full graph (no filters)', () => {
    const result = applyFilters(graph, createFilters());
    expect(result.nodes.length).toMatchSnapshot();
    expect(result.links.length).toMatchSnapshot();
  });

  it('detected as Verus project', () => {
    // pmemlog atoms have no kind field (all default to 'exec')
    // So detectProjectLanguage returns 'unknown' (no verus or lean markers)
    const lang = detectProjectLanguage(graph);
    expect(lang).toMatchSnapshot();
  });
});

// ============================================================================
// katydid-proofs atoms.json  (589 Lean atoms, language agnosticism)
// ============================================================================

describe.skipIf(!existsSync(KATYDID_PATH))('Golden: katydid-proofs atoms.json (Lean)', () => {
  let graph: D3Graph;

  beforeAll(() => {
    const raw = loadJsonFile(KATYDID_PATH);
    graph = parseAndNormalizeGraph(raw);
    backfillCrateNames(graph);
  });

  it('loads correct number of nodes', () => {
    expect(graph.nodes.length).toBe(589);
    expect(graph.links.length).toMatchSnapshot();
  });

  it('language detection returns lean', () => {
    const lang = detectProjectLanguage(graph);
    expect(lang).toBe('lean');
  });

  it('Lean kinds present: def, abbrev, inductive, structure, opaque, theorem', () => {
    const kinds = new Set(graph.nodes.map(n => n.kind));
    expect(kinds.has('def')).toBe(true);
    expect(kinds.has('theorem')).toBe(true);
    expect(kinds.has('abbrev')).toBe(true);
    expect(kinds.has('inductive')).toBe(true);
    expect(kinds.has('structure')).toBe(true);
    expect(kinds.has('opaque')).toBe(true);
  });

  it('Lean kind filtering: showProofFunctions=false removes theorems', () => {
    const filters = createFilters({ showProofFunctions: false });
    const result = applyFilters(graph, filters, 'lean');

    const theoremNodes = result.nodes.filter(n => n.kind === 'theorem');
    expect(theoremNodes.length).toBe(0);

    expect(result.nodes.length).toMatchSnapshot();
    expect(result.links.length).toMatchSnapshot();
  });

  it('full graph (no filters)', () => {
    const result = applyFilters(graph, createFilters(), 'lean');
    expect(result.nodes.length).toMatchSnapshot();
    expect(result.links.length).toMatchSnapshot();
  });

  it('source query for known function', () => {
    const filters = createFilters({ intent: textIntent('validate_commutes', ''), maxDepth: 2 });
    const result = applyFilters(graph, filters, 'lean');

    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes.length).toMatchSnapshot();
    expect(result.links.length).toMatchSnapshot();
  });
});

// ============================================================================
// graph.json  (the current public graph; mixed-language filtering is covered
// by the merged_rust_lean_atoms.json golden suite below)
// ============================================================================

const GRAPH_JSON_PATH = resolve(__dirname, '../public/graph.json');

describe.skipIf(!existsSync(GRAPH_JSON_PATH))('Language filter: graph.json', () => {
  let graph: D3Graph;

  beforeAll(() => {
    const raw = loadJsonFile(GRAPH_JSON_PATH);
    graph = parseAndNormalizeGraph(raw);
    backfillCrateNames(graph);
  });

  it('detects as lean (not mixed, not verus)', () => {
    expect(detectProjectLanguage(graph)).toBe('lean');
  });

  it('showRustNodes=false keeps Lean nodes', () => {
    const filters = createFilters({ showRustNodes: false, showLeanNodes: true });
    const result = applyFilters(graph, filters, 'lean');
    expect(result.nodes.length).toBeGreaterThan(0);
    const rustInResult = result.nodes.filter(n => n.language === 'rust');
    expect(rustInResult.length).toBe(0);
    const leanInResult = result.nodes.filter(n => n.language === 'lean');
    expect(leanInResult.length).toBeGreaterThan(5);
  });
});

// ============================================================================
// merged_rust_lean_atoms.json  (Rust + Lean merged atoms, Schema 2.0 envelope)
// ============================================================================

describe.skipIf(!existsSync(MERGED_ATOMS_PATH))('Golden: merged_rust_lean_atoms.json (mixed Rust/Lean)', () => {
  let graph: D3Graph;

  beforeAll(() => {
    const raw = loadJsonFile(MERGED_ATOMS_PATH);
    graph = parseAndNormalizeGraph(raw);
    backfillCrateNames(graph);
  });

  it('loads correct number of nodes', () => {
    expect(graph.nodes.length).toBe(2130);
  });

  it('language detection returns mixed', () => {
    const lang = detectProjectLanguage(graph);
    expect(lang).toBe('mixed');
  });

  it('contains both Rust and Lean nodes', () => {
    const rustNodes = graph.nodes.filter(n => n.language === 'rust');
    const leanNodes = graph.nodes.filter(n => n.language === 'lean');
    expect(rustNodes.length).toBeGreaterThan(0);
    expect(leanNodes.length).toBeGreaterThan(0);
    expect(rustNodes.length).toMatchSnapshot();
    expect(leanNodes.length).toMatchSnapshot();
  });

  it('contains mapping links', () => {
    const mappingLinks = graph.links.filter(l => l.type === 'mapping');
    expect(mappingLinks.length).toBeGreaterThan(0);
    expect(mappingLinks.length).toMatchSnapshot();
  });

  it('contains spec links', () => {
    const specLinks = graph.links.filter(l => l.type === 'spec');
    expect(specLinks.length).toBeGreaterThan(0);
    expect(specLinks.length).toMatchSnapshot();
  });

  it('Rust nodes with mapping_id link to existing Lean nodes', () => {
    const rustWithMapping = graph.nodes.filter(n => n.language === 'rust' && n.mapping_id);
    expect(rustWithMapping.length).toBeGreaterThan(0);

    const nodeIds = new Set(graph.nodes.map(n => n.id));
    for (const node of rustWithMapping) {
      expect(nodeIds.has(node.mapping_id!)).toBe(true);
    }
    expect(rustWithMapping.length).toMatchSnapshot();
  });

  it('Lean nodes with specs reference existing atoms', () => {
    const leanWithSpecs = graph.nodes.filter(n => n.specs && n.specs.length > 0);
    expect(leanWithSpecs.length).toBeGreaterThan(0);

    const nodeIds = new Set(graph.nodes.map(n => n.id));
    for (const node of leanWithSpecs) {
      for (const specId of node.specs!) {
        expect(nodeIds.has(specId)).toBe(true);
      }
    }
    expect(leanWithSpecs.length).toMatchSnapshot();
  });

  it('filtering: showMappingLinks=false removes mapping links', () => {
    const filters = createFilters({ showMappingLinks: false });
    const result = applyFilters(graph, filters, 'mixed');

    const mappingLinks = result.links.filter(l => l.type === 'mapping');
    expect(mappingLinks.length).toBe(0);
  });

  it('filtering: showSpecLinks=false removes spec links', () => {
    const filters = createFilters({ showSpecLinks: false });
    const result = applyFilters(graph, filters, 'mixed');

    const specLinks = result.links.filter(l => l.type === 'spec');
    expect(specLinks.length).toBe(0);
  });

  it('full graph (no filters)', () => {
    const result = applyFilters(graph, createFilters(), 'mixed');
    expect(result.nodes.length).toMatchSnapshot();
    expect(result.links.length).toMatchSnapshot();
  });
});
