import type { ProjectLanguage } from '../types';
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

export interface VerificationBreakdown {
  verified: number;
  failed: number;
  unverified: number;
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
  | { type: 'filterVerification'; statuses: ('verified' | 'failed' | 'unverified')[] }
  | { type: 'setCrateBoundary'; source: string; target: string }
  | { type: 'switchView'; view: ActiveView };

export interface GraphSummary {
  projectLanguage: ProjectLanguage;
  totalNodes: number;
  totalEdges: number;
  crates: CrateSummary[];
  files: string[];
  verification: VerificationBreakdown;
  kinds: KindBreakdown;
  topConnected: NodeRank[];
  unverifiedHotspots: NodeRank[];
  failedNodes: NodeRank[];
  suggestedQueries: SuggestedQuery[];
}

// ============================================================================
// Viewer actions the guide panel can trigger
// ============================================================================

/** Status filter a transition sets (the three status toggles). */
export interface StatusSelection {
  verified: boolean;
  failed: boolean;
  unverified: boolean;
}

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

export interface GuideActions {
  apply(t: GuideTransition): void;
}
