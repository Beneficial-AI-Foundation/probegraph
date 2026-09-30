/**
 * URL codec for the viewer state.
 *
 * One function writes the state into URL params and one builds the whole
 * state from defaults plus the URL, so a reload and browser back restore the
 * same thing. Pure module (no DOM). See docs/plans/query-intent.md, "URL mapping".
 */

import type { D3Graph, FilterOptions, ProjectLanguage } from './types';
import {
  QueryIntent, IdDirection, NONE_INTENT, textIntent, exactIntent, boundaryIntent,
  isFocusIntent,
} from './intent';
import { exactStatusFilter, isVerificationStatus } from './status-filter';

export type ActiveView = 'callgraph' | 'file-map' | 'crate-map' | 'hierarchy';

/** Which graph is shown when the input has a probe-leanblueprint layer. */
export type Layer = 'code' | 'blueprint';

export interface URLViewState {
  filters: FilterOptions;
  view: ActiveView;
  /** Crate dropdown / Crate Map highlight selection (not a query). */
  sourceCrate: string;
  targetCrate: string;
  hierarchyExpanded: string[];
  /** ?focus= to write while a focus load is pending (the intent is still none). */
  pendingFocusUrl: string | null;
  entrypointsUrl: string | null;
  projectLanguage: ProjectLanguage;
  /** Written as `layer=`; null when the graph has one layer or the default one is shown. */
  layer?: Layer | null;
}

/** What the URL describes; `focusUrl` still has to be resolved to IDs. */
export interface ParsedURLState {
  filters: FilterOptions;
  view: ActiveView;
  sourceCrate: string;
  targetCrate: string;
  hierarchyExpanded: string[];
  focusUrl: string | null;
  entrypointsUrl: string | null;
  /** null: no `layer=` param, the graph's default layer applies. */
  layer: Layer | null;
}

/** Every param the viewer owns. Written params are deleted first, so a value reset to its default disappears. */
const OWNED_PARAMS = [
  'source', 'sink', 'id', 'dir', 'label', 'boundary-source', 'boundary-target', 'focus',
  'sel', 'exclude', 'files', 'depth',
  'exec', 'proof', 'spec', 'axioms', 'types', 'proj', 'inst',
  'inner', 'pre', 'post', 'mapping', 'speclinks', 'statement', 'body',
  'libsignal', 'external', 'rust', 'lean',
  'verified', 'failed', 'unverified', 'status',
  'excludeName', 'excludePath', 'hidden', 'hide',
  'entrypoints', 'view', 'source-crate', 'target-crate', 'expanded', 'layer',
];

const DEFAULT_DEPTH = 1;

/**
 * The viewer's filter defaults. writeURLState omits every value equal to
 * these, so the two must agree.
 */
export function defaultFilters(): FilterOptions {
  return {
    showLibsignal: true,
    showNonLibsignal: true,
    showInnerCalls: true,           // Show body calls by default
    showPreconditionCalls: false,   // Hide requires calls by default
    showPostconditionCalls: false,  // Hide ensures calls by default
    showMappingLinks: true,         // Show cross-language mapping edges by default
    showSpecLinks: true,            // Show spec theorem edges by default
    showStatementDeps: true,        // Show statement dependencies by default
    showBodyDeps: true,             // Show body/proof dependencies by default
    showExecFunctions: true,        // Show exec functions by default
    showProofFunctions: true,       // Show proof functions by default
    showSpecFunctions: false,       // Hide Verus spec functions by default
    showAxioms: true,               // Show axioms by default (trusted base)
    showTypes: false,               // Hide structure/inductive/class nodes by default
    showProjections: false,         // Hide auto-generated projections by default
    showInstances: false,           // Hide typeclass instances by default
    showRustNodes: true,            // Show Rust/Verus nodes by default
    showLeanNodes: true,            // Show Lean nodes by default
    showVerifiedNodes: true,        // Show verified nodes by default
    showFailedNodes: true,          // Show failed nodes by default
    showUnverifiedNodes: true,      // Show unverified/unknown nodes by default
    exactStatuses: null,            // No exact status set by default
    excludeNamePatterns: '',        // Exclude by function name (e.g., *_comm*)
    excludePathPatterns: '',        // Exclude by path (e.g., */specs/*)
    includeFiles: '',               // Comma-separated file patterns to include (empty = all)
    maxDepth: DEFAULT_DEPTH,
    intent: NONE_INTENT,
    selectedNodes: new Set(),
    expandedNodes: new Set(),
    hiddenNodes: new Set(),
  };
}

const ID_DIRECTIONS: IdDirection[] = ['none', 'callers', 'callees', 'both'];

function writeIntent(params: URLSearchParams, intent: QueryIntent, pendingFocusUrl: string | null): void {
  switch (intent.kind) {
    case 'none':
      if (pendingFocusUrl) params.set('focus', pendingFocusUrl);
      break;
    case 'text':
      if (intent.source) params.set('source', intent.source);
      if (intent.sink) params.set('sink', intent.sink);
      break;
    case 'ids':
      if (isFocusIntent(intent)) {
        // The set can be thousands of nodes: write where it came from
        params.set('focus', intent.origin.url);
      } else {
        // Repeated params: Rust IDs can contain commas
        for (const id of intent.ids) params.append('id', id);
        params.set('dir', intent.dir);
        params.set('label', intent.label);
      }
      break;
    case 'boundary':
      params.set('boundary-source', intent.sourceGroup);
      params.set('boundary-target', intent.targetGroup);
      break;
  }
}

/** Replace the viewer's params in `params` with the given state; other params (json, github, ...) are kept. */
export function writeURLState(params: URLSearchParams, s: URLViewState): void {
  for (const k of OWNED_PARAMS) params.delete(k);
  const f = s.filters;

  if (s.layer) params.set('layer', s.layer);
  if (s.view !== 'callgraph') params.set('view', s.view);
  if (s.sourceCrate) params.set('source-crate', s.sourceCrate);
  if (s.targetCrate) params.set('target-crate', s.targetCrate);
  if (s.view === 'hierarchy' && s.hierarchyExpanded.length > 0) {
    params.set('expanded', s.hierarchyExpanded.join(','));
  }

  writeIntent(params, f.intent, s.pendingFocusUrl);
  for (const id of f.selectedNodes) params.append('sel', id);

  if (f.includeFiles) params.set('files', f.includeFiles);
  if (f.maxDepth === null) params.set('depth', '0');
  else if (f.maxDepth !== DEFAULT_DEPTH) params.set('depth', f.maxDepth.toString());

  // Only non-default boolean values, to keep the URL short
  if (!f.showExecFunctions) params.set('exec', '0');
  if (!f.showProofFunctions) params.set('proof', '0');
  if (f.showSpecFunctions) params.set('spec', '1');
  if (!f.showAxioms) params.set('axioms', '0');
  if (f.showTypes) params.set('types', '1');
  if (f.showProjections) params.set('proj', '1');
  if (f.showInstances) params.set('inst', '1');
  if (s.projectLanguage !== 'lean') {
    if (!f.showInnerCalls) params.set('inner', '0');
    if (f.showPreconditionCalls) params.set('pre', '1');
    if (f.showPostconditionCalls) params.set('post', '1');
  }
  if (!f.showMappingLinks) params.set('mapping', '0');
  if (!f.showSpecLinks) params.set('speclinks', '0');
  if (!f.showStatementDeps) params.set('statement', '0');
  if (!f.showBodyDeps) params.set('body', '0');
  if (!f.showLibsignal) params.set('libsignal', '0');
  if (!f.showNonLibsignal) params.set('external', '0');
  if (!f.showRustNodes) params.set('rust', '0');
  if (!f.showLeanNodes) params.set('lean', '0');
  if (!f.showVerifiedNodes) params.set('verified', '0');
  if (!f.showFailedNodes) params.set('failed', '0');
  if (!f.showUnverifiedNodes) params.set('unverified', '0');
  if (f.exactStatuses) params.set('status', f.exactStatuses.join(','));
  if (f.excludeNamePatterns) params.set('excludeName', f.excludeNamePatterns);
  if (f.excludePathPatterns) params.set('excludePath', f.excludePathPatterns);
  for (const id of f.hiddenNodes) params.append('hide', id);

  // Kept even when its fetch failed: the link stays shareable
  if (s.entrypointsUrl) params.set('entrypoints', s.entrypointsUrl);
}

function readIntent(params: URLSearchParams): { intent: QueryIntent; focusUrl: string | null } {
  // Precedence for old or hand-edited URLs: id > focus > boundary > source/sink
  const ids = params.getAll('id').filter(id => id !== '');
  if (ids.length > 0) {
    const rawDir = params.get('dir') as IdDirection | null;
    const dir = rawDir && ID_DIRECTIONS.includes(rawDir) ? rawDir : 'none';
    const label = params.get('label') ?? ids[0];
    return { intent: exactIntent(ids, dir, label, { type: 'guide' }), focusUrl: null };
  }
  const focus = params.get('focus');
  if (focus) return { intent: NONE_INTENT, focusUrl: focus };
  const bSource = params.get('boundary-source');
  const bTarget = params.get('boundary-target');
  if (bSource && bTarget) return { intent: boundaryIntent(bSource, bTarget), focusUrl: null };
  return {
    intent: textIntent(params.get('source') ?? '', params.get('sink') ?? ''),
    focusUrl: null,
  };
}

/**
 * Build the whole state from `defaults` plus the URL. `defaults` is not
 * mutated. `graph` resolves the legacy `hidden` param (display names).
 */
export function readURLState(
  params: URLSearchParams,
  defaults: FilterOptions,
  graph: D3Graph | null,
): ParsedURLState {
  const filters: FilterOptions = {
    ...defaults,
    selectedNodes: new Set(),
    expandedNodes: new Set(),
    hiddenNodes: new Set(),
  };

  const { intent, focusUrl } = readIntent(params);
  filters.intent = intent;
  for (const id of params.getAll('sel')) if (id) filters.selectedNodes.add(id);

  if (params.has('files')) filters.includeFiles = params.get('files')!;
  if (params.has('depth')) {
    const depth = parseInt(params.get('depth')!);
    if (depth === 0) filters.maxDepth = null;
    else if (!isNaN(depth) && depth > 0) filters.maxDepth = depth;
  }

  const readBool = (key: string, apply: (v: boolean) => void) => {
    if (!params.has(key)) return;
    const val = params.get(key)!.toLowerCase();
    apply(val === '1' || val === 'true');
  };
  readBool('exec', v => { filters.showExecFunctions = v; });
  readBool('proof', v => { filters.showProofFunctions = v; });
  readBool('spec', v => { filters.showSpecFunctions = v; });
  readBool('axioms', v => { filters.showAxioms = v; });
  readBool('types', v => { filters.showTypes = v; });
  readBool('proj', v => { filters.showProjections = v; });
  readBool('inst', v => { filters.showInstances = v; });
  readBool('inner', v => { filters.showInnerCalls = v; });
  readBool('pre', v => { filters.showPreconditionCalls = v; });
  readBool('post', v => { filters.showPostconditionCalls = v; });
  readBool('mapping', v => { filters.showMappingLinks = v; });
  readBool('speclinks', v => { filters.showSpecLinks = v; });
  readBool('statement', v => { filters.showStatementDeps = v; });
  readBool('body', v => { filters.showBodyDeps = v; });
  readBool('libsignal', v => { filters.showLibsignal = v; });
  readBool('external', v => { filters.showNonLibsignal = v; });
  readBool('rust', v => { filters.showRustNodes = v; });
  readBool('lean', v => { filters.showLeanNodes = v; });
  readBool('verified', v => { filters.showVerifiedNodes = v; });
  readBool('failed', v => { filters.showFailedNodes = v; });
  readBool('unverified', v => { filters.showUnverifiedNodes = v; });
  // An exact set overrides the three toggles; they are derived from it
  if (params.has('status')) {
    const statuses = params.get('status')!.split(',').map(s => s.trim()).filter(isVerificationStatus);
    if (statuses.length > 0) Object.assign(filters, exactStatusFilter(statuses));
  }

  if (params.has('excludeName')) filters.excludeNamePatterns = params.get('excludeName')!;
  if (params.has('excludePath')) filters.excludePathPatterns = params.get('excludePath')!;

  for (const id of params.getAll('hide')) if (id) filters.hiddenNodes.add(id);
  // Legacy format, told apart by the param name: comma-joined display
  // names, each resolved to its first match
  if (params.has('hidden') && graph) {
    const names = params.get('hidden')!.split(',').map(s => s.trim()).filter(s => s);
    for (const name of names) {
      const node = graph.nodes.find(n => n.display_name === name);
      if (node) filters.hiddenNodes.add(node.id);
    }
  }

  const viewParam = params.get('view');
  // `view=blueprint` is the File Map's id before the blueprint layer
  const view: ActiveView = viewParam === 'file-map' || viewParam === 'blueprint' ? 'file-map'
    : viewParam === 'crate-map' || viewParam === 'hierarchy' ? viewParam
    : 'callgraph';

  const layerParam = params.get('layer');
  const layer: Layer | null = layerParam === 'code' || layerParam === 'blueprint' ? layerParam : null;

  return {
    filters,
    view,
    layer,
    sourceCrate: params.get('source-crate') ?? '',
    targetCrate: params.get('target-crate') ?? '',
    hierarchyExpanded: params.has('expanded')
      ? params.get('expanded')!.split(',').map(s => s.trim()).filter(s => s)
      : [],
    focusUrl,
    entrypointsUrl: params.get('entrypoints'),
  };
}
