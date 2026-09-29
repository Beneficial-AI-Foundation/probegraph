import type { ProjectLanguage, VerificationStatus } from '../types';
import type { QueryIntent } from '../intent';
import type { ActiveView } from '../url-state';

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
  | { type: 'switchView'; view: ActiveView };

export interface GraphSummary {
  projectLanguage: ProjectLanguage;
  totalNodes: number;
  totalEdges: number;
  crates: CrateSummary[];
  boundary: GroupBoundary | null;
  files: string[];
  verification: VerificationBreakdown;
  kinds: KindBreakdown;
  topConnected: NodeRank[];
  unverifiedHotspots: NodeRank[];
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
  missingAnchor: boolean;  // the exact target itself is filtered out
  seeded: boolean;         // large graph without a query: the entry-point view
  tooLarge: boolean;       // large graph without a query and no entry-point view: nothing rendered
}

export interface GuideActions {
  apply(t: GuideTransition): GuideResult | null;
}
