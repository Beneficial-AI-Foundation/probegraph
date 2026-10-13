/**
 * Names of the node filters as the filter panel shows them, for messages
 * that say which filter hides a node. Shared by the viewer and the VS Code
 * extension; no imports, so the extension bundle pulls in nothing else.
 */

const FILTER_NAMES: Record<string, string> = {
  showExecFunctions: 'Exec', showProofFunctions: 'Proof', showSpecFunctions: 'Spec',
  showAxioms: 'Axiom', showTypes: 'Type', showProjections: 'Projection', showInstances: 'Instance',
  showRustNodes: 'Rust', showLeanNodes: 'Lean', showLibsignal: 'libsignal', showNonLibsignal: 'non-libsignal',
  showVerifiedNodes: 'Verified', showFailedNodes: 'Failed', showUnverifiedNodes: 'Unverified',
  exactStatuses: 'status', excludeNamePatterns: 'name exclusion', excludePathPatterns: 'path exclusion',
  includeFiles: 'file',
};

/** "the Type filter", "the Type and file filters"; the key itself for an unknown filter. */
export function describeFilters(keys: string[]): string {
  const names = keys.map(k => FILTER_NAMES[k] ?? k);
  return `the ${names.join(' and ')} filter${names.length > 1 ? 's' : ''}`;
}
