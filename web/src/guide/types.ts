import type { ProjectLanguage, VerificationStatus } from '../types';
import type { QueryIntent } from '../intent';
import type { ActiveView } from '../url-state';
import type { FrontierCounts, GroupDrawing } from '../trust-base';

// ============================================================================
// Graph Summary (static analysis output)
// ============================================================================

export interface CrateSummary {
  name: string;
  nodeCount: number;
  fileCount: number;
  isExternal: boolean;
}

/** Node counts per verification status, over the full graph. */
export interface VerificationBreakdown {
  verified: number;              // locally verified only
  transitivelyVerified: number;  // verified with every dependency verified or trusted
  trusted: number;
  failed: number;
  unverified: number;
  unknown: number;               // no status
}

/** The busiest directed pair of groups (crates, namespaces). */
export interface GroupBoundary {
  source: string;     // group of the callers
  target: string;     // group of the callees
  edgeCount: number;
}

export interface KindBreakdown {
  [kind: string]: number;
}

export interface NodeRank {
  id: string;
  displayName: string;
  crateName: string;
  kind: string;
  verificationStatus: string | undefined;
  dependentCount: number;
  dependencyCount: number;
}

/** A row of a Guide ranked list. */
export interface RankedAnswer extends NodeRank {
  transitiveDependentCount: number;  // unique nodes that reach it, over the full graph
  context?: string;                  // module or path, when another row has the same name
}

/** One ranked list: the top rows and how many candidates there were. */
export interface RankedList {
  rows: RankedAnswer[];
  total: number;
  query: string;  // the search box query of the list, e.g. `top 5 by dependents is:unfinished`
}

/** A group of theorems that rest on exactly the same nodes (trust-base.ts). */
export interface TrustGroupRow {
  theorems: string[];   // sorted by ID
  base: string[];       // the shared trust base, sorted by ID
  assumptions: number;  // base members per kind
  unfinished: number;
  unknown: number;
  baseNames: string[];  // display names of the base: unfinished, untracked, then assumptions
}

/** The largest groups, and how many groups the kind filters leave. */
export interface TrustGroupList {
  rows: TrustGroupRow[];
  total: number;
  /** Groups before the kind filters; 0 when no theorem rests on anything. */
  all: number;
}

/** A row of the Guide Frontier list: one work group (trust-base.ts proofFrontier). */
export interface FrontierListRow {
  members: string[];               // the unfinished members, sorted by ID
  names: string[];                 // their display names
  context?: string;                // module or path of the first member, when another row has the same name
  counts: FrontierCounts | null;   // null when the counts do not fit (rows in ID order)
}

/** The top work groups that can be worked on now. */
export interface FrontierList {
  rows: FrontierListRow[];
  /** Ready declarations in the groups the kind filters leave. */
  ready: number;
  /** Ready groups the kind filters leave, and how many of them would make nothing else ready. */
  groups: number;
  unblockNothing: number;
  /** Unfinished declarations in the graph; 0 means nothing is left to do. */
  unfinished: number;
  /** Ready groups before the kind filters. */
  all: number;
  counted: boolean;
}

/**
 * Nodes on one topological level of the SCC-condensed graph. Level 0 has
 * no dependencies. Statuses use the same definitions as VerificationBreakdown.
 */
export interface LevelStat {
  level: number;
  nodes: number;
  verified: number;
  transitivelyVerified: number;
  trusted: number;
}

export interface SuggestedQuery {
  label: string;
  description: string;
  action: SuggestedAction;
}

/**
 * Node payloads are exact IDs; `label` (the display name) is only for the
 * toast, query label and inputs.
 */
export type SuggestedAction =
  | { type: 'setSource'; id: string; label: string }
  | { type: 'setSink'; id: string; label: string }
  | { type: 'filterVerification'; statuses: VerificationStatus[] }
  | { type: 'setCrateBoundary'; source: string; target: string }
  | { type: 'switchView'; view: ActiveView }
  | { type: 'showTrustGroup'; ids: string[]; theorems: number; base: number; allChains: boolean }
  | { type: 'showWorkGroup'; ids: string[]; label: string }  // a ready cycle with its callers
  | { type: 'fillSearch'; query: string };  // put the query into the search box

/** Actions that change the graph state; `fillSearch` only fills the search box. */
export type StateAction = Exclude<SuggestedAction, { type: 'fillSearch' }>;

export interface GraphSummary {
  projectLanguage: ProjectLanguage;
  totalNodes: number;
  totalEdges: number;
  crates: CrateSummary[];
  boundary: GroupBoundary | null;
  files: string[];
  verification: VerificationBreakdown;
  kinds: KindBreakdown;
  unfinished: RankedList;    // unverified and failed, axioms excluded
  assumptions: RankedList;   // axioms and trusted nodes
  keystones: RankedList;     // lemmas (proof kinds), or every node when the graph has none
  keystonesAreLemmas: boolean;
  rankingsSkipped: { components: number; links: number } | null;  // condensed size when too large (lists empty)
  trustGroups: TrustGroupList | null;  // null: no verification data, blueprint layer, or too large
  frontier: FrontierList | null;  // null: no verification data or blueprint layer
  levels: LevelStat[];
  failedNodes: NodeRank[];
  suggestedQueries: SuggestedQuery[];
  roleFilterActive: boolean;  // rankings use the full relation while a role box is off
}

// ============================================================================
// Viewer actions the guide panel can trigger
// ============================================================================

/** Exact status set a transition selects (the status toggles follow it). */
export type StatusSelection = VerificationStatus[];

/**
 * One Guide action as a single state transition. The intent replaces the
 * current one, so a chip cannot leave part of a previous query behind.
 */
export interface GuideTransition {
  intent: QueryIntent;
  status: StatusSelection | null;  // null: keep the user's status filter
  depth?: number | null;           // absent: keep the user's depth; null: unlimited
  view?: ActiveView;
  label: string;
}

/** What an applied transition rendered; null for aggregated views (Crate Map, Hierarchy). */
export interface GuideResult {
  shown: number;           // nodes rendered
  total: number;           // nodes in the result before the render cap
  anchorsShown?: number;   // anchors kept when there were more than the render cap
  anchorsTotal?: number;
  displayRemoved?: number; // nodes the traversal reached that display filters removed
  missingAnchor: boolean;  // the exact target itself is filtered out
  seeded: boolean;         // large graph without a query: the entry-point view
  tooLarge: boolean;       // large graph without a query and no entry-point view: nothing rendered
}

export interface GuideActions {
  apply(t: GuideTransition): GuideResult | null;
  /** Put a query into the search box and open its result list */
  fillSearch(query: string): void;
  /** The nodes to draw for a theorem group, in cap order (trust-base.ts groupDrawing) */
  groupDrawing(row: TrustGroupRow): GroupDrawing;
}
