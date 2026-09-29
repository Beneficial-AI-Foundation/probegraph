/**
 * Verification status filter.
 *
 * The three status checkboxes each cover a group of statuses; the Verified
 * box covers verified, transitively-verified and trusted. A Guide action can
 * narrow this to an exact status set (`exactStatuses`), which overrides the
 * boxes until the user edits them. Pure module (no DOM).
 */

import type { D3Node, VerificationStatus } from './types';

export type StatusGroup = 'verified' | 'failed' | 'unverified';

export const STATUS_GROUPS: Record<StatusGroup, VerificationStatus[]> = {
  verified: ['verified', 'transitively-verified', 'trusted'],
  failed: ['failed'],
  unverified: ['unverified'],
};

const ALL_STATUSES: VerificationStatus[] = Object.values(STATUS_GROUPS).flat();

export function isVerificationStatus(s: string): s is VerificationStatus {
  return (ALL_STATUSES as string[]).includes(s);
}

/** The status filter fields of FilterOptions. */
export interface StatusFilter {
  showVerifiedNodes: boolean;
  showFailedNodes: boolean;
  showUnverifiedNodes: boolean;
  exactStatuses: VerificationStatus[] | null;
}

/** A node without a status counts as unverified. */
function statusOf(node: D3Node): VerificationStatus {
  return node.verification_status ?? 'unverified';
}

function groupOf(status: VerificationStatus): StatusGroup {
  if (status === 'failed') return 'failed';
  if (status === 'unverified') return 'unverified';
  return 'verified';
}

function groupShown(f: StatusFilter, group: StatusGroup): boolean {
  switch (group) {
    case 'verified': return f.showVerifiedNodes;
    case 'failed': return f.showFailedNodes;
    case 'unverified': return f.showUnverifiedNodes;
  }
}

/** Node predicate for the status filter, or null when every status passes. */
export function compileStatusPredicate(f: StatusFilter): ((node: D3Node) => boolean) | null {
  if (f.exactStatuses) {
    const allowed = new Set(f.exactStatuses);
    return node => allowed.has(statusOf(node));
  }
  if (f.showVerifiedNodes && f.showFailedNodes && f.showUnverifiedNodes) return null;
  return node => groupShown(f, groupOf(statusOf(node)));
}

/** Checkbox state for a group: checked, unchecked or partly selected. */
export function groupCheckState(f: StatusFilter, group: StatusGroup): 'on' | 'off' | 'partial' {
  if (!f.exactStatuses) return groupShown(f, group) ? 'on' : 'off';
  const n = STATUS_GROUPS[group].filter(s => f.exactStatuses!.includes(s)).length;
  return n === 0 ? 'off' : n === STATUS_GROUPS[group].length ? 'on' : 'partial';
}

/**
 * Status filter after the user sets a group's checkbox. Other groups keep
 * their current selection; an exact set that becomes whole groups again
 * turns back into plain checkbox state.
 */
export function withGroupChecked(f: StatusFilter, group: StatusGroup, checked: boolean): StatusFilter {
  const next = { ...f };
  switch (group) {
    case 'verified': next.showVerifiedNodes = checked; break;
    case 'failed': next.showFailedNodes = checked; break;
    case 'unverified': next.showUnverifiedNodes = checked; break;
  }
  if (!f.exactStatuses) return next;
  const members = STATUS_GROUPS[group];
  const kept = f.exactStatuses.filter(s => !members.includes(s));
  const exact = checked ? [...kept, ...members] : kept;
  const whole = (Object.keys(STATUS_GROUPS) as StatusGroup[]).every(g => {
    const n = STATUS_GROUPS[g].filter(s => exact.includes(s)).length;
    return n === 0 || n === STATUS_GROUPS[g].length;
  });
  next.exactStatuses = whole ? null : exact;
  return next;
}

/** Status filter showing exactly `statuses`, with the checkboxes matching. */
export function exactStatusFilter(statuses: VerificationStatus[]): StatusFilter {
  return {
    showVerifiedNodes: STATUS_GROUPS.verified.some(s => statuses.includes(s)),
    showFailedNodes: statuses.includes('failed'),
    showUnverifiedNodes: statuses.includes('unverified'),
    exactStatuses: [...new Set(statuses)],
  };
}
