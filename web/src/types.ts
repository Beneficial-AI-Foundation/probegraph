// Type definitions matching the Rust D3Graph structure

import type { QueryIntent } from './intent';

export interface SimilarLemma {
  name: string;
  score: number;
  file_path: string;
  line_number: number | null;
  signature: string;
  source: string;  // "project" or "vstd"
}

// ============================================================================
// Simplified JSON Format (curve25519-dalek.json style)
// ============================================================================

/**
 * Node format used in simplified JSON files (like curve25519-dalek.json)
 * This is a flat array format without explicit links/metadata
 */
export interface SimplifiedNode {
  identifier: string;           // Maps to id
  statement_type?: string;      // e.g., "function" - informational only
  deps: string[];               // Maps to dependencies
  body?: string;                // Function body (code) - optional
  display_name: string;
  full_path: string;            // May have file:// prefix
  relative_path: string;
  file_name: string;
  parent_folder: string;
}

/**
 * Type guard to check if data is in simplified format (array of SimplifiedNode)
 */
export function isSimplifiedFormat(data: unknown): data is SimplifiedNode[] {
  if (!Array.isArray(data)) return false;
  if (data.length === 0) return true;  // Empty array could be either, default to simplified
  
  const firstItem = data[0];
  // Check for simplified format markers: has 'identifier' and 'deps' fields
  return (
    typeof firstItem === 'object' &&
    firstItem !== null &&
    'identifier' in firstItem &&
    'deps' in firstItem &&
    !('id' in firstItem)  // Make sure it's not a D3Node that happens to have deps
  );
}

/**
 * Type guard to check if data is in D3Graph format
 */
export function isD3GraphFormat(data: unknown): data is D3Graph {
  return (
    typeof data === 'object' &&
    data !== null &&
    'nodes' in data &&
    Array.isArray((data as any).nodes)
  );
}

/** Declaration kind (Verus: exec/proof/spec, Lean: theorem/def/axiom/...) */
export type DeclKind = string;

/** Detected project language based on kind values in the graph */
export type ProjectLanguage = 'verus' | 'lean' | 'mixed' | 'unknown';

const VERUS_KINDS = new Set(['exec', 'proof', 'spec']);
const LEAN_KINDS = new Set([
  'theorem', 'def', 'abbrev', 'class', 'structure',
  'inductive', 'instance', 'axiom', 'opaque', 'quot',
]);

/**
 * Detect project language by scanning the `language` field on nodes.
 * Falls back to kind-based heuristic when no language field is present.
 */
export function detectProjectLanguage(graph: D3Graph): ProjectLanguage {
  const langs = new Set<string>();
  for (const node of graph.nodes) {
    if (node.language) langs.add(node.language);
  }

  if (langs.size > 0) {
    const hasVerus = langs.has('verus');
    const hasLean = langs.has('lean');
    if (hasVerus && hasLean) return 'mixed';
    if (hasVerus) return 'verus';
    if (hasLean) return 'lean';
    return 'unknown';
  }

  // Fallback: infer from kind values (for older graph formats without language field)
  const kinds = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind) kinds.add(node.kind);
  }
  const hasVerusKinds = [...kinds].some(k => VERUS_KINDS.has(k));
  const hasLeanKinds = [...kinds].some(k => LEAN_KINDS.has(k) && !VERUS_KINDS.has(k));
  if (hasVerusKinds && hasLeanKinds) return 'mixed';
  if (hasVerusKinds) return 'verus';
  if (hasLeanKinds) return 'lean';
  return 'unknown';
}

/**
 * Get the kind sets for a given language. Everything not in any set is
 * treated as exec/definitions. Axioms are their own bucket (not spec):
 * they are part of the trusted base and shown by default, while Verus
 * spec functions stay hidden by default. Types (structure/inductive/class),
 * projections (auto-generated field accessors) and instances only occur in
 * Lean graphs, so the sets are language-independent.
 */
export function getKindSetsForLanguage(lang: ProjectLanguage): {
  proofKinds: Set<string>;
  specKinds: Set<string>;
  axiomKinds: Set<string>;
  typeKinds: Set<string>;
  projectionKinds: Set<string>;
  instanceKinds: Set<string>;
} {
  const proofKinds = lang === 'verus' ? new Set(['proof'])
    : lang === 'lean' ? new Set(['theorem'])
    : new Set(['proof', 'theorem']);
  return {
    proofKinds,
    specKinds: new Set(['spec']),
    axiomKinds: new Set(['axiom']),
    typeKinds: new Set(['structure', 'inductive', 'class']),
    projectionKinds: new Set(['projection']),
    instanceKinds: new Set(['instance']),
  };
}

/**
 * Compile a kind predicate from the filter flags: returns whether a node of
 * the given kind should be visible. Single source of truth for the kind
 * bucket -> filter flag mapping (used by both the traversal predicates and
 * the seeded-view display predicate).
 */
export function compileKindPredicate(
  filters: Pick<FilterOptions,
    'showExecFunctions' | 'showProofFunctions' | 'showSpecFunctions'
    | 'showAxioms' | 'showTypes' | 'showProjections' | 'showInstances'>,
  lang: ProjectLanguage,
): (kind: string) => boolean {
  const { proofKinds, specKinds, axiomKinds, typeKinds, projectionKinds, instanceKinds } =
    getKindSetsForLanguage(lang);
  return (kind: string) => {
    if (proofKinds.has(kind)) return filters.showProofFunctions;
    if (specKinds.has(kind)) return filters.showSpecFunctions;
    if (axiomKinds.has(kind)) return filters.showAxioms;
    if (typeKinds.has(kind)) return filters.showTypes;
    if (projectionKinds.has(kind)) return filters.showProjections;
    if (instanceKinds.has(kind)) return filters.showInstances;
    return filters.showExecFunctions;
  };
}

/** Verification status from Verus or probe-lean verification results */
export type VerificationStatus =
  | 'verified'
  | 'transitively-verified'
  | 'trusted'
  | 'failed'
  | 'unverified';

/** Statuses that count as "verified" for readiness/subtree computations */
export function isVerifiedStatus(status: VerificationStatus | undefined): boolean {
  return status === 'verified' || status === 'transitively-verified' || status === 'trusted';
}

/** Derived border status (this node's readiness to be verified) */
export type BorderStatus = 'verified' | 'ready' | 'blocked' | 'not_ready' | 'unknown';

/** Derived fill status (subtree completeness) */
export type FillStatus = 'fully_verified' | 'verified' | 'ready' | 'none';

export interface D3Node {
  id: string;
  display_name: string;
  symbol: string;
  full_path: string;
  relative_path: string;
  file_name: string;
  parent_folder: string;
  crate_name: string;
  // Note: body removed - use start_line/end_line to fetch code on demand
  start_line?: number;
  end_line?: number;
  is_libsignal: boolean;
  // Pre-computed for O(1) lookups in browser
  dependencies: string[];   // scip_names of functions this calls (outgoing)
  dependents: string[];     // scip_names of functions that call this (incoming)
  similar_lemmas?: SimilarLemma[];
  kind: DeclKind;  // Declaration kind: exec, proof, spec (Verus) or theorem, def, axiom, ... (Lean)
  verification_status?: VerificationStatus;  // Verification status: verified, failed, unverified
  language?: string;  // Per-atom language: "rust" or "lean"
  // Cross-language links (merged Rust/Lean atoms)
  mapping_id?: string;  // Lean translation probe ID (on Rust nodes)
  mapping_path?: string;  // Lean file path
  mapping_lines?: { start: number; end: number };
  specs?: string[];  // Probe IDs of spec theorems (on Lean def nodes)
  rust_source?: string;  // Rust source file path (on Lean nodes)
  is_public_api?: boolean;  // Part of the crate's public API (probe-rust/probe-verus)
  attributes?: string[];  // Lean declaration attributes, e.g. "blueprint" (probe-lean)
  // Derived at load time: public-API Rust/Verus atom, Lean translation target
  // of one (Aeneas mapping join), or @[blueprint]-attributed Lean atom.
  // Preferred seeds for the large-graph seeded initial view.
  is_entry_point?: boolean;
  // Derived statuses computed by DAG walk (used by File Map view)
  border_status?: BorderStatus;
  fill_status?: FillStatus;
  // D3-specific properties added during simulation
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

/** The type of a call/dependency link */
export type LinkType = 'inner' | 'precondition' | 'postcondition' | 'mapping' | 'spec';

export interface D3Link {
  source: string | D3Node;
  target: string | D3Node;
  type: LinkType | string;  // 'inner' | 'precondition' | 'postcondition' (or legacy 'calls')
}

/** Per-language GitHub source config derived from Schema 2.0 envelope inputs. */
export interface SourceConfig {
  github_url: string;
  ref: string;
  path_prefix: string;
  language: string;
  /** Package name of the envelope input, used to disambiguate several same-language inputs. */
  package: string;
}

export interface D3GraphMetadata {
  total_nodes: number;
  total_edges: number;
  project_root: string;
  generated_at: string;
  github_url?: string;
  source_configs?: SourceConfig[];
}

export interface D3Graph {
  nodes: D3Node[];
  links: D3Link[];
  metadata: D3GraphMetadata;
  nodeDepths?: Map<string, number>;
}

export interface FilterOptions {
  showLibsignal: boolean;
  showNonLibsignal: boolean;
  showInnerCalls: boolean;         // Show calls from function body (default: true)
  showPreconditionCalls: boolean;  // Show calls from requires clauses (default: false)
  showPostconditionCalls: boolean; // Show calls from ensures clauses (default: false)
  showMappingLinks: boolean;       // Show cross-language mapping edges (default: true)
  showSpecLinks: boolean;          // Show spec theorem edges (default: true)
  // Declaration kind filters
  showExecFunctions: boolean;      // Show exec/def/abbrev/opaque/... (default: true)
  showProofFunctions: boolean;     // Show proof/theorem (default: true)
  showSpecFunctions: boolean;      // Show Verus spec functions (default: false)
  showAxioms: boolean;             // Show axioms - part of the trusted base (default: true)
  showTypes: boolean;              // Show structure/inductive/class nodes (default: false)
  showProjections: boolean;        // Show auto-generated projections (default: false)
  showInstances: boolean;          // Show typeclass instances (default: false)
  // Language filters (for multi-language projects)
  showRustNodes: boolean;          // Show Rust/Verus nodes (default: true)
  showLeanNodes: boolean;          // Show Lean nodes (default: true)
  // Verification status filters
  showVerifiedNodes: boolean;      // Show verified nodes (default: true)
  showFailedNodes: boolean;        // Show failed nodes (default: true)
  showUnverifiedNodes: boolean;    // Show unverified/unknown nodes (default: true)
  exactStatuses: VerificationStatus[] | null;  // Set by a Guide action; overrides the three above (default: null)
  // Pattern-based exclusion (comma-separated glob patterns)
  excludeNamePatterns: string;     // Matches display_name, e.g., "*_comm*, lemma_mul_*"
  excludePathPatterns: string;     // Matches node ID path, e.g., "*/specs/*, */common_lemmas/*"
  // File-based inclusion (comma-separated file names or glob patterns)
  includeFiles: string;            // e.g., "edwards.rs, decompress*.rs" - empty means all files
  maxDepth: number | null;
  intent: QueryIntent;  // What the query is about: text selectors, exact IDs, focus set or boundary
  // Click selection: compiles to a depth query only while intent is 'none'
  selectedNodes: Set<string>;
  expandedNodes: Set<string>;
  hiddenNodes: Set<string>;  // Nodes hidden by user (Shift+click)
}

// ============================================================================
// Probe Atom Dict Format (shared by probe-verus and probe-lean)
// ============================================================================

/**
 * Atom format used in probe-verus and probe-lean atoms.json output.
 * This is a dict keyed by atom name (e.g., "probe:double_zero").
 */
export interface ProbeAtom {
  "display-name": string;
  dependencies: string[];
  /** probe-lean: names outside the extracted project referenced by the type signature. */
  "type-dependencies-external"?: string[];
  /** probe-lean: names outside the extracted project referenced by the body/proof. */
  "term-dependencies-external"?: string[];
  "code-text": { "lines-start": number; "lines-end": number } | null;
  "code-path": string;
  "code-module": string;
  kind: string;
  "verification-status"?: string;
  "specified"?: boolean;
  "dependencies-with-locations"?: Array<{
    "code-name": string;
    location: string;
    line: number;
  }>;
  language?: string;
  "rust-qualified-name"?: string;
  /** probe-rust/probe-verus: part of the crate's public API (ground truth with --with-public-api). */
  "is-public-api"?: boolean;
  /** probe-lean: declaration attributes from the header scan, e.g. "blueprint" for @[blueprint]. */
  attributes?: string[];
  "translation-name"?: string;
  "translation-path"?: string;
  "translation-text"?: { "lines-start": number; "lines-end": number };
  specs?: string[];
  "rust-source"?: string | null;
}

/**
 * Type guard to check if data is in probe atom dict format
 * (object keyed by atom name, where values have 'dependencies' and 'display-name')
 */
export function isAtomDictFormat(data: unknown): data is Record<string, ProbeAtom> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  if ('nodes' in data || 'links' in data) return false;
  const values = Object.values(data);
  if (values.length === 0) return false;
  const first = values[0] as any;
  return typeof first === 'object' && first !== null
    && 'dependencies' in first && 'display-name' in first;
}

// ============================================================================
// Schema 2.0 Envelope (probe-lean / probe-verus)
// ============================================================================

/**
 * Schema 2.0 metadata envelope wrapping tool output.
 * probe-lean (schema-2.0-envelope branch) wraps all output in this structure.
 */
export interface Schema2Source {
  repo: string;
  commit: string;
  language: string;
  package: string;
  "package-version": string;
}

export interface Schema2Envelope {
  schema: string;
  "schema-version": string;
  tool: { name: string; version: string; command: string };
  source?: Schema2Source;
  inputs?: Array<{ schema: string; source: Schema2Source }>;
  timestamp: string;
  data: unknown;
}

/**
 * Type guard: data is a Schema 2.0 envelope when it has `schema-version` and a `data` payload.
 */
export function isSchema2Envelope(data: unknown): data is Schema2Envelope {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  return 'schema-version' in data && 'data' in data;
}

export interface GraphState {
  fullGraph: D3Graph | null;
  filteredGraph: D3Graph | null;
  filters: FilterOptions;
  selectedNode: D3Node | null;
  hoveredNode: D3Node | null;
  projectLanguage: ProjectLanguage;
}

// ============================================================================
// Crate Map Types
// ============================================================================

export interface CrateNode {
  name: string;
  functionCount: number;
  fileCount: number;
  nodeIds: string[];
  isExternal: boolean;
}

export interface CrateEdge {
  source: string;
  target: string;
  callCount: number;
  calls: Array<{ sourceId: string; targetId: string; type: string }>;
}

export interface CrateGraph {
  nodes: CrateNode[];
  edges: CrateEdge[];
}

/**
 * Extract module/crate name from a D3Node based on its ID format.
 *
 * For Rust/Verus (or unknown): returns the top-level crate name (first path segment).
 * For Lean: returns the first two path segments from relative_path (e.g. "ArkLib/Data")
 * to give a more granular module hierarchy. Falls back to one segment if only one exists.
 */
export function extractCrateName(
  node: Pick<D3Node, 'id' | 'relative_path' | 'language'>,
  language: ProjectLanguage = 'unknown',
): string {
  const nodeLang = (node as D3Node).language;
  const useLeanExtraction = language === 'lean'
    || (language === 'mixed' && nodeLang === 'lean');

  if (useLeanExtraction && node.relative_path) {
    const parts = node.relative_path.split('/');
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return parts[0] || 'unknown';
  }

  // scip:crate_name/version/... → crate_name
  if (node.id.startsWith('scip:')) {
    const afterPrefix = node.id.slice(5);
    const slashIdx = afterPrefix.indexOf('/');
    return slashIdx > 0 ? afterPrefix.slice(0, slashIdx) : afterPrefix;
  }
  // probe:crate_name/... → crate_name (works for both internal and external atoms)
  if (node.id.startsWith('probe:')) {
    const afterPrefix = node.id.slice(6);
    const slashIdx = afterPrefix.indexOf('/');
    return slashIdx > 0 ? afterPrefix.slice(0, slashIdx) : afterPrefix;
  }
  if (node.relative_path) {
    const firstSlash = node.relative_path.indexOf('/');
    return firstSlash > 0 ? node.relative_path.slice(0, firstSlash) : node.relative_path;
  }
  return 'unknown';
}

