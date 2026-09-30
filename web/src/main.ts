import { D3Graph, D3Node, GraphState, FilterOptions, ProjectLanguage, BLUEPRINT_LANGUAGE, crateMapLabel, crateNoun, detectProjectLanguage, getKindSetsForLanguage, extractCrateName, isSchema2Envelope } from './types';
import { blueprintBackrefHtml, blueprintNodeDetailsHtml } from './blueprint-details';
import { applyFilters, getCallers, getCallees } from './filters';
import {
  compileQuery, GraphQuery, NodeMatcher, filterLinksByType, linkTypeShown, roleFilteredGraph,
  compileSeededDisplayPredicate,
} from './query';
import { computeSeedTiers, expandFromSeeds, SeedTier, SeedExpansion } from './graph-utils';
import { CallGraphVisualization } from './graph';
import { FileMapVisualization } from './file-map';
import { CrateMapVisualization, buildCrateGraph } from './crate-map';
import { HierarchyMapVisualization } from './hierarchy-map';
import { computeDerivedStatuses } from './status';
import { parseAndNormalizeGraph, pickSourceConfig } from './graph-loader';
import { escapeHtml } from './html';
import { StatusGroup, exactStatusFilter, groupCheckState, withGroupChecked } from './status-filter';
import {
  QueryIntent, NONE_INTENT, textIntent, focusIntent, boundaryIntent,
  isFocusIntent, inputsForIntent, intentAfterInputEdit, vscodeIntent, vscodeSetQueryIntent,
} from './intent';
import { ActiveView, Layer, defaultFilters, readURLState, writeURLState } from './url-state';

import { GuidePanel } from './guide/guide-panel';
import { buildGraphSummary } from './guide/static-analysis';
import type { GuideActions, GuideResult, GuideTransition } from './guide/types';

// ============================================================================
// JSON Format Conversion (delegated to graph-loader.ts)
// ============================================================================

// Legacy aliases kept for backward compatibility within this file.
// The actual implementations now live in graph-loader.ts.

// ============================================================================
// VS Code Integration
// ============================================================================

/**
 * VS Code API interface for webview communication
 */
interface VSCodeAPI {
  postMessage(message: any): void;
  getState(): any;
  setState(state: any): void;
}

/**
 * Check if running inside VS Code webview
 */
function isVSCodeEnvironment(): boolean {
  return typeof (window as any).acquireVsCodeApi === 'function';
}

/**
 * Get VS Code API if available
 */
let vscodeApi: VSCodeAPI | null = null;
function getVSCodeAPI(): VSCodeAPI | null {
  if (vscodeApi) return vscodeApi;
  if (isVSCodeEnvironment()) {
    vscodeApi = (window as any).acquireVsCodeApi();
    return vscodeApi;
  }
  return null;
}

/**
 * Send a message to the VS Code extension
 */
function postMessageToExtension(message: any): void {
  const api = getVSCodeAPI();
  if (api) {
    api.postMessage(message);
  }
}

/**
 * Navigate to a file in VS Code (or GitHub in web mode)
 */
function navigateToSource(node: D3Node): void {
  const api = getVSCodeAPI();
  if (api) {
    // In VS Code: send message to extension to open the file
    const loc = sourceLocation(node);
    if (!loc) return;
    api.postMessage({
      type: 'navigate',
      relativePath: loc.path,
      startLine: loc.start,
      endLine: loc.end,
      displayName: node.display_name
    });
  } else {
    // In web mode: open GitHub link if available
    const githubLink = buildGitHubLink(node);
    if (githubLink) {
      window.open(githubLink, '_blank');
    }
  }
}

// GitHub URL for source code links (configurable via env var, URL param, or graph metadata)
// Priority: URL param > graph metadata > env var
let githubBaseUrl: string | null = import.meta.env.VITE_GITHUB_URL || null;

// Branch name for GitHub blob links (defaults to 'main')
const githubBranch: string = import.meta.env.VITE_GITHUB_BRANCH || 'main';

// Path prefix to prepend to relative_path when building GitHub links
// (e.g., "curve25519-dalek" if repo structure is repo/curve25519-dalek/src/...)
let githubPathPrefix: string = import.meta.env.VITE_GITHUB_PATH_PREFIX || '';

// Performance threshold: if graph exceeds either limit, start with empty view
// to avoid browser freeze. User must apply a filter first.
const LARGE_GRAPH_LINK_THRESHOLD = 10000;
const LARGE_GRAPH_NODE_THRESHOLD = 2000;

// File size threshold (in bytes) - files larger than this won't auto-load.
// This gate is about loading, not rendering: JSON.parse on large files freezes
// the browser. The seeded initial view bounds rendering, so auto-load is safe
// up to this cap; anything bigger stays behind the explicit "Load & Search" path.
const LARGE_FILE_SIZE_THRESHOLD = 10 * 1024 * 1024;

// Track if we're deferring load due to large file
let deferredGraphUrl: string | null = null;

// Prevent multiple simultaneous deferred graph loads
let isDeferredLoadInProgress = false;

// A ?focus= load in flight. The intent stays 'none' until it resolves; the
// URL keeps focus= meanwhile. The load is dropped if intentGeneration moved.
let pendingFocus: { url: string; generation: number } | null = null;
// Resolved focus sets by URL, so back to a focus= URL does not refetch.
// Cleared per loadGraph(): resolution depends on the graph.
const focusCache = new Map<string, { ids: string[]; label: string }>();
// Bumped by every intent change (setIntent, stateFromURL, a node click that
// changes a 'none' query). Async loads that write the intent capture it.
let intentGeneration = 0;
// While > 0, updateURLWithFilters() does nothing: setIntent and popstate
// make exactly one history write of their own.
let urlWritesSuppressed = 0;

// Entry-points URL (from ?entrypoints= URL parameter): a probe-leanblueprint
// JSON whose blueprint-label-carrying atoms seed the initial view of a large
// graph. ?focus= takes precedence when both are present.
let entrypointsJsonUrl: string | null = null;
// Parsed ?entrypoints= payload for the current graph: seeds are the
// blueprint-labeled atom IDs intersected with the graph, labeled is the
// payload's total (for the matched/unmatched banner). Reset per loadGraph().
let entrypointsParam: { seeds: string[]; labeled: number } | null = null;
// Why the ?entrypoints= payload is not seeding (fetch failure, zero matches,
// ?focus= precedence); surfaced in the seeded-view banner.
let entrypointsParamNote: string | null = null;
// Set when ?focus= deferred the ?entrypoints= fetch; clearing the focus set
// resumes it (resumeDeferredEntrypoints).
let entrypointsDeferredByFocus = false;
// Incremented on every loadGraph(). Async fetches (loadEntryPointsSet) capture
// it and recheck before committing, so a late response can neither apply to a
// different graph nor overwrite newer query intent.
let graphLoadGeneration = 0;

// Debounce timer for search inputs
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const SEARCH_DEBOUNCE_MS = 300; // Wait 300ms after user stops typing

/**
 * Debounced version of applyFiltersAndUpdate for large graphs.
 * Prevents UI freeze from filtering on every keystroke.
 */
function debouncedApplyFilters(): void {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }
  searchDebounceTimer = setTimeout(() => {
    applyFiltersAndUpdate();
  }, SEARCH_DEBOUNCE_MS);
}

/**
 * Show a message in the stats panel for large graphs that need filtering
 */
function showLargeGraphPrompt(fileSize: number): void {
  const statsDiv = document.getElementById('stats');
  if (statsDiv) {
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
    statsDiv.innerHTML = `
      <div style="background: #fff3e0; padding: 12px; border-radius: 4px; margin-bottom: 8px;">
        <div style="color: #e65100; font-weight: bold; margin-bottom: 8px;">Large Graph Detected (${sizeMB} MB)</div>
        <p style="margin: 0 0 8px 0; font-size: 0.9rem; color: var(--pg-text);">
          Enter a <strong>Source</strong>, <strong>Sink</strong>, or <strong>Include Files</strong> filter, then press <strong>Enter</strong> or click <strong>Load & Search</strong>.
        </p>
        <button id="load-graph-btn" style="background: var(--pg-accent); color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 0.9rem;">
          Load & Search
        </button>
      </div>
    `;
    
    // Add click handler for the button
    document.getElementById('load-graph-btn')?.addEventListener('click', () => {
      loadDeferredGraph();
    });
  }
}


/**
 * Build a full-path string from a relative_path and optional prefix,
 * avoiding duplication when the path already starts with the prefix.
 */
function buildFullPath(relativePath: string, prefix: string): string {
  const cleanPrefix = prefix.replace(/^\/|\/$/g, '');
  if (!cleanPrefix) return relativePath;
  if (relativePath.startsWith(cleanPrefix + '/') || relativePath === cleanPrefix) {
    return relativePath;
  }
  return `${cleanPrefix}/${relativePath}`;
}

/**
 * Append #L<start>-L<end> line-number fragment to a link.
 */
function appendLineFragment(link: string, start?: number, end?: number): string {
  if (!start) return link;
  link += `#L${start}`;
  if (end && end > start) link += `-L${end}`;
  return link;
}

/**
 * Build a GitHub link to the source code.
 * Prefers per-language source configs from the Schema 2.0 envelope,
 * falling back to the global githubBaseUrl / githubBranch / githubPathPrefix.
 */
function buildGitHubLink(node: D3Node): string | null {
  const loc = sourceLocation(node);
  if (!loc) return null;

  // Try per-language source config (from Schema 2.0 envelope metadata)
  if (loc.language && state.fullGraph?.metadata.source_configs) {
    const config = pickSourceConfig(state.fullGraph.metadata.source_configs, loc.language, loc.path);
    if (config) {
      const fullPath = buildFullPath(loc.path, config.path_prefix);
      const link = `${config.github_url}/blob/${config.ref}/${fullPath}`;
      return appendLineFragment(link, loc.start, loc.end);
    }
  }

  // Fallback: global settings
  if (!githubBaseUrl) return null;
  const baseUrl = githubBaseUrl.replace(/\/$/, '');
  const fullPath = buildFullPath(loc.path, githubPathPrefix);
  const link = `${baseUrl}/blob/${githubBranch}/${fullPath}`;
  return appendLineFragment(link, loc.start, loc.end);
}

interface SourceLocation {
  path: string;
  start?: number;
  end?: number;
  /** Language whose source config the path resolves against. */
  language?: string;
}

/**
 * Where a node's source is. A blueprint entry's relative_path is its
 * chapter, so it points at the entry's Lean declaration site instead.
 */
function sourceLocation(node: D3Node): SourceLocation | null {
  if (node.language === BLUEPRINT_LANGUAGE) {
    const bp = node.blueprint;
    if (!bp?.sourcePath) return null;
    return { path: bp.sourcePath, start: bp.sourceLines?.start, end: bp.sourceLines?.end, language: 'lean' };
  }
  if (!node.relative_path) return null;
  return { path: node.relative_path, start: node.start_line, end: node.end_line, language: node.language };
}

/**
 * Generate a shareable URL with current filter state
 */
function generateShareableURL(): string {
  const url = new URL(window.location.href);
  writeURLState(url.searchParams, {
    filters: state.filters,
    view: activeView,
    sourceCrate: selectedSourceCrate,
    targetCrate: selectedTargetCrate,
    hierarchyExpanded,
    pendingFocusUrl: pendingFocus?.url ?? null,
    entrypointsUrl: entrypointsJsonUrl,
    projectLanguage: state.projectLanguage,
    // Before a graph loads it is unknown whether it has a blueprint layer
    layer: !codeLayer ? urlLayer()
      : blueprintLayer && activeLayer !== DEFAULT_LAYER ? activeLayer : null,
  });
  return url.toString();
}

/**
 * Sync every filter control (inputs, checkboxes, slider, crate dropdowns,
 * focus indicator) to state.filters.
 */
function syncFilterUI(): void {
  const setInput = (id: string, value: string) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = value;
  };
  const setCheckbox = (id: string, checked: boolean) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.checked = checked;
  };

  syncIntentInputs();
  setInput('exclude-name-patterns', state.filters.excludeNamePatterns);
  setInput('exclude-path-patterns', state.filters.excludePathPatterns);
  setInput('include-files', state.filters.includeFiles);
  updateFileListSelection();
  syncDepthSliderUI(state.filters.maxDepth);

  setCheckbox('show-exec-functions', state.filters.showExecFunctions);
  setCheckbox('show-proof-functions', state.filters.showProofFunctions);
  setCheckbox('show-spec-functions', state.filters.showSpecFunctions);
  setCheckbox('show-axioms', state.filters.showAxioms);
  setCheckbox('show-types', state.filters.showTypes);
  setCheckbox('show-projections', state.filters.showProjections);
  setCheckbox('show-instances', state.filters.showInstances);
  setCheckbox('show-inner-calls', state.filters.showInnerCalls);
  setCheckbox('show-precondition-calls', state.filters.showPreconditionCalls);
  setCheckbox('show-postcondition-calls', state.filters.showPostconditionCalls);
  setCheckbox('show-mapping-links', state.filters.showMappingLinks);
  setCheckbox('show-spec-links', state.filters.showSpecLinks);
  setCheckbox('show-statement-deps', state.filters.showStatementDeps);
  setCheckbox('show-body-deps', state.filters.showBodyDeps);
  setCheckbox('show-libsignal', state.filters.showLibsignal);
  setCheckbox('show-non-libsignal', state.filters.showNonLibsignal);
  setCheckbox('show-rust-nodes', state.filters.showRustNodes);
  setCheckbox('show-lean-nodes', state.filters.showLeanNodes);
  syncStatusCheckboxes();
  updateFocusIndicator();
}

const STATUS_CHECKBOXES: [string, StatusGroup][] = [
  ['show-verified-nodes', 'verified'],
  ['show-failed-nodes', 'failed'],
  ['show-unverified-nodes', 'unverified'],
];

/**
 * Status checkboxes; a group partly covered by an exact status set shows as
 * indeterminate and unchecked, so a click selects the whole group.
 */
function syncStatusCheckboxes(): void {
  for (const [id, group] of STATUS_CHECKBOXES) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) continue;
    const s = groupCheckState(state.filters, group);
    el.checked = s === 'on';
    el.indeterminate = s === 'partial';
  }
}

/**
 * Write the source/sink inputs and crate dropdowns from the intent. Exact
 * labels are marked and carry the full ID in the tooltip. On the Call Graph
 * both dropdowns are set iff the intent is a boundary.
 */
function syncIntentInputs(): void {
  const intent = state.filters.intent;
  const inputs = inputsForIntent(intent);
  const exactTitle = intent.kind === 'ids' ? intent.ids.join('\n') : '';
  const sync = (id: string, value: string, exact: boolean) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    if (el.value !== value) el.value = value;  // keep the caret while typing
    el.classList.toggle('exact-query', exact);
    el.title = exact ? exactTitle : '';
  };
  sync('source-input', inputs.source, inputs.sourceExact);
  sync('sink-input', inputs.sink, inputs.sinkExact);

  if (activeView !== 'crate-map') {
    if (intent.kind === 'boundary') {
      selectedSourceCrate = intent.sourceGroup;
      selectedTargetCrate = intent.targetGroup;
    } else if (selectedSourceCrate && selectedTargetCrate) {
      // A complete pair only exists as a boundary intent; staged single
      // selections survive
      selectedSourceCrate = '';
      selectedTargetCrate = '';
    }
    populateCrateDropdowns();
  }
}

/**
 * The single entry point for intent changes. Clears click selection and any
 * pending focus load, bumps the generation, syncs the inputs, applies, and
 * makes exactly one history write.
 *
 * `pushed` marks the new history entry as a discrete action (Guide): the
 * next input edit pushes instead of replacing it. Defaults to
 * `history === 'push'`; typing pushes without marking.
 */
function setIntent(
  intent: QueryIntent,
  opts: {
    history: 'push' | 'replace';
    pushed?: boolean;
    debounce?: boolean;
    before?: () => void;  // further state changes committed with the intent
  },
): void {
  urlWritesSuppressed++;
  try {
    state.filters.intent = intent;
    state.filters.selectedNodes.clear();
    state.selectedNode = null;
    pendingFocus = null;
    intentGeneration++;
    lastSelectionKey = '';
    opts.before?.();
    syncIntentInputs();
    updateFocusIndicator();
    if (!isFocusIntent(intent)) resumeDeferredEntrypoints();

    if (opts.debounce && state.fullGraph && isLargeGraph(state.fullGraph)) {
      debouncedApplyFilters();
    } else {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      applyFiltersAndUpdate();
    }
  } finally {
    urlWritesSuppressed--;
  }

  // The URL is built from state, not from the render, so a debounced
  // apply's own replaceState later writes this same URL.
  const url = generateShareableURL();
  const marker = { pushed: opts.pushed ?? opts.history === 'push' };
  if (opts.history === 'push') window.history.pushState(marker, '', url);
  else window.history.replaceState(marker, '', url);
}

/** History mode for an input edit: push once over a pushed (Guide) entry. */
function inputEditHistory(): 'push' | 'replace' {
  return window.history.state?.pushed ? 'push' : 'replace';
}

/** A copy of `f` whose Sets are not shared with it. */
function freshFilters(f: FilterOptions): FilterOptions {
  return {
    ...f,
    selectedNodes: new Set(f.selectedNodes),
    expandedNodes: new Set(f.expandedNodes),
    hiddenNodes: new Set(f.hiddenNodes),
  };
}

/** Filter defaults for the loaded graph (initialFilters plus per-language call types). */
let graphDefaultFilters: FilterOptions | null = null;

/** Order-independent key of the click selection, to detect selection changes. */
function selectionKey(ids: Set<string>): string {
  return [...ids].sort().join('\0');
}
let lastSelectionKey = '';

/**
 * Build the whole state from the graph defaults plus the URL. Shared by
 * loadGraph() and popstate, so reload and back restore the same thing. Not
 * restored: expanded nodes and the node shown in the details panel.
 * Returns a ?focus= URL still to be loaded (not in the focus cache).
 */
function stateFromURL(): { focusUrl: string | null; view: ActiveView; layerChanged: boolean } {
  // The layer decides the graph and its defaults, so it is set first
  const layer = layerFromURL();
  const layerChanged = layer !== activeLayer;
  if (layerChanged) {
    inactiveLayerFilters = state.filters;
    showLayer(layer);
  }

  const parsed = readURLState(
    new URLSearchParams(window.location.search),
    graphDefaultFilters ?? freshFilters(initialFilters),
    state.fullGraph,
  );
  state.filters = parsed.filters;
  state.selectedNode = null;
  selectedSourceCrate = parsed.sourceCrate;
  selectedTargetCrate = parsed.targetCrate;
  hierarchyExpanded = parsed.hierarchyExpanded;
  pendingFocus = null;
  intentGeneration++;
  lastSelectionKey = selectionKey(state.filters.selectedNodes);
  // The seeded render derives the request from the restored depth
  seededRequestedDepth = null;

  let focusUrl = parsed.focusUrl;
  if (focusUrl) {
    const cached = focusCache.get(focusUrl);
    if (cached) {
      state.filters.intent = focusIntent(focusUrl, cached.ids, cached.label);
      focusUrl = null;
    } else {
      // Set before the first render so its URL write keeps focus=
      pendingFocus = { url: focusUrl, generation: intentGeneration };
    }
  }
  return { focusUrl, view: parsed.view, layerChanged };
}

/** Browser back/forward: restore from the URL without writing history. */
function handlePopState(): void {
  if (!state.fullGraph) return;
  const { focusUrl, view, layerChanged } = stateFromURL();
  urlWritesSuppressed++;
  try {
    if (view !== activeView) switchView(view, { apply: false });
    syncFilterUI();
    if (activeView === 'crate-map' && visualization instanceof CrateMapVisualization) {
      visualization.setBoundaryCrates(selectedSourceCrate || null, selectedTargetCrate || null);
    }
    if (!focusUrl && !isFocusIntent(state.filters.intent)) resumeDeferredEntrypoints();
    applyFiltersAndUpdate();
    if (layerChanged) {
      refreshGuidePanel();
      updateNodeInfo();
    }
    // After the apply, so the expansion is pruned against the restored
    // graph; an empty list is restored too (collapse everything)
    if (visualization instanceof HierarchyMapVisualization) {
      visualization.setExpanded(hierarchyExpanded);
    }
  } finally {
    urlWritesSuppressed--;
  }
  if (focusUrl) loadFocusSet(focusUrl);
}

/** Source/sink typing: a text intent from the inputs, applied debounced on large graphs. */
function handleIntentInput(edited: 'source' | 'sink'): void {
  const sourceEl = document.getElementById('source-input') as HTMLInputElement | null;
  const sinkEl = document.getElementById('sink-input') as HTMLInputElement | null;
  const intent = intentAfterInputEdit(
    state.filters.intent, edited, sourceEl?.value ?? '', sinkEl?.value ?? '',
  );
  if (!state.fullGraph) {
    // Deferred large graph: the URL carries the intent into loadGraph()
    state.filters.intent = intent;
    updateURLWithFilters();
    return;
  }
  setIntent(intent, { history: inputEditHistory(), pushed: false, debounce: true });
}

// Initialize state
const initialFilters: FilterOptions = defaultFilters();

let state: GraphState = {
  fullGraph: null,
  filteredGraph: null,
  // A copy: filters edited before a graph loads must not become the defaults
  filters: freshFilters(initialFilters),
  selectedNode: null,
  hoveredNode: null,
  projectLanguage: 'unknown',
};

let activeView: ActiveView = 'callgraph';

// The loaded graph's layers (see D3Graph.blueprintLayer); state.fullGraph is
// one of them. blueprintLayer is null for graphs without node atoms.
let codeLayer: D3Graph | null = null;
let blueprintLayer: D3Graph | null = null;
const DEFAULT_LAYER: Layer = 'blueprint';
let activeLayer: Layer = 'code';
// Filters of the layer not shown, restored when switching back to it
let inactiveLayerFilters: FilterOptions | null = null;

/** The layer the URL asks for; the default when absent or unavailable. */
function layerFromURL(): Layer {
  if (!blueprintLayer) return 'code';
  return urlLayer() ?? DEFAULT_LAYER;
}

/** The URL's `layer=`, whether or not the graph has that layer. */
function urlLayer(): Layer | null {
  return readURLState(new URLSearchParams(window.location.search), freshFilters(initialFilters), null).layer;
}

function replaceURLLayer(layer: Layer): void {
  const url = new URL(window.location.href);
  if (layer === DEFAULT_LAYER) url.searchParams.delete('layer');
  else url.searchParams.set('layer', layer);
  window.history.replaceState(window.history.state, '', url.toString());
}
let visualization: CallGraphVisualization | FileMapVisualization | CrateMapVisualization | HierarchyMapVisualization | null = null;

/** Views that aggregate the whole graph and so bypass the large-graph guards. */
function isAggregatedView(view: ActiveView): boolean {
  return view === 'crate-map' || view === 'hierarchy';
}

let hierarchyExpanded: string[] = [];
let selectedSourceCrate: string = '';
let selectedTargetCrate: string = '';
let crateDependencyMap: Map<string, Set<string>> = new Map();
let crateReverseDependencyMap: Map<string, Set<string>> = new Map();
let deferredComputationsDone = false;

// ============================================================================
// Guide Panel Integration
// ============================================================================

const guideActions: GuideActions = {
  apply: (t) => {
    lastRenderResult = null;
    applyGuideTransition(t);
    return lastRenderResult;
  },
};

// Size of the last Call Graph / File Map render, for the Guide's toast
let lastRenderResult: GuideResult | null = null;

/**
 * One Guide action: replaces the intent (and optionally status, depth,
 * view) in a single state transition with one pushed history entry. Kind,
 * language, include/exclude patterns and hidden nodes are never touched.
 */
function applyGuideTransition(t: GuideTransition): void {
  setIntent(t.intent, {
    history: 'push',
    before: () => {
      if (t.status) {
        Object.assign(state.filters, exactStatusFilter(t.status));
        syncStatusCheckboxes();
      }
      if (t.depth !== undefined) {
        state.filters.maxDepth = t.depth;
        seededRequestedDepth = t.depth !== null ? clampSeededDepth(t.depth) : null;
        syncDepthSliderUI(t.depth);
      }
      if (t.view && t.view !== activeView) {
        // setIntent applies right after, so skip switchView's own apply
        switchView(t.view, { apply: false });
      }
    },
  });
}

let guidePanel: GuidePanel | null = null;

function initGuidePanel(): void {
  if (guidePanel) return;
  guidePanel = new GuidePanel(guideActions);
}

// Kind and link type filters the Guide was last rendered with
let guideFilterKey = '';

/**
 * Re-render the Guide. Its rankings and chips only name nodes and links the
 * current kind and link type filters show; counts use the full graph.
 */
function refreshGuidePanel(opts: { onlyIfFiltersChanged?: boolean } = {}): void {
  if (!state.fullGraph || !guidePanel) return;
  const f = state.filters;
  const compiled = compileQuery(f, state.projectLanguage);
  const key = JSON.stringify([
    compiled.linkTypeFilter, f.showExecFunctions, f.showProofFunctions, f.showSpecFunctions,
    f.showAxioms, f.showTypes, f.showProjections, f.showInstances,
  ]);
  if (opts.onlyIfFiltersChanged && key === guideFilterKey) return;
  guideFilterKey = key;
  guidePanel.renderSummary(buildGraphSummary(state.fullGraph, {
    isCandidate: compiled.traversalPredicates.kindFilter,
    isLinkShown: link => linkTypeShown(link, compiled.linkTypeFilter),
    roleFilterActive: graphHasLinkRoles() && !(f.showStatementDeps && f.showBodyDeps),
  }));
}

/** Update all language-sensitive UI labels (button, legend, hints). */
function updateLanguageLabels(lang: ProjectLanguage): void {
  const noun = crateNoun(lang);
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const mapLabel = crateMapLabel(lang);

  const crateMapBtn = document.getElementById('view-crate-map');
  if (crateMapBtn) crateMapBtn.textContent = mapLabel;

  const title = document.getElementById('crate-boundary-title');
  if (title) title.textContent = `${Noun} Boundary`;

  const srcLabel = document.getElementById('source-crate-label');
  if (srcLabel) srcLabel.textContent = `Source ${Noun} (caller):`;

  const tgtLabel = document.getElementById('target-crate-label');
  if (tgtLabel) tgtLabel.textContent = `Target ${Noun} (callee):`;

  const hint = document.getElementById('crate-boundary-hint');
  if (hint) {
    hint.innerHTML =
      `Select two ${noun}s to see the <strong>boundary</strong>: functions in the source ${noun} that call the target ${noun}.<br>` +
      `In ${mapLabel}: click a ${noun} to set source, click another to set target.`;
  }
}

/**
 * Show the URL's state before a graph loads, so a deferred large graph's
 * Load & Search sees a shared query and URL writes while deferred keep it.
 * loadGraph() reads the URL again against the graph.
 */
function applyURLBeforeLoad(): void {
  const parsed = readURLState(new URLSearchParams(window.location.search), freshFilters(initialFilters), null);
  state.filters = parsed.filters;
  selectedSourceCrate = parsed.sourceCrate;
  selectedTargetCrate = parsed.targetCrate;
  hierarchyExpanded = parsed.hierarchyExpanded;
  entrypointsJsonUrl = parsed.entrypointsUrl;
  pendingFocus = parsed.focusUrl ? { url: parsed.focusUrl, generation: intentGeneration } : null;
  syncFilterUI();
}

/**
 * Initialize the application
 */
function init(): void {
  const graphContainer = document.getElementById('graph-container');
  if (!graphContainer) {
    console.error('Graph container not found');
    return;
  }

  // Check URL for initial view
  const urlParams = new URLSearchParams(window.location.search);
  const viewParam = urlParams.get('view');
  if (viewParam === 'file-map' || viewParam === 'blueprint') {
    activeView = 'file-map';
  } else if (viewParam === 'crate-map') {
    activeView = 'crate-map';
  } else if (viewParam === 'hierarchy') {
    activeView = 'hierarchy';
  }

  // Initialize visualization for the active view
  createVisualization(graphContainer);

  // Set up UI event handlers
  setupUIHandlers();
  
  applyURLBeforeLoad();

  // Update stats display
  updateStats();
  updateNodeInfo();

  // Setup VS Code integration if running in webview
  setupVSCodeIntegration();

  // Initialize the guide panel
  initGuidePanel();

  // Try to auto-load graph.json if it exists (skipped in VS Code mode)
  if (!isVSCodeEnvironment()) {
    autoLoadGraph();
  }
}

/**
 * Create the visualization for the active view, destroying the previous one.
 */
function createVisualization(container: HTMLElement): void {
  // Destroy existing visualization
  if (visualization) {
    if ('destroy' in visualization) {
      (visualization as FileMapVisualization | CrateMapVisualization | HierarchyMapVisualization).destroy();
    } else {
      visualization.clear();
      container.querySelector('svg')?.remove();
    }
    visualization = null;
  }

  // Remove any leftover view legends
  container.querySelector('.bp-legend')?.remove();
  container.querySelector('.cm-legend')?.remove();
  container.querySelector('.hm-legend')?.remove();

  // Update button states
  document.getElementById('view-callgraph')?.classList.toggle('active', activeView === 'callgraph');
  document.getElementById('view-file-map')?.classList.toggle('active', activeView === 'file-map');
  document.getElementById('view-crate-map')?.classList.toggle('active', activeView === 'crate-map');
  document.getElementById('view-hierarchy')?.classList.toggle('active', activeView === 'hierarchy');

  if (activeView === 'crate-map') {
    visualization = new CrateMapVisualization(container, state, handleStateChange);
  } else if (activeView === 'hierarchy') {
    const viz = new HierarchyMapVisualization(container, state, handleStateChange);
    if (hierarchyExpanded.length > 0) viz.setExpanded(hierarchyExpanded);
    visualization = viz;
  } else if (activeView === 'file-map') {
    visualization = new FileMapVisualization(container, state, handleStateChange);
  } else {
    visualization = new CallGraphVisualization(container, state, handleStateChange);
  }
}

/**
 * Switch between call graph and blueprint views.
 * With `apply: false` the caller applies filters itself right after.
 */
function switchView(view: ActiveView, opts: { apply?: boolean } = {}): void {
  if (view === activeView) return;
  activeView = view;

  const graphContainer = document.getElementById('graph-container');
  if (!graphContainer) return;

  createVisualization(graphContainer);
  if (opts.apply === false) return;

  // Re-apply filters: Crate Map bypasses the large-graph guard, so the
  // previously cached filteredGraph may be empty.  Re-running ensures the
  // new view gets an appropriate result set.
  if (state.fullGraph) {
    applyFiltersAndUpdate();
  } else if (state.filteredGraph) {
    visualization?.update(state.filteredGraph);
  }

  updateURLWithFilters();
}

/**
 * Set up UI event handlers
 */
function setupUIHandlers(): void {
  // View switcher
  document.getElementById('view-callgraph')?.addEventListener('click', () => switchView('callgraph'));
  document.getElementById('view-file-map')?.addEventListener('click', () => switchView('file-map'));
  document.getElementById('view-crate-map')?.addEventListener('click', () => switchView('crate-map'));
  document.getElementById('view-hierarchy')?.addEventListener('click', () => switchView('hierarchy'));
  document.getElementById('layer-blueprint')?.addEventListener('click', () => switchLayer('blueprint'));
  document.getElementById('layer-code')?.addEventListener('click', () => switchLayer('code'));

  // Keep the ?expanded= URL parameter in sync with the Hierarchy view
  window.addEventListener('hierarchy-expanded-changed', ((event: CustomEvent) => {
    hierarchyExpanded = event.detail.expanded ?? [];
    updateURLWithFilters();
  }) as EventListener);

  // Listen for crate-map navigation events (double-click crate or "View in Call Graph")
  window.addEventListener('crate-map-switch-view', ((event: CustomEvent) => {
    const { view, includeFiles, sourceGroup, targetGroup } = event.detail;
    if (includeFiles) {
      state.filters.includeFiles = includeFiles;
      const includeFilesInput = document.getElementById('include-files') as HTMLInputElement;
      if (includeFilesInput) includeFilesInput.value = includeFiles;
    }
    if (sourceGroup || targetGroup) {
      // Both groups: an exact boundary. One group: today's crate: text query.
      const intent = sourceGroup && targetGroup
        ? boundaryIntent(sourceGroup, targetGroup)
        : textIntent(sourceGroup ? `crate:${sourceGroup}` : '', targetGroup ? `crate:${targetGroup}` : '');
      setIntent(intent, { history: 'replace', before: () => switchView(view, { apply: false }) });
      return;
    }
    switchView(view);
    applyFiltersAndUpdate();
  }) as EventListener);

  // Crate boundary dropdown handlers
  const handleSourceCrateChange = () => {
    const srcSel = document.getElementById('source-crate-select') as HTMLSelectElement | null;
    selectedSourceCrate = srcSel?.value || '';
    populateCrateDropdowns();
    selectedTargetCrate = (document.getElementById('target-crate-select') as HTMLSelectElement | null)?.value || '';
    triggerBoundaryUpdate();
  };

  const handleTargetCrateChange = () => {
    const tgtSel = document.getElementById('target-crate-select') as HTMLSelectElement | null;
    selectedTargetCrate = tgtSel?.value || '';
    populateCrateDropdowns();
    selectedSourceCrate = (document.getElementById('source-crate-select') as HTMLSelectElement | null)?.value || '';
    triggerBoundaryUpdate();
  };

  function triggerBoundaryUpdate(): void {
    if (activeView === 'crate-map' && visualization instanceof CrateMapVisualization) {
      visualization.setBoundaryCrates(
        selectedSourceCrate || null,
        selectedTargetCrate || null,
      );
    } else if (selectedSourceCrate && selectedTargetCrate) {
      setIntent(boundaryIntent(selectedSourceCrate, selectedTargetCrate), { history: 'replace' });
      return;
    } else if (state.filters.intent.kind === 'boundary') {
      // Clearing either dropdown ends the boundary; one set is staged UI state
      setIntent(NONE_INTENT, { history: 'replace' });
      return;
    }
    updateURLWithFilters();
  }

  document.getElementById('source-crate-select')?.addEventListener('change', handleSourceCrateChange);
  document.getElementById('target-crate-select')?.addEventListener('change', handleTargetCrateChange);

  // Sync module state when CrateMap updates boundary from click interactions
  window.addEventListener('crate-boundary-changed', ((event: CustomEvent) => {
    selectedSourceCrate = event.detail.source || '';
    selectedTargetCrate = event.detail.target || '';
    populateCrateDropdowns();
    updateURLWithFilters();
  }) as EventListener);

  // File input
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  fileInput?.addEventListener('change', handleFileLoad);

  // Filter controls
  document.getElementById('show-libsignal')?.addEventListener('change', (e) => {
    state.filters.showLibsignal = (e.target as HTMLInputElement).checked;
    applyFiltersAndUpdate();
  });

  document.getElementById('show-non-libsignal')?.addEventListener('change', (e) => {
    state.filters.showNonLibsignal = (e.target as HTMLInputElement).checked;
    applyFiltersAndUpdate();
  });

  // Verification status filters
  for (const [id, group] of STATUS_CHECKBOXES) {
    document.getElementById(id)?.addEventListener('change', (e) => {
      Object.assign(state.filters, withGroupChecked(state.filters, group, (e.target as HTMLInputElement).checked));
      syncStatusCheckboxes();
      applyFiltersAndUpdate();
    });
  }

  // Call type filters are set up dynamically in renderCallTypeFilters()
  // Declaration kind filters are set up dynamically in renderKindFilters()
  // after graph load detects the project language.

  // Exclude name patterns input
  document.getElementById('exclude-name-patterns')?.addEventListener('input', (e) => {
    state.filters.excludeNamePatterns = (e.target as HTMLInputElement).value;
    if (state.fullGraph) {
      if (isLargeGraph(state.fullGraph)) {
        debouncedApplyFilters();
      } else {
        applyFiltersAndUpdate();
      }
    }
  });

  // Exclude path patterns input
  document.getElementById('exclude-path-patterns')?.addEventListener('input', (e) => {
    state.filters.excludePathPatterns = (e.target as HTMLInputElement).value;
    if (state.fullGraph) {
      if (isLargeGraph(state.fullGraph)) {
        debouncedApplyFilters();
      } else {
        applyFiltersAndUpdate();
      }
    }
  });

  // Exclude path presets dropdown - adds selected pattern to the exclude path patterns field
  document.getElementById('exclude-path-presets')?.addEventListener('change', (e) => {
    const select = e.target as HTMLSelectElement;
    const preset = select.value;
    if (preset) {
      const excludeInput = document.getElementById('exclude-path-patterns') as HTMLInputElement;
      const currentPatterns = excludeInput.value.trim();
      
      // Add preset patterns (avoid duplicates)
      const existingPatterns = currentPatterns ? currentPatterns.split(',').map(p => p.trim()) : [];
      const presetPatterns = preset.split(',').map(p => p.trim());
      
      for (const p of presetPatterns) {
        if (!existingPatterns.includes(p)) {
          existingPatterns.push(p);
        }
      }
      
      excludeInput.value = existingPatterns.join(', ');
      state.filters.excludePathPatterns = excludeInput.value;
      
      // Reset dropdown
      select.value = '';
      
      applyFiltersAndUpdate();
    }
  });

  document.getElementById('source-input')?.addEventListener('input', () => handleIntentInput('source'));
  
  // Handle Enter key to trigger immediate filter or deferred graph loading
  document.getElementById('source-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (deferredGraphUrl) {
        loadDeferredGraph();
      } else if (state.fullGraph) {
        // Cancel debounce and apply immediately
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        applyFiltersAndUpdate();
      }
    }
  });

  document.getElementById('sink-input')?.addEventListener('input', () => handleIntentInput('sink'));
  
  // Handle Enter key to trigger immediate filter or deferred graph loading
  document.getElementById('sink-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (deferredGraphUrl) {
        loadDeferredGraph();
      } else if (state.fullGraph) {
        // Cancel debounce and apply immediately
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        applyFiltersAndUpdate();
      }
    }
  });

  document.getElementById('include-files')?.addEventListener('input', (e) => {
    state.filters.includeFiles = (e.target as HTMLInputElement).value;
    updateFileListSelection();  // Update file list checkmarks
    // Deferred large graph: the URL carries the pattern into loadGraph()
    if (!state.fullGraph) updateURLWithFilters();
    // Only auto-apply if graph is already loaded, use debounce for large graphs
    if (state.fullGraph) {
      if (isLargeGraph(state.fullGraph)) {
        debouncedApplyFilters();
      } else {
        applyFiltersAndUpdate();
      }
    }
  });
  
  // Handle Enter key to trigger immediate filter or deferred graph loading
  // Also check for ambiguous file patterns and show disambiguation dropdown
  document.getElementById('include-files')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      console.log('Enter pressed in include-files. deferredGraphUrl:', deferredGraphUrl, 'state.fullGraph:', !!state.fullGraph);
      
      // Hide any existing dropdown first
      hideDisambiguationDropdown();
      
      if (deferredGraphUrl) {
        // Graph not loaded yet - load it first, then check for disambiguation
        console.log('Loading deferred graph...');
        loadDeferredGraph();
      } else if (state.fullGraph) {
        // Check for ambiguous patterns before applying
        const hasAmbiguity = checkAndShowDisambiguation();
        if (!hasAmbiguity) {
          // No ambiguity - apply filters immediately
          if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
          applyFiltersAndUpdate();
        }
        // If ambiguous, dropdown is shown and user will select
      } else {
        console.log('No graph loaded and no deferred URL');
      }
    } else if (e.key === 'Escape') {
      // Allow Escape to close the dropdown
      hideDisambiguationDropdown();
    }
  });
  
  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('file-disambiguation-dropdown');
    const input = document.getElementById('include-files');
    if (dropdown && dropdown.style.display !== 'none') {
      const target = e.target as HTMLElement;
      if (!dropdown.contains(target) && target !== input) {
        hideDisambiguationDropdown();
      }
    }
  });

  document.getElementById('depth-limit')?.addEventListener('input', (e) => {
    const value = parseInt((e.target as HTMLInputElement).value);
    if (isSeededModeActive()) {
      // Seeded mode: validate the candidate view before mutating any state
      handleSeededDepthChange(value);
      return;
    }
    state.filters.maxDepth = value > 0 ? value : null;
    // Keep the seeded depth request in sync: this is what a return to the
    // seeded view (e.g. after clearing a search) will use.
    seededRequestedDepth = value > 0 ? clampSeededDepth(value) : null;
    document.getElementById('depth-value')!.textContent =
      state.filters.maxDepth !== null ? state.filters.maxDepth.toString() : 'All';
    applyFiltersAndUpdate();
  });

  document.getElementById('reset-filters')?.addEventListener('click', () => {
    resetFilters();
  });

  document.getElementById('clear-selection')?.addEventListener('click', () => {
    state.filters.selectedNodes.clear();
    state.selectedNode = null;
    applyFiltersAndUpdate();
  });

  document.getElementById('reset-view')?.addEventListener('click', () => {
    if (visualization instanceof CallGraphVisualization) {
      visualization.resetView();
    }
  });

  document.getElementById('show-all-hidden')?.addEventListener('click', () => {
    showAllHiddenNodes();
  });

  // Copy link button
  document.getElementById('copy-link')?.addEventListener('click', () => {
    const url = generateShareableURL();
    navigator.clipboard.writeText(url).then(() => {
      // Show feedback
      const btn = document.getElementById('copy-link') as HTMLButtonElement;
      const originalText = btn.textContent;
      btn.textContent = '✓ Copied!';
      btn.style.background = 'var(--pg-status-verified)';
      setTimeout(() => {
        btn.textContent = originalText;
        btn.style.background = '';
      }, 2000);
    }).catch(err => {
      console.error('Failed to copy link:', err);
      // Fallback: show URL in a prompt
      prompt('Copy this link:', url);
    });
  });

  // Window resize
  window.addEventListener('resize', handleResize);

  // Browser back/forward
  window.addEventListener('popstate', handlePopState);
}

/**
 * Auto-load graph from URL parameter, env var, or local graph.json
 * Priority: URL param > env var > local file
 */
async function autoLoadGraph(): Promise<void> {
  // Check for URL parameters (highest priority)
  const urlParams = new URLSearchParams(window.location.search);
  const jsonUrlParam = urlParams.get('json') || urlParams.get('url');
  
  // Check for GitHub URL parameter (overrides metadata and env var)
  const githubParam = urlParams.get('github');
  if (githubParam) {
    githubBaseUrl = githubParam;
  }
  
  // Check for GitHub path prefix parameter (e.g., "curve25519-dalek")
  const prefixParam = urlParams.get('github_prefix') || urlParams.get('prefix');
  if (prefixParam) {
    githubPathPrefix = prefixParam;
  }
  
  // Determine which JSON URL to use: URL param > env var > local file
  const jsonUrl = jsonUrlParam || import.meta.env.VITE_GRAPH_JSON_URL || null;
  
  if (jsonUrl) {
    try {
      console.log('Loading graph from URL:', jsonUrl);
      
      // Check file size first with HEAD request
      const headResponse = await fetch(jsonUrl, { method: 'HEAD' });
      const contentLength = parseInt(headResponse.headers.get('Content-Length') || '0');
      
      if (contentLength > LARGE_FILE_SIZE_THRESHOLD) {
        console.log(`Large file detected (${(contentLength / 1024 / 1024).toFixed(1)} MB), deferring load`);
        deferredGraphUrl = jsonUrl;
        showLargeGraphPrompt(contentLength);
        return;
      }
      
      const response = await fetch(jsonUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
      }

      const text = await response.text();

      // Yield to browser before heavy synchronous work so the UI stays responsive
      await new Promise(r => setTimeout(r, 0));

      const rawData = JSON.parse(text);
      const graph = parseAndNormalizeGraph(rawData);

      // Yield again before loadGraph (deep copy + initialization)
      await new Promise(r => setTimeout(r, 0));

      const source = jsonUrlParam ? 'URL parameter' : 'configured default';
      loadGraph(graph, `Loaded from ${source}: ${jsonUrl}`);
      return;
    } catch (error) {
      console.error('Failed to load graph from URL:', error);
      showError(`Failed to load graph from URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
      // Continue to try local graph.json
    }
  }
  
  // Fall back to local graph.json
  try {
    // Check file size first with HEAD request
    const headResponse = await fetch('./graph.json', { method: 'HEAD' });
    const contentLength = parseInt(headResponse.headers.get('Content-Length') || '0');
    
    console.log(`graph.json size: ${(contentLength / 1024 / 1024).toFixed(1)} MB`);
    
    if (contentLength > LARGE_FILE_SIZE_THRESHOLD && !isAggregatedView(activeView)) {
      console.log(`Large file detected, deferring load until user searches`);
      deferredGraphUrl = './graph.json';
      showLargeGraphPrompt(contentLength);
      return;
    }
    
    // Use relative path to work with GitHub Pages base URL
    const response = await fetch('./graph.json');
    
    if (!response.ok) {
      console.log('No graph.json found in public directory. Waiting for manual file load.');
      return;
    }

    const text = await response.text();

    // Yield to browser before heavy synchronous work so the UI stays responsive
    await new Promise(r => setTimeout(r, 0));

    const rawData = JSON.parse(text);
    const graph = parseAndNormalizeGraph(rawData);

    // Yield again before loadGraph (deep copy + initialization)
    await new Promise(r => setTimeout(r, 0));

    loadGraph(graph, 'Auto-loaded from local file');
  } catch (error) {
    console.log('Could not auto-load graph.json:', error);
    // Silently fail - user can still manually load a file
  }
}

/**
 * Load a deferred graph (for large files that weren't auto-loaded), then
 * check the Include Files pattern for ambiguity.
 * Only called when user explicitly requests it after entering a search query
 */
async function loadDeferredGraph(): Promise<void> {
  if (!deferredGraphUrl) return;
  
  // Prevent multiple simultaneous loads
  if (isDeferredLoadInProgress) {
    console.log('Deferred graph load already in progress, skipping');
    return;
  }
  
  // Check if user has entered a search query
  if (!hasSearchFilters()) {
    showError('Please enter a Source, Sink, or Include Files filter first to filter the large graph.');
    return;
  }
  
  isDeferredLoadInProgress = true;
  
  const statsDiv = document.getElementById('stats');
  if (statsDiv) {
    statsDiv.innerHTML = `
      <div style="padding: 1rem; text-align: center;">
        <div style="margin-bottom: 0.5rem;">⏳ Loading and filtering graph...</div>
        <div style="font-size: 0.8rem; color: var(--pg-text-muted);">This may take a few seconds...</div>
      </div>
    `;
  }
  
  try {
    const response = await fetch(deferredGraphUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status}`);
    }
    
    const text = await response.text();
    const rawData = JSON.parse(text);
    const graph = parseAndNormalizeGraph(rawData);
    
    deferredGraphUrl = null; // Clear the deferred URL

    // Include Files patterns name code files; source/sink text also matches blueprint labels
    const includeFiles = (document.getElementById('include-files') as HTMLInputElement | null)?.value.trim();
    loadGraph(graph, 'Loaded from deferred graph', includeFiles ? 'code' : undefined);
    // An ambiguous pattern includes every matching file until the user picks
    checkAndShowDisambiguation();
  } catch (error) {
    console.error('Failed to load deferred graph:', error);
    showError(`Failed to load graph: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    isDeferredLoadInProgress = false;
  }
}

/**
 * Check if graph is too large to render without filters
 */
function isLargeGraph(graph: D3Graph): boolean {
  return graph.links.length > LARGE_GRAPH_LINK_THRESHOLD ||
         graph.nodes.length > LARGE_GRAPH_NODE_THRESHOLD;
}

/**
 * Run heavy graph computations that are deferred for large graphs.
 * Called lazily when the user first applies a filter.
 */
function ensureCrateGraphBuilt(): void {
  if (crateDependencyMap.size > 0 || !state.fullGraph) return;
  const cg = buildCrateGraph(state.fullGraph);
  for (const edge of cg.edges) {
    let deps = crateDependencyMap.get(edge.source);
    if (!deps) {
      deps = new Set();
      crateDependencyMap.set(edge.source, deps);
    }
    deps.add(edge.target);

    let rdeps = crateReverseDependencyMap.get(edge.target);
    if (!rdeps) {
      rdeps = new Set();
      crateReverseDependencyMap.set(edge.target, rdeps);
    }
    rdeps.add(edge.source);
  }
}

function runDeferredComputations(): void {
  if (deferredComputationsDone || !state.fullGraph) return;
  deferredComputationsDone = true;

  computeDerivedStatuses(state.fullGraph);
  ensureCrateGraphBuilt();
  populateFileList();
}

/**
 * Check if user has specified meaningful filters (any query intent, include
 * files, language toggle, or node selection). Node selection counts: it
 * compiles to a depthFromSelected query, and without it a click on a
 * seeded-view node would exit seeded mode into an empty large-graph view.
 */
function hasSearchFilters(): boolean {
  return state.filters.intent.kind !== 'none' ||
         state.filters.includeFiles.trim() !== '' ||
         state.filters.selectedNodes.size > 0 ||
         state.filters.showRustNodes === false ||
         state.filters.showLeanNodes === false;
}

// ============================================================================
// Seeded initial view for large graphs
// ============================================================================

interface SeededViewInfo {
  tierName: SeedTier['name'];
  seedCount: number;
  shownNodes: number;
  shownLinks: number;
  depth: number;
  requestedDepth: number;
}

// Set while the current view is the entry-point-seeded initial view
let seededViewInfo: SeededViewInfo | null = null;
// Seed tiers of the role-filtered graph, keyed by the statement / body-or-proof
// boxes (turning off a role can create new sources); reset in loadGraph()
let seedTiersCache: { roleKey: string; tiers: SeedTier[] } | null = null;
// The depth the user actually asked for (?depth= or slider), kept separate
// from state.filters.maxDepth: the seeded render commits the *achieved* depth
// there, and an async re-seed (a late ?entrypoints= payload whose tier fits
// deeper than the provisional fallback did) must retry the request, not the
// fallback's achieved value. Captured on first seeded render, updated by any
// explicit depth interaction, reset in loadGraph().
let seededRequestedDepth: number | null = null;

const SEEDED_DEPTH_MAX = 10; // matches the depth slider's range

function clampSeededDepth(depth: number | null): number {
  if (depth === null || !Number.isFinite(depth) || depth < 1) return 1;
  return Math.min(depth, SEEDED_DEPTH_MAX);
}

/** Human description of the winning seed tier for the seeded-view banner. */
function describeSeedTier(info: SeededViewInfo): string {
  const n = info.seedCount.toLocaleString();
  switch (info.tierName) {
    case 'blueprint-param':
      return `${n} of ${(entrypointsParam?.labeled ?? info.seedCount).toLocaleString()} blueprint declarations (?entrypoints=) matched in this graph`;
    case 'entry-points':
      return `${n} explicit entry points (public API / blueprint)`;
    case 'source-defs':
      return `${n} root definitions`;
    default:
      return `${n} root functions (no callers)`;
  }
}

/**
 * Banner note when a requested ?entrypoints= payload is not the active seed
 * tier: fetch failure / zero matches / focus precedence (entrypointsParamNote),
 * or a loaded payload whose seed set broke the render budget.
 */
function describeEntrypointsFallback(): string {
  if (!entrypointsJsonUrl || seededViewInfo?.tierName === 'blueprint-param') return '';
  if (entrypointsParamNote) return `?entrypoints= ${escapeHtml(entrypointsParamNote)}. `;
  if (entrypointsParam) return `?entrypoints= seed expansion exceeds the render budget. `;
  return ''; // fetch still in flight
}

/**
 * True only while a seeded view is actually displayed. The mode conditions
 * alone are not enough: on a graph where every seed tier exceeds the budget
 * (seededViewInfo === null), the slider must keep its normal behavior of
 * pre-setting maxDepth for a later query.
 */
function isSeededModeActive(): boolean {
  return seededViewInfo !== null &&
         state.fullGraph !== null &&
         isLargeGraph(state.fullGraph) &&
         !hasSearchFilters() &&
         activeView === 'callgraph';
}

/**
 * Try each seed tier in preference order at the requested depth.
 * Tier preference beats depth: the first tier that fits at any depth >= 1
 * wins, even if a later tier would fit at a greater depth.
 * A loaded ?entrypoints= payload is the most-preferred tier, ahead of the
 * graph-derived tiers (explicit entry points, then the topological fallbacks).
 */
function computeSeededExpansion(
  requestedDepth: number,
): { tier: SeedTier; expansion: SeedExpansion } | null {
  if (!state.fullGraph) return null;
  // The statement / body-or-proof boxes restrict the expansion, as they do
  // query traversal
  const graph = roleFilteredGraph(state.fullGraph, state.filters);
  const roleKey = `${state.filters.showStatementDeps}:${state.filters.showBodyDeps}`;
  if (seedTiersCache?.roleKey !== roleKey) {
    seedTiersCache = { roleKey, tiers: computeSeedTiers(graph) };
  }
  const tiers: SeedTier[] = entrypointsParam && activeLayer === 'code'
    ? [{ name: 'blueprint-param', seeds: entrypointsParam.seeds }, ...seedTiersCache.tiers]
    : seedTiersCache.tiers;
  const budget = { maxNodes: LARGE_GRAPH_NODE_THRESHOLD, maxLinks: LARGE_GRAPH_LINK_THRESHOLD };
  for (const tier of tiers) {
    const expansion = expandFromSeeds(graph, tier.seeds, requestedDepth, budget);
    if (expansion.ok) return { tier, expansion };
  }
  return null;
}

/**
 * Build the renderable seeded view: the induced subgraph of the expansion,
 * with display-only filters (hidden nodes, kind, verification status, link
 * types) applied on top without reseeding. Carries the BFS nodeDepths so the
 * renderer never falls back to computeTopologicalDepth(), which does not
 * terminate on cyclic subgraphs.
 */
function buildSeededGraph(expansion: SeedExpansion): D3Graph {
  const full = state.fullGraph!;
  const passesDisplay = compileSeededDisplayPredicate(state.filters, state.projectLanguage);
  const nodes = full.nodes.filter(n => expansion.nodeIds.has(n.id) && passesDisplay(n));

  const keptIds = new Set(nodes.map(n => n.id));
  let links = full.links.filter(l => {
    const s = typeof l.source === 'string' ? l.source : l.source.id;
    const t = typeof l.target === 'string' ? l.target : l.target.id;
    return keptIds.has(s) && keptIds.has(t);
  });
  links = filterLinksByType(links, state.filters);

  const nodeDepths = new Map<string, number>();
  for (const id of keptIds) {
    nodeDepths.set(id, expansion.nodeDepths.get(id) ?? 0);
  }

  return { nodes, links, metadata: full.metadata, nodeDepths };
}

function syncDepthSliderUI(depth: number | null): void {
  const slider = document.getElementById('depth-limit') as HTMLInputElement | null;
  if (slider) slider.value = depth !== null ? depth.toString() : '0';
  const label = document.getElementById('depth-value');
  if (label) label.textContent = depth !== null ? depth.toString() : 'All';
}

/**
 * Transactional depth change for the seeded view: compute the candidate view,
 * validate it against the budget, and only then commit state, slider, label,
 * URL, and banner together. On refusal, keep the current view and name the
 * budget that failed.
 */
function handleSeededDepthChange(rawValue: number): void {
  const requested = clampSeededDepth(rawValue);
  const current = clampSeededDepth(state.filters.maxDepth);
  // Record the request whether or not it commits: a refused depth is still
  // the user's latest intent, retried when a better seed tier arrives.
  seededRequestedDepth = requested;
  const result = computeSeededExpansion(requested);

  if (result && result.expansion.depth === requested) {
    state.filters.maxDepth = requested;
    syncDepthSliderUI(requested);
    applyFiltersAndUpdate();
    return;
  }

  const refusal = result?.expansion.refusal;
  if (refusal) {
    const limit = refusal.failedBudget === 'nodes'
      ? `${refusal.nodes.toLocaleString()} nodes (limit ${LARGE_GRAPH_NODE_THRESHOLD.toLocaleString()})`
      : `${refusal.links.toLocaleString()} links (limit ${LARGE_GRAPH_LINK_THRESHOLD.toLocaleString()})`;
    showError(`Depth ${requested} would need ${limit}. Keeping depth ${current}.`, 'seeded-depth-refusal');
  } else {
    showError(`Depth ${requested} exceeds the render budget. Keeping depth ${current}.`, 'seeded-depth-refusal');
  }
  syncDepthSliderUI(current);
}

/**
 * Fetch and load a focus set JSON file.
 * 
 * The JSON should have:
 * - focus_nodes: string[] - SCIP node IDs for exact matching
 * - focus_functions: Array<{display_name, relative_path}> - for fuzzy matching
 *   across different analyzers (rust-analyzer vs verus-analyzer produce different IDs)
 * 
 * The loader first tries exact ID matching. If few IDs match (suggesting an analyzer
 * mismatch), it falls back to matching by (display_name, relative_path).
 * 
 * @param url - URL to the focus set JSON file
 * @returns Promise that resolves when focus set is loaded
 */
async function loadFocusSet(url: string): Promise<void> {
  // A newer intent (chip, typing, node click, back) wins over this load
  const generation = intentGeneration;
  pendingFocus = { url, generation };
  const isStale = () => generation !== intentGeneration;
  try {
    console.log('Loading focus set from:', url);
    const response = await fetch(url);
    if (isStale()) return;
    if (!response.ok) {
      throw new Error(`Failed to fetch focus set: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    if (isStale()) return;

    if (!data.focus_nodes || !Array.isArray(data.focus_nodes)) {
      throw new Error('Invalid focus set JSON: missing "focus_nodes" array');
    }
    
    // Try exact ID matching first
    const focusIdSet = new Set<string>(data.focus_nodes);
    const resolvedIds = new Set<string>();
    
    if (state.fullGraph) {
      const graphIds = new Set(state.fullGraph.nodes.map(n => n.id));
      
      // Count exact matches
      for (const id of focusIdSet) {
        if (graphIds.has(id)) {
          resolvedIds.add(id);
        }
      }
      
      console.log(`Focus set: ${resolvedIds.size}/${focusIdSet.size} exact ID matches`);
      
      // If less than half matched and we have focus_functions, fall back to fuzzy matching
      if (resolvedIds.size < focusIdSet.size / 2 && data.focus_functions && Array.isArray(data.focus_functions)) {
        console.log('Few exact matches - falling back to (display_name, relative_path) matching');
        
        // Build index of graph nodes by (display_name, relative_path)
        // Index by BOTH the full path and the path as-is for flexible matching
        const graphByNamePath = new Map<string, string[]>();
        for (const node of state.fullGraph.nodes) {
          const key = `${node.display_name}\0${node.relative_path}`;
          if (!graphByNamePath.has(key)) {
            graphByNamePath.set(key, []);
          }
          graphByNamePath.get(key)!.push(node.id);
        }
        
        // Match each focus function by name+path
        // Handles path prefix mismatches (e.g., focus has "curve25519-dalek/src/foo.rs"
        // but graph has "src/foo.rs", or vice versa) by trying suffix matching
        let fuzzyMatched = 0;
        for (const func of data.focus_functions) {
          // Try exact path match first
          const exactKey = `${func.display_name}\0${func.relative_path}`;
          let matches = graphByNamePath.get(exactKey);
          
          // If no exact match, try suffix-based matching
          // (handles different path prefixes between analyzers/graphs)
          if (!matches) {
            for (const [key, ids] of graphByNamePath) {
              const [name, path] = key.split('\0');
              if (name !== func.display_name) continue;
              // Check if one path is a suffix of the other
              if (path.endsWith(func.relative_path) || func.relative_path.endsWith(path)) {
                matches = ids;
                break;
              }
            }
          }
          
          if (matches) {
            for (const id of matches) {
              resolvedIds.add(id);
            }
            fuzzyMatched++;
          }
        }
        console.log(`Fuzzy matching: ${fuzzyMatched}/${data.focus_functions.length} functions resolved to ${resolvedIds.size} node IDs`);
      }
    } else {
      // No graph loaded yet - use raw IDs and hope for the best
      for (const id of focusIdSet) {
        resolvedIds.add(id);
      }
    }
    
    const description = data.metadata?.description || 'unknown';
    console.log(`Focus set active: ${resolvedIds.size} nodes (${description})`);

    // No matches still gives a focus intent (showing nothing), not 'none'
    const label = typeof data.metadata?.description === 'string' ? data.metadata.description : 'focus set';
    const resolved = { ids: [...resolvedIds], label };
    focusCache.set(url, resolved);
    setIntent(focusIntent(url, resolved.ids, resolved.label), { history: 'replace' });
  } catch (error) {
    if (isStale()) return;
    console.error('Failed to load focus set:', error);
    pendingFocus = null;
    showError(`Failed to load focus set: ${error instanceof Error ? error.message : 'Unknown error'}`);
    // The URL describes what is shown: drop focus=
    updateURLWithFilters();
  } finally {
    // Resumes only once no focus load is pending and no focus set is active,
    // so a stale fetch cannot resume while a newer focus load runs
    resumeDeferredEntrypoints();
  }
}

/**
 * Fetch a probe-leanblueprint JSON (?entrypoints= URL param) and derive the
 * blueprint seed tier for the seeded initial view.
 *
 * The payload is an enriched atom base, not a seed list: seeds are the atoms
 * carrying `blueprint-label`, intersected with the loaded graph by exact ID.
 * (Raw atom-ID intersection must not be used — the payload shares its atom
 * base with the graph, so it matches nearly every node.)
 *
 * The fetch races graph reloads and user interactions, so it captures the
 * graph-load generation and rechecks it before committing; on failure or zero
 * matches it records a note for the banner and the normal seed chain applies.
 */
async function loadEntryPointsSet(url: string): Promise<void> {
  const generation = graphLoadGeneration;
  try {
    const response = await fetch(url);
    if (generation !== graphLoadGeneration) return; // don't parse an obsolete body
    if (!response.ok) {
      throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
    }
    // Same loading concern as the graph's own size gate: JSON.parse on large
    // files freezes the browser, and this payload bypasses autoLoadGraph().
    const contentLength = parseInt(response.headers.get('Content-Length') || '0');
    if (contentLength > LARGE_FILE_SIZE_THRESHOLD) {
      throw new Error(`payload too large (${(contentLength / (1024 * 1024)).toFixed(1)} MB)`);
    }
    const raw = await response.json();
    if (generation !== graphLoadGeneration) return; // a different graph loaded meanwhile

    const atoms = isSchema2Envelope(raw) ? raw.data : raw;
    if (typeof atoms !== 'object' || atoms === null || Array.isArray(atoms)) {
      throw new Error('payload is not an atom dict');
    }

    const labeled: string[] = [];
    for (const [id, atom] of Object.entries(atoms as Record<string, unknown>)) {
      if (!atom || typeof atom !== 'object') continue;
      const rec = atom as Record<string, unknown>;
      // Skip the synthetic blueprint-layer nodes (language: "blueprint"):
      // seeds — and the banner's denominator — are the real Lean declarations
      // carrying blueprint-label, not the tex-graph nodes that bind them.
      if (rec['language'] === 'blueprint') continue;
      if (rec['blueprint-label']) labeled.push(id);
    }
    if (labeled.length === 0) {
      throw new Error('no atoms carry blueprint-label');
    }

    // Seeds of the code layer, whichever layer is shown
    const graphIds = new Set(codeLayer?.nodes.map(n => n.id) ?? []);
    const seeds = labeled.filter(id => graphIds.has(id));
    if (seeds.length === 0) {
      throw new Error(`none of its ${labeled.length} blueprint declarations match this graph`);
    }

    entrypointsParam = { seeds, labeled: labeled.length };
    entrypointsParamNote = null;
    console.log(`Entry points: ${seeds.length}/${labeled.length} blueprint declarations matched`);
  } catch (error) {
    if (generation !== graphLoadGeneration) return;
    entrypointsParam = null;
    entrypointsParamNote = error instanceof Error ? error.message : 'unknown error';
    console.error('Failed to load ?entrypoints= set:', error);
  }

  // Commit: re-render only when the seeded initial view is what is (or would
  // be) on screen. Query intent typed while the fetch was in flight wins; the
  // payload stays cached, so clearing that query returns to the blueprint
  // seeds via the normal seeded path.
  if (state.fullGraph && isLargeGraph(state.fullGraph) &&
      !hasSearchFilters() && activeView === 'callgraph') {
    applyFiltersAndUpdate();
  }
}

/**
 * Start a ?entrypoints= fetch that loadGraph() deferred because a focus set
 * took precedence, once the focus set is gone (cleared, reset, or failed to
 * load). Without this, clearing the focus would fall back to the topological
 * tiers with a stale "deferred" note despite a usable blueprint payload.
 */
function resumeDeferredEntrypoints(): void {
  if (!entrypointsDeferredByFocus || !entrypointsJsonUrl) return;
  if (pendingFocus || isFocusIntent(state.filters.intent)) return; // focus still pending or active
  entrypointsDeferredByFocus = false;
  entrypointsParamNote = null;
  loadEntryPointsSet(entrypointsJsonUrl);
}

/**
 * Show the Source Type (Libsignal / External) filter only when the graph
 * actually mixes both kinds; for any non-Signal project every node has
 * is_libsignal=false and the filter is meaningless.
 */
function updateSourceTypeFilterVisibility(): void {
  const container = document.getElementById('source-type-container');
  if (!container) return;
  const nodes = state.fullGraph?.nodes ?? [];
  const hasLibsignal = nodes.some(n => n.is_libsignal);
  const hasExternal = nodes.some(n => !n.is_libsignal);
  container.style.display = hasLibsignal && hasExternal ? '' : 'none';
}

/**
 * Render Language filter checkboxes when the graph contains multiple languages.
 * Only shown when both Rust and Lean nodes are present.
 */
function renderLanguageFilters(): void {
  const container = document.getElementById('language-filter-container');
  if (!container) return;

  const langs = new Set<string>();
  for (const node of state.fullGraph?.nodes ?? []) {
    if (node.language) langs.add(node.language);
  }

  const hasRust = langs.has('rust') || langs.has('verus');
  const hasLean = langs.has('lean');

  if (!hasRust || !hasLean) {
    container.style.display = 'none';
    return;
  }

  container.style.display = '';
  const rustLabel = langs.has('verus') ? 'Verus' : 'Rust';
  container.innerHTML = `
    <h3>Language</h3>
    <label class="checkbox-label">
      <input type="checkbox" id="show-rust-nodes" checked />
      <span>${rustLabel}</span>
    </label>
    <label class="checkbox-label">
      <input type="checkbox" id="show-lean-nodes" checked />
      <span>Lean</span>
    </label>`;

  document.getElementById('show-rust-nodes')?.addEventListener('change', (e) => {
    state.filters.showRustNodes = (e.target as HTMLInputElement).checked;
    applyFiltersAndUpdate();
  });
  document.getElementById('show-lean-nodes')?.addEventListener('change', (e) => {
    state.filters.showLeanNodes = (e.target as HTMLInputElement).checked;
    applyFiltersAndUpdate();
  });

  const setCheckbox = (id: string, checked: boolean) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.checked = checked;
  };
  setCheckbox('show-rust-nodes', state.filters.showRustNodes);
  setCheckbox('show-lean-nodes', state.filters.showLeanNodes);
}

/**
 * Dynamically render Declaration Kind filter checkboxes based on detected language.
 */
function renderKindFilters(lang: ProjectLanguage): void {
  const container = document.getElementById('kind-filters-container');
  if (!container) return;

  const kindsPresent = new Set<string>();
  for (const node of state.fullGraph?.nodes ?? []) {
    kindsPresent.add(node.kind || 'exec');
  }
  const { axiomKinds, typeKinds, projectionKinds, instanceKinds } = getKindSetsForLanguage(lang);
  const hasKind = (kinds: Set<string>) => [...kinds].some(k => kindsPresent.has(k));

  let html = '<h3>Declaration Kind</h3>';

  if (lang === 'verus') {
    html += `
      <label class="checkbox-label">
        <input type="checkbox" id="show-exec-functions" checked />
        <span>Exec</span>
      </label>
      <label class="checkbox-label">
        <input type="checkbox" id="show-proof-functions" checked />
        <span>Proof</span>
      </label>
      <label class="checkbox-label">
        <input type="checkbox" id="show-spec-functions" />
        <span>Spec</span>
      </label>`;
  } else {
    html += `
      <label class="checkbox-label">
        <input type="checkbox" id="show-exec-functions" checked />
        <span>Definitions</span>
        ${lang === 'blueprint' ? '' : '<small style="color:var(--pg-text-faint);margin-left:4px">def, abbrev, ...</small>'}
      </label>
      <label class="checkbox-label">
        <input type="checkbox" id="show-proof-functions" checked />
        <span>Theorems</span>
      </label>`;
    // Only render checkboxes for kinds the graph actually contains.
    if (hasKind(axiomKinds)) {
      html += `
      <label class="checkbox-label">
        <input type="checkbox" id="show-axioms" checked />
        <span>Axioms</span>
      </label>`;
    }
    if (lang === 'mixed' && kindsPresent.has('spec')) {
      html += `
      <label class="checkbox-label">
        <input type="checkbox" id="show-spec-functions" />
        <span>Spec</span>
      </label>`;
    }
    if (hasKind(typeKinds)) {
      html += `
      <label class="checkbox-label">
        <input type="checkbox" id="show-types" />
        <span>Types</span>
        <small style="color:var(--pg-text-faint);margin-left:4px">structure, inductive, class</small>
      </label>`;
    }
    if (hasKind(projectionKinds)) {
      html += `
      <label class="checkbox-label">
        <input type="checkbox" id="show-projections" />
        <span>Projections</span>
      </label>`;
    }
    if (hasKind(instanceKinds)) {
      html += `
      <label class="checkbox-label">
        <input type="checkbox" id="show-instances" />
        <span>Instances</span>
      </label>`;
    }
  }

  container.innerHTML = html;

  // Re-attach event listeners
  const wireCheckbox = (id: string, apply: (checked: boolean) => void) => {
    document.getElementById(id)?.addEventListener('change', (e) => {
      apply((e.target as HTMLInputElement).checked);
      applyFiltersAndUpdate();
    });
  };
  wireCheckbox('show-exec-functions', c => { state.filters.showExecFunctions = c; });
  wireCheckbox('show-proof-functions', c => { state.filters.showProofFunctions = c; });
  wireCheckbox('show-spec-functions', c => { state.filters.showSpecFunctions = c; });
  wireCheckbox('show-axioms', c => { state.filters.showAxioms = c; });
  wireCheckbox('show-types', c => { state.filters.showTypes = c; });
  wireCheckbox('show-projections', c => { state.filters.showProjections = c; });
  wireCheckbox('show-instances', c => { state.filters.showInstances = c; });

  // Sync checkbox state with current filter values
  const setCheckbox = (id: string, checked: boolean) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.checked = checked;
  };
  setCheckbox('show-exec-functions', state.filters.showExecFunctions);
  setCheckbox('show-proof-functions', state.filters.showProofFunctions);
  setCheckbox('show-spec-functions', state.filters.showSpecFunctions);
  setCheckbox('show-axioms', state.filters.showAxioms);
  setCheckbox('show-types', state.filters.showTypes);
  setCheckbox('show-projections', state.filters.showProjections);
  setCheckbox('show-instances', state.filters.showInstances);
}

/** Whether the loaded graph splits dependencies into statement and body/proof (Lean). */
function graphHasLinkRoles(): boolean {
  return state.fullGraph?.links.some(l => l.role !== undefined) ?? false;
}

/**
 * Dynamically render Call Type filter checkboxes based on detected language.
 * Verus has precondition/postcondition edges (requires/ensures clauses);
 * Lean graphs split dependencies into statement and body/proof. Other
 * languages only have body calls.
 */
function renderCallTypeFilters(lang: ProjectLanguage): void {
  const container = document.getElementById('call-types-container');
  if (!container) return;

  // Blueprint uses edges split into statement and proof like Lean dependencies
  const isLean = lang === 'lean' || lang === 'blueprint';
  const isVerus = lang === 'verus' || lang === 'mixed';
  const hasMappingLinks = state.fullGraph?.links.some(l => l.type === 'mapping') ?? false;
  const hasSpecLinks = state.fullGraph?.links.some(l => l.type === 'spec') ?? false;
  const hasRoles = graphHasLinkRoles();

  if (isLean) {
    // Lean dependencies are all body calls; the role boxes split them
    state.filters.showInnerCalls = true;
    state.filters.showPreconditionCalls = true;
    state.filters.showPostconditionCalls = true;
  } else if (!isVerus && !hasMappingLinks && !hasSpecLinks && !hasRoles) {
    state.filters.showInnerCalls = true;
    state.filters.showPreconditionCalls = false;
    state.filters.showPostconditionCalls = false;
  }

  if (!isVerus && !hasMappingLinks && !hasSpecLinks && !hasRoles) {
    container.style.display = 'none';
    return;
  }

  container.style.display = '';

  let html = '<h3>Edge Types</h3>';

  if (!isLean) {
    html += `
    <label class="checkbox-label">
      <input type="checkbox" id="show-inner-calls" checked />
      <span class="inner-badge">Body Calls</span>
    </label>`;
  }

  if (isVerus) {
    html += `
    <label class="checkbox-label">
      <input type="checkbox" id="show-precondition-calls" />
      <span class="precondition-badge">Requires</span>
    </label>
    <label class="checkbox-label">
      <input type="checkbox" id="show-postcondition-calls" />
      <span class="postcondition-badge">Ensures</span>
    </label>`;
  }

  if (hasRoles) {
    const [statementTitle, bodyTitle] = lang === 'blueprint'
      ? ['Blueprint entries used by the statement', 'Blueprint entries used by the proof']
      : ["Dependencies used in the declaration's type (the statement)",
        'Dependencies used in the definition body or proof, plus those reached through auxiliary declarations'];
    html += `
    <label class="checkbox-label" title="${statementTitle}">
      <input type="checkbox" id="show-statement-deps" checked />
      <span class="inner-badge">Statement deps</span>
    </label>
    <label class="checkbox-label" title="${bodyTitle}">
      <input type="checkbox" id="show-body-deps" checked />
      <span class="inner-badge">Body/proof deps</span>
    </label>`;
  }

  if (hasMappingLinks) {
    html += `
    <label class="checkbox-label">
      <input type="checkbox" id="show-mapping-links" checked />
      <span class="mapping-badge">Mapping</span>
    </label>`;
  }
  if (hasSpecLinks) {
    html += `
    <label class="checkbox-label" title="Spec theorem links; on graphs with statement / body-or-proof data they also follow those boxes">
      <input type="checkbox" id="show-spec-links" checked />
      <span class="spec-link-badge">Specifications</span>
    </label>`;
  }

  if (isVerus && !hasMappingLinks && !hasSpecLinks) {
    html += `
    <small style="color: var(--pg-text-muted); font-size: 0.75rem; display: block; margin-top: 0.25rem;">
      Requires/Ensures edges typically connect to Spec functions
    </small>`;
  }

  container.innerHTML = html;

  const bindCheckbox = (id: string, apply: (checked: boolean) => void) => {
    document.getElementById(id)?.addEventListener('change', (e) => {
      apply((e.target as HTMLInputElement).checked);
      applyFiltersAndUpdate();
    });
  };
  bindCheckbox('show-inner-calls', v => { state.filters.showInnerCalls = v; });
  bindCheckbox('show-precondition-calls', v => { state.filters.showPreconditionCalls = v; });
  bindCheckbox('show-postcondition-calls', v => { state.filters.showPostconditionCalls = v; });
  bindCheckbox('show-statement-deps', v => { state.filters.showStatementDeps = v; });
  bindCheckbox('show-body-deps', v => { state.filters.showBodyDeps = v; });
  bindCheckbox('show-mapping-links', v => { state.filters.showMappingLinks = v; });
  bindCheckbox('show-spec-links', v => { state.filters.showSpecLinks = v; });

  const setCheckbox = (id: string, checked: boolean) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.checked = checked;
  };
  setCheckbox('show-inner-calls', state.filters.showInnerCalls);
  setCheckbox('show-precondition-calls', state.filters.showPreconditionCalls);
  setCheckbox('show-postcondition-calls', state.filters.showPostconditionCalls);
  setCheckbox('show-statement-deps', state.filters.showStatementDeps);
  setCheckbox('show-body-deps', state.filters.showBodyDeps);
  setCheckbox('show-mapping-links', state.filters.showMappingLinks);
  setCheckbox('show-spec-links', state.filters.showSpecLinks);
}

/**
 * Load a graph and update the UI
 */
/** A copy D3 can mutate (it replaces link endpoints with node objects). */
function copyGraph(graph: D3Graph): D3Graph {
  return {
    nodes: graph.nodes.map(n => ({ ...n })),
    links: graph.links.map(l => ({ ...l })),
    metadata: { ...graph.metadata },
  };
}

/**
 * Make `layer` state.fullGraph and rebuild everything derived from it:
 * caches, filter panels, crate names, derived statuses, file list. Leaves
 * state.filters at the layer's defaults (graphDefaultFilters); the caller
 * restores or reads the filters it wants.
 */
function showLayer(layer: Layer): void {
  activeLayer = blueprintLayer ? layer : 'code';
  state.fullGraph = activeLayer === 'blueprint' ? blueprintLayer : codeLayer;
  if (!state.fullGraph) return;
  renderLayerSwitcher();

  seedTiersCache = null;
  seededViewInfo = null;
  seededRequestedDepth = null;
  // Focus resolution depends on the graph (name/path fallback)
  focusCache.clear();
  crateDependencyMap = new Map();
  crateReverseDependencyMap = new Map();
  state.selectedNode = null;

  // Deep copy filters - spread only does shallow copy, so Sets would be shared!
  state.filters = freshFilters(initialFilters);

  // Detect project language and update UI accordingly
  state.projectLanguage = detectProjectLanguage(state.fullGraph);
  updateSourceTypeFilterVisibility();
  renderLanguageFilters();
  renderKindFilters(state.projectLanguage);
  renderCallTypeFilters(state.projectLanguage);
  updateLanguageLabels(state.projectLanguage);

  // Backfill crate_name on every node using language-aware extraction
  // (Lean: two-level module path, Rust/Verus: top-level crate)
  for (const node of state.fullGraph.nodes) {
    node.crate_name = extractCrateName(node, state.projectLanguage);
  }

  const isLarge = isLargeGraph(state.fullGraph);

  // Defer heavy graph analysis for large graphs to avoid freezing the browser.
  // These will run on first filter application (or when switching to Crate Map).
  deferredComputationsDone = false;
  if (!isLarge) {
    runDeferredComputations();
  }

  // Populate the file list panel and crate dropdowns (defer for large graphs)
  if (!isLarge) {
    populateFileList();
  } else {
    clearFileList();
  }
  crateDropdownKey = '';
  populateCrateDropdowns();

  // The render functions above force per-language call-type values; those
  // are this layer's defaults, which the URL or saved filters then override
  graphDefaultFilters = freshFilters(state.filters);
}

/** Show the layer switcher only for graphs with a blueprint layer. */
function renderLayerSwitcher(): void {
  const container = document.getElementById('layer-switcher');
  if (container) container.style.display = blueprintLayer ? '' : 'none';
  document.getElementById('layer-blueprint')?.classList.toggle('active', activeLayer === 'blueprint');
  document.getElementById('layer-code')?.classList.toggle('active', activeLayer === 'code');
}

/**
 * User switch between the blueprint and code layers. Each layer keeps its
 * own filters and query; the statement / body-or-proof boxes mean the same
 * on both and carry over. One pushed history entry.
 */
function switchLayer(layer: Layer): void {
  if (layer === activeLayer || !blueprintLayer) return;
  const { showStatementDeps, showBodyDeps } = state.filters;
  const saved = inactiveLayerFilters;
  inactiveLayerFilters = state.filters;
  showLayer(layer);
  state.filters = saved ?? freshFilters(graphDefaultFilters!);
  state.filters.showStatementDeps = showStatementDeps;
  state.filters.showBodyDeps = showBodyDeps;
  pendingFocus = null;
  intentGeneration++;
  lastSelectionKey = selectionKey(state.filters.selectedNodes);

  urlWritesSuppressed++;
  try {
    syncFilterUI();
    applyFiltersAndUpdate();
    refreshGuidePanel();
    updateNodeInfo();
  } finally {
    urlWritesSuppressed--;
  }
  window.history.pushState({ pushed: true }, '', generateShareableURL());
}

/**
 * `layer` overrides the URL's layer (and is written to it), for callers
 * whose query names code declarations.
 */
function loadGraph(graph: D3Graph, message: string, layer?: Layer): void {
  // Deep copy the graph to prevent D3 from mutating original data
  codeLayer = copyGraph(graph);
  blueprintLayer = graph.blueprintLayer ? copyGraph(graph.blueprintLayer) : null;
  inactiveLayerFilters = null;
  if (layer && blueprintLayer) replaceURLLayer(layer);

  // Seed tiers and the ?entrypoints= payload belong to the previous graph;
  // bumping the generation invalidates any of its in-flight fetches
  graphLoadGeneration++;
  entrypointsParam = null;
  entrypointsParamNote = null;
  entrypointsDeferredByFocus = false;

  // Set GitHub URL from metadata if not already set via URL param
  if (!githubBaseUrl && graph.metadata.github_url) {
    githubBaseUrl = graph.metadata.github_url;
  }

  showLayer(layerFromURL());
  const isLarge = isLargeGraph(state.fullGraph!);

  // For large graphs we stay on the default Call Graph tab but show an
  // informative "Large Graph" message. Heavy computations (derived statuses,
  // crate graph, file list) are deferred until the user applies a filter or
  // switches to Crate Map. This keeps the initial page load fast.
  const { focusUrl } = stateFromURL();
  entrypointsJsonUrl = new URLSearchParams(window.location.search).get('entrypoints');
  syncFilterUI();

  // ?entrypoints= seeds the initial view of large graphs; ?focus= takes
  // precedence while a focus set is pending or active — the fetch is
  // deferred, and clearing the focus set resumes it
  // (resumeDeferredEntrypoints). Kicked off before the first render so the
  // deferral note paints with it.
  if (entrypointsJsonUrl) {
    if (focusUrl) {
      entrypointsDeferredByFocus = true;
      entrypointsParamNote = 'deferred: ?focus= takes precedence';
    } else {
      loadEntryPointsSet(entrypointsJsonUrl);
    }
  }

  applyFiltersAndUpdate();

  // Restore hierarchy expansion state from the URL (parsed above, after the
  // visualization was created)
  if (hierarchyExpanded.length > 0 && visualization instanceof HierarchyMapVisualization) {
    visualization.setExpanded(hierarchyExpanded);
  }

  // Restore the Crate Map highlight from the URL params
  if (activeView === 'crate-map' && visualization instanceof CrateMapVisualization) {
    visualization.setBoundaryCrates(selectedSourceCrate || null, selectedTargetCrate || null);
  }

  if (focusUrl) loadFocusSet(focusUrl);

  console.log(message, {
    nodes: graph.nodes.length,
    links: graph.links.length,
    metadata: graph.metadata,
  });

  // Show success message
  const statsDiv = document.getElementById('stats');
  if (statsDiv && graph.nodes.length > 0) {
    const successMsg = document.createElement('div');
    
    if (isLarge && !hasSearchFilters() && !seededViewInfo) {
      // Show warning for large graphs where no seeded view fit the budget
      successMsg.style.cssText = 'background: #ff9800; color: white; padding: 0.5rem; border-radius: 4px; margin-bottom: 0.5rem; font-size: 0.85rem;';
      successMsg.innerHTML = `⚠️ Large graph (${graph.nodes.length.toLocaleString()} nodes, ${graph.links.length.toLocaleString()} links). Use <strong>Source</strong>, <strong>Sink</strong>, or <strong>Include Files</strong> filters to search.`;
    } else {
      successMsg.style.cssText = 'background: var(--pg-status-verified); color: white; padding: 0.5rem; border-radius: 4px; margin-bottom: 0.5rem; font-size: 0.85rem;';
      successMsg.textContent = `✓ ${message}`;
      // Remove success message after 5 seconds (but keep warning visible)
      setTimeout(() => successMsg.remove(), 5000);
    }
    
    statsDiv.insertBefore(successMsg, statsDiv.firstChild);
  }

  // Refresh the guide panel with new graph data
  refreshGuidePanel();
}

/**
 * Show error message.
 * A dedupeKey replaces any previous message with the same key instead of
 * stacking (e.g. one refusal per slider-drag step would pile up otherwise).
 */
function showError(message: string, dedupeKey?: string): void {
  const statsDiv = document.getElementById('stats');
  if (statsDiv) {
    if (dedupeKey) {
      statsDiv.querySelector(`[data-error-key="${dedupeKey}"]`)?.remove();
    }
    const errorMsg = document.createElement('div');
    if (dedupeKey) errorMsg.setAttribute('data-error-key', dedupeKey);
    errorMsg.style.cssText = 'background: var(--pg-status-failed); color: white; padding: 0.5rem; border-radius: 4px; margin-bottom: 0.5rem; font-size: 0.85rem;';
    errorMsg.textContent = message;
    statsDiv.insertBefore(errorMsg, statsDiv.firstChild);

    // Remove message after 8 seconds
    setTimeout(() => errorMsg.remove(), 8000);
  }
}

/**
 * Handle file load
 */
async function handleFileLoad(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  
  if (!file) return;

  try {
    const text = await file.text();
    const rawData = JSON.parse(text);
    const graph = parseAndNormalizeGraph(rawData);
    
    loadGraph(graph, `Loaded from file: ${file.name}`);
  } catch (error) {
    console.error('Error loading graph:', error);
    showError(`Error loading graph file: ${error instanceof Error ? error.message : 'Invalid JSON'}`);
  }
}

// Maximum nodes to render to prevent D3 from freezing
const MAX_RENDERED_NODES = 200;

type LabelPart = [cls: 'query-type' | 'query-dim' | 'query-param' | null, text: string];

/** Matcher text; an exact ID set shows the intent's label. */
function matcherText(m: NodeMatcher): string {
  switch (m.kind) {
    case 'pattern': return m.query;
    case 'crate': return `crate:${m.pattern}`;
    case 'nodeIds': {
      const intent = state.filters.intent;
      if (intent.kind === 'ids' && intent.label) return intent.label;
      return `[${m.ids.size} node${m.ids.size !== 1 ? 's' : ''}]`;
    }
  }
}

function queryLabelParts(q: GraphQuery): LabelPart[] {
  const depth = (d: number | null): LabelPart[] => d !== null ? [[null, ` depth=${d}`]] : [];
  const sp: LabelPart = [null, ' '];
  switch (q.type) {
    case 'callees':
      return [['query-type', 'callees'], sp, ['query-dim', 'from'], sp, ['query-param', matcherText(q.from)], ...depth(q.maxDepth)];
    case 'callers':
      return [['query-type', 'callers'], sp, ['query-dim', 'of'], sp, ['query-param', matcherText(q.to)], ...depth(q.maxDepth)];
    case 'neighborhood':
      return [['query-type', 'neighborhood'], sp, ['query-dim', 'of'], sp, ['query-param', matcherText(q.center)], ...depth(q.maxDepth)];
    case 'paths':
      return [['query-type', 'paths'], sp, ['query-param', matcherText(q.from)], sp, ['query-dim', '→'], sp, ['query-param', matcherText(q.to)]];
    case 'crateBoundary':
      return [['query-type', 'boundary'], sp, ['query-param', `crate:${q.sourceCrate}`], sp, ['query-dim', '→'], sp, ['query-param', `crate:${q.targetCrate}`]];
    case 'depthFromSelected':
      return [['query-type', 'depth'], sp, ['query-dim', 'from'], sp, ['query-param', `${q.selectedNodes.size} selected`], [null, ` depth=${q.maxDepth}`]];
    case 'noTraversal': {
      const intent = state.filters.intent;
      if (intent.kind === 'ids') {
        return [['query-type', isFocusIntent(intent) ? 'focus' : 'nodes'], sp, ['query-param', intent.label]];
      }
      return [['query-type', 'all'], sp, ['query-dim', '(no traversal)']];
    }
  }
}

/**
 * Render the query label. Labels, IDs and group names can come from the
 * URL, so every part is set as text, never as HTML.
 */
function setQueryLabel(parts: LabelPart[]): void {
  const el = document.getElementById('query-label');
  if (!el) return;
  el.replaceChildren();
  for (const [cls, text] of [['query-dim', 'query:'] as LabelPart, [null, ' '] as LabelPart, ...parts]) {
    if (cls) {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      el.appendChild(span);
    } else {
      el.appendChild(document.createTextNode(text));
    }
  }
  el.style.display = '';
}

function updateQueryLabel(q: GraphQuery): void {
  setQueryLabel(queryLabelParts(q));
}

/**
 * Apply filters and update visualization
 */
function applyFiltersAndUpdate(): void {
  if (!state.fullGraph) return;
  refreshGuidePanel({ onlyIfFiltersChanged: true });

  // For large graphs with no query intent, render a bounded seeded initial
  // view (entry-point seeds + their depth-limited neighborhood) instead of a
  // blank page. Crate Map and Hierarchy are exempt: they aggregate to a
  // compact group-level graph. Blueprint is also exempt (keeps the empty
  // view): its dagre layout is only sized for MAX_RENDERED_NODES-scale
  // inputs, and its border/fill colors need the deferred status computation
  // this branch skips. If no seed tier fits the render budget, fall back to
  // the empty view with the "use filters" message.
  if (isLargeGraph(state.fullGraph) && !hasSearchFilters() && !isAggregatedView(activeView)) {
    // The request is tracked separately from maxDepth, which the commit below
    // overwrites with the achieved depth: a later re-seed (late ?entrypoints=
    // payload, tier change) must retry what the user asked for, not what the
    // provisional tier managed.
    seededRequestedDepth ??= clampSeededDepth(state.filters.maxDepth);
    const requested = seededRequestedDepth;
    const result = activeView === 'callgraph' ? computeSeededExpansion(requested) : null;
    if (result) {
      const { tier, expansion } = result;
      // Commit the achieved depth (may be < requested when ?depth=N was over
      // budget on initial load) to state, slider, and label together.
      if (state.filters.maxDepth !== expansion.depth) {
        state.filters.maxDepth = expansion.depth;
        syncDepthSliderUI(expansion.depth);
      }
      state.filteredGraph = buildSeededGraph(expansion);
      seededViewInfo = {
        tierName: tier.name,
        seedCount: tier.seeds.length,
        shownNodes: state.filteredGraph.nodes.length,
        shownLinks: state.filteredGraph.links.length,
        depth: expansion.depth,
        requestedDepth: requested,
      };
    } else {
      seededViewInfo = null;
      state.filteredGraph = { nodes: [], links: [], metadata: state.fullGraph.metadata };
    }
    const shown = state.filteredGraph.nodes.length;
    lastRenderResult = {
      shown, total: shown, missingAnchor: false,
      seeded: seededViewInfo !== null, tooLarge: seededViewInfo === null,
    };
    // The normal pipeline never runs here, so keep the query label in sync:
    // name the seeded view, or hide a stale label from a cleared query.
    const queryLabel = document.getElementById('query-label');
    if (queryLabel) {
      if (seededViewInfo) {
        setQueryLabel([['query-type', 'entry points'], [null, ` depth=${seededViewInfo.depth}`]]);
      } else {
        queryLabel.style.display = 'none';
      }
    }
    visualization?.update(state.filteredGraph);
    updateStats();
    updateNodeInfo();
    updateHiddenNodesUI();
    updateURLWithFilters();
    return;
  }
  seededViewInfo = null;
  
  // Run deferred computations on first real filter application.
  // Crate Map and Hierarchy only need the crate graph, not the full set of
  // deferred work.
  if (isAggregatedView(activeView)) {
    ensureCrateGraphBuilt();
  } else {
    runDeferredComputations();
  }

  const compiled = compileQuery(state.filters, state.projectLanguage);
  updateQueryLabel(compiled.query);
  let filtered = applyFilters(state.fullGraph, state.filters, state.projectLanguage);

  const resultSize = filtered.nodes.length;
  const anchors = compiled.anchorIds;
  const missingAnchor = anchors.size > 0 && !isFocusIntent(state.filters.intent)
    && !filtered.nodes.some(n => anchors.has(n.id));

  // Limit rendered nodes for large results to prevent D3 freeze
  // Crate Map and Hierarchy aggregate into group boxes, so truncation would
  // distort their results
  let wasTruncated = false;
  if (!isAggregatedView(activeView) && filtered.nodes.length > MAX_RENDERED_NODES) {
    wasTruncated = true;
    
    // Keep the query's anchors, then the nodes with highest connectivity
    const sortedNodes = [...filtered.nodes].sort((a, b) =>
      Number(anchors.has(b.id)) - Number(anchors.has(a.id)) ||
      (b.dependents.length + (b.dependencies?.length || 0)) - (a.dependents.length + (a.dependencies?.length || 0))
    );
    const keptNodes = sortedNodes.slice(0, MAX_RENDERED_NODES);
    const keptNodeIds = new Set(keptNodes.map(n => n.id));
    
    // Filter links to only include those between kept nodes
    const keptLinks = filtered.links.filter(link => {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
      return keptNodeIds.has(sourceId) && keptNodeIds.has(targetId);
    });
    
    filtered = { nodes: keptNodes, links: keptLinks, metadata: filtered.metadata };
  }
  
  state.filteredGraph = filtered;
  lastRenderResult = isAggregatedView(activeView) ? null
    : { shown: filtered.nodes.length, total: resultSize, missingAnchor, seeded: false, tooLarge: false };
  visualization?.update(state.filteredGraph);
  updateStats(wasTruncated ? filtered.nodes.length : undefined);
  updateNodeInfo();
  updateHiddenNodesUI();
  
  // Update URL with current filter state (without adding to history)
  updateURLWithFilters();
}

/**
 * Update the browser URL with current filter state
 * Uses replaceState to avoid polluting browser history
 */
function updateURLWithFilters(): void {
  if (urlWritesSuppressed > 0) return;
  const url = generateShareableURL();
  // Keep the entry's pushed marker: an edit after a Guide action (depth
  // slider, kind toggle) does not change where the next typing goes
  window.history.replaceState(window.history.state ?? { pushed: false }, '', url);
}

/**
 * Handle state changes from visualization
 */
function handleStateChange(newState: GraphState, selectionChanged: boolean = false): void {
  state = newState;
  updateNodeInfo();

  // A click that changes the selection under a 'none' intent is a newer
  // query (depthFromSelected): it wins over a pending focus load
  const key = selectionKey(state.filters.selectedNodes);
  if (key !== lastSelectionKey) {
    lastSelectionKey = key;
    if (state.filters.intent.kind === 'none') {
      intentGeneration++;
      if (pendingFocus) {
        pendingFocus = null;
        resumeDeferredEntrypoints();
      }
    }
  }
  
  // Re-apply filters if selection/hidden nodes changed (not just hover)
  // This ensures hidden nodes are properly filtered out
  if (selectionChanged) {
    applyFiltersAndUpdate();
  }
}

/**
 * Update statistics display
 * @param truncatedTo - if provided, indicates results were truncated to this count
 */
function updateStats(truncatedTo?: number): void {
  const statsDiv = document.getElementById('stats');
  if (!statsDiv) return;

  if (!state.fullGraph) {
    statsDiv.innerHTML = '<p>No graph loaded. Please load a JSON file.</p>';
    return;
  }

  const filtered = state.filteredGraph || state.fullGraph;
  const isLarge = isLargeGraph(state.fullGraph);
  const needsFilter = isLarge && !hasSearchFilters() && !isAggregatedView(activeView) && !seededViewInfo;
  const wasTruncated = truncatedTo !== undefined;

  const seededBanner = seededViewInfo ? `
    <div class="stat-item" style="background: #ecfae8; padding: 8px; border-radius: 4px; margin-bottom: 8px;">
      <span style="color: var(--pg-status-transitively-verified); font-weight: bold;">Showing ${seededViewInfo.shownNodes.toLocaleString()} of ${state.fullGraph.nodes.length.toLocaleString()} nodes (entry points, depth ${seededViewInfo.depth})</span>
      <p style="margin: 4px 0 0 0; font-size: 0.85rem; color: var(--pg-text-muted);">
        Seeded from ${describeSeedTier(seededViewInfo)}.
        ${describeEntrypointsFallback()}${seededViewInfo.depth < seededViewInfo.requestedDepth ? `Depth limited to ${seededViewInfo.depth}: depth ${seededViewInfo.requestedDepth} would exceed the render budget. ` : ''}
        Use <strong>Source</strong>/<strong>Sink</strong> filters or click a node to explore the full graph.
      </p>
    </div>
  ` : '';
  
  // Count verification statuses
  const verifiedCount = filtered.nodes.filter(n => n.verification_status === 'verified').length;
  const transitivelyVerifiedCount = filtered.nodes.filter(n => n.verification_status === 'transitively-verified').length;
  const trustedCount = filtered.nodes.filter(n => n.verification_status === 'trusted').length;
  const failedCount = filtered.nodes.filter(n => n.verification_status === 'failed').length;
  const unverifiedCount = filtered.nodes.filter(n => n.verification_status === 'unverified').length;
  const unknownCount = filtered.nodes.filter(n => !n.verification_status).length;

  statsDiv.innerHTML = `
    ${seededBanner}
    ${needsFilter ? `
    <div class="stat-item" style="background: #fff3e0; padding: 8px; border-radius: 4px; margin-bottom: 8px;">
      <span style="color: #e65100; font-weight: bold;">Large Graph (${state.fullGraph.nodes.length.toLocaleString()} nodes, ${state.fullGraph.links.length.toLocaleString()} edges)</span>
      <p style="margin: 4px 0 0 0; font-size: 0.85rem; color: var(--pg-text-muted);">
        ${describeEntrypointsFallback()}Too large to render all at once. Use the <strong>${crateMapLabel(state.projectLanguage)}</strong> for an overview, or enter a <strong>Source</strong>/<strong>Sink</strong> filter to explore specific call paths.
      </p>
    </div>
    ` : ''}
    ${wasTruncated ? `
    <div class="stat-item" style="background: var(--pg-accent-soft); padding: 8px; border-radius: 4px; margin-bottom: 8px;">
      <span style="color: var(--pg-accent); font-weight: bold;">Results Limited</span>
      <p style="margin: 4px 0 0 0; font-size: 0.85rem; color: var(--pg-text-muted);">
        Showing top ${truncatedTo} nodes by connectivity. Use a more specific query or reduce <strong>Depth</strong> to narrow results.
      </p>
    </div>
    ` : ''}
    <div class="stat-item">
      <span class="stat-label">Total Nodes:</span>
      <span class="stat-value">${filtered.nodes.length}</span>
      <span class="stat-detail">(of ${state.fullGraph.nodes.length.toLocaleString()})</span>
    </div>
    <div class="stat-item">
      <span class="stat-label">Total Edges:</span>
      <span class="stat-value">${filtered.links.length}</span>
      <span class="stat-detail">(of ${state.fullGraph.links.length.toLocaleString()})</span>
    </div>
    <div class="stat-item">
      <span class="stat-label">Verified:</span>
      <span class="stat-value" style="color: var(--pg-status-verified);">${verifiedCount}</span>
    </div>
    <div class="stat-item">
      <span class="stat-label">Transitively verified:</span>
      <span class="stat-value" style="color: var(--pg-status-transitively-verified);">${transitivelyVerifiedCount}</span>
    </div>
    <div class="stat-item">
      <span class="stat-label">Trusted:</span>
      <span class="stat-value" style="color: var(--pg-status-trusted);">${trustedCount}</span>
    </div>
    <div class="stat-item">
      <span class="stat-label">Failed:</span>
      <span class="stat-value" style="color: var(--pg-status-failed);">${failedCount}</span>
    </div>
    <div class="stat-item">
      <span class="stat-label">Unverified:</span>
      <span class="stat-value" style="color: var(--pg-status-unverified);">${unverifiedCount}</span>
    </div>
    <div class="stat-item">
      <span class="stat-label">Unknown:</span>
      <span class="stat-value" style="color: var(--pg-status-unknown);">${unknownCount}</span>
    </div>
    <div class="stat-item">
      <span class="stat-label">Project:</span>
      <span class="stat-value" style="font-size: 10px;">${escapeHtml(state.fullGraph.metadata.project_root)}</span>
    </div>
  `;
}

/**
 * Update node information panel
 */
function updateNodeInfo(): void {
  const nodeInfoDiv = document.getElementById('node-info');
  if (!nodeInfoDiv) return;

  const node = state.selectedNode || state.hoveredNode;

  if (!node || !state.filteredGraph) {
    nodeInfoDiv.innerHTML = '<p class="placeholder">Click or hover over a node to see details</p>';
    return;
  }

  // Get callers/callees from FULL graph (not filtered) to show complete info
  const allCallers = state.fullGraph ? getCallers(state.fullGraph, node.id) : [];
  const allCallees = state.fullGraph ? getCallees(state.fullGraph, node.id) : [];
  
  // Also get visible callers/callees for the list (only show what's in view)
  const visibleCallers = getCallers(state.filteredGraph, node.id);
  const visibleCallees = getCallees(state.filteredGraph, node.id);

  const callersHtml = allCallers.length > 0
    ? allCallers.map(n => {
        const isVisible = visibleCallers.some(vc => vc.id === n.id);
        return `<li${!isVisible ? ' style="opacity: 0.5;"' : ''}>${escapeHtml(n.display_name)}${!isVisible ? ' <em>(filtered)</em>' : ''}</li>`;
      }).join('')
    : '<li><em>None</em></li>';

  const calleesHtml = allCallees.length > 0
    ? allCallees.map(n => {
        const isVisible = visibleCallees.some(vc => vc.id === n.id);
        return `<li${!isVisible ? ' style="opacity: 0.5;"' : ''}>${escapeHtml(n.display_name)}${!isVisible ? ' <em>(filtered)</em>' : ''}</li>`;
      }).join('')
    : '<li><em>None</em></li>';

  const githubLink = buildGitHubLink(node);
  const isBlueprintNode = node.language === BLUEPRINT_LANGUAGE;
  const loc = sourceLocation(node);
  const sourcePath = loc?.path ?? '';
  const sourceFile = isBlueprintNode ? sourcePath.split('/').pop() ?? '' : node.file_name;
  const startLine = loc?.start;
  const endLine = loc?.end;
  const lineInfo = startLine
    ? (endLine && endLine !== startLine
        ? `Lines ${startLine}-${endLine}`
        : `Line ${startLine}`)
    : '';

  let blueprintHtml = '';
  if (node.blueprint && isBlueprintNode) {
    const configs = state.fullGraph?.metadata.source_configs;
    blueprintHtml = blueprintNodeDetailsHtml(node.blueprint, {
      repo: configs ? pickSourceConfig(configs, 'lean', sourcePath)?.github_url : undefined,
      codeName: id => codeLayer?.nodes.find(n => n.id === id)?.display_name,
    });
  } else if (node.blueprint) {
    blueprintHtml = blueprintBackrefHtml(node.blueprint);
  }
  const [callersLabel, calleesLabel] = isBlueprintNode ? ['Used by', 'Uses'] : ['Callers', 'Callees'];

  // Get verification status badge
  const getVerificationBadge = (status: string | undefined): string => {
    switch (status) {
      case 'verified':
        return '<div class="node-badge badge-verified">✓ Verified</div>';
      case 'transitively-verified':
        return '<div class="node-badge badge-verified">✓✓ Transitively verified</div>';
      case 'trusted':
        return '<div class="node-badge badge-trusted">◆ Trusted</div>';
      case 'failed':
        return '<div class="node-badge badge-failed">✗ Failed</div>';
      case 'unverified':
        return '<div class="node-badge badge-unverified">○ Unverified</div>';
      default:
        return '<div class="node-badge badge-unknown">? Unknown</div>';
    }
  };

  const getKindBadge = (kind: string | undefined): string => {
    if (!kind) return '';
    const { proofKinds, specKinds, axiomKinds } = getKindSetsForLanguage(state.projectLanguage);
    let badgeClass = 'exec-badge';
    if (proofKinds.has(kind)) badgeClass = 'proof-badge';
    else if (specKinds.has(kind) || axiomKinds.has(kind)) badgeClass = 'spec-badge';
    return `<span class="${badgeClass}" style="font-size: 0.75rem;">${escapeHtml(kind)}</span>`;
  };

  const getLanguageBadge = (lang: string | undefined): string => {
    if (!lang) return '';
    if (lang === 'rust') return '<span class="lang-badge-rust" style="font-size: 0.75rem;">Rust</span>';
    if (lang === 'lean') return '<span class="lang-badge-lean" style="font-size: 0.75rem;">Lean</span>';
    return '';
  };

  // Build Lean Translation section (for Rust nodes with a mapping to Lean)
  let mappingHtml = '';
  if (node.mapping_id && state.fullGraph) {
    const mappingNode = state.fullGraph.nodes.find(n => n.id === node.mapping_id);
    const mappingName = mappingNode?.display_name || node.mapping_id;
    const mappingLineInfo = node.mapping_lines
      ? ` (L${node.mapping_lines.start}-${node.mapping_lines.end})`
      : '';
    mappingHtml = `
      <div class="node-detail">
        <strong>Lean Translation:</strong>
        <ul class="node-list">
          <li><a href="#" class="navigate-to-node" data-node-id="${escapeHtml(node.mapping_id)}" style="cursor:pointer; text-decoration:underline; color:var(--pg-edge-mapping);">${escapeHtml(mappingName)}</a>
          <span style="color: var(--pg-text-faint); font-size: 0.85rem;">${escapeHtml(node.mapping_path)}${escapeHtml(mappingLineInfo)}</span></li>
        </ul>
      </div>`;
  }

  // Build Specifications section (for Lean nodes with specs)
  let specsHtml = '';
  if (node.specs && node.specs.length > 0 && state.fullGraph) {
    const specItems = node.specs.map(specId => {
      const specNode = state.fullGraph!.nodes.find(n => n.id === specId);
      const specName = specNode?.display_name || specId;
      const vs = specNode?.verification_status;
      const vsBadge = vs === 'verified' ? '<span style="color:var(--pg-status-verified); margin-left:4px;">&#10003;</span>'
        : vs === 'transitively-verified' ? '<span style="color:var(--pg-status-transitively-verified); margin-left:4px;">&#10003;</span>'
        : vs === 'trusted' ? '<span style="color:var(--pg-status-trusted); margin-left:4px;">&#9670;</span>'
        : vs === 'failed' ? '<span style="color:var(--pg-status-failed); margin-left:4px;">&#10007;</span>'
        : vs === 'unverified' ? '<span style="color:var(--pg-status-unverified); margin-left:4px;">&#9675;</span>'
        : '';
      return `<li><a href="#" class="navigate-to-node" data-node-id="${escapeHtml(specId)}" style="cursor:pointer; text-decoration:underline; color:var(--pg-edge-spec);">${escapeHtml(specName)}</a>${vsBadge}</li>`;
    }).join('');
    specsHtml = `
      <div class="node-detail">
        <strong>Specifications (${node.specs.length}):</strong>
        <ul class="node-list">${specItems}</ul>
      </div>`;
  }

  // Build Rust Source section (for Lean nodes with rust_source)
  let rustSourceHtml = '';
  if (node.rust_source && node.language === 'lean') {
    rustSourceHtml = `
      <div class="node-detail">
        <strong>Rust Source:</strong>
        <code class="code-block" style="font-size: 0.85rem;">${escapeHtml(node.rust_source)}</code>
      </div>`;
  }

  nodeInfoDiv.innerHTML = `
    <div class="node-detail">
      <h3>${escapeHtml(node.display_name)}</h3>
      <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;">
        ${isBlueprintNode ? '' : `<div class="node-badge ${node.is_libsignal ? 'badge-libsignal' : 'badge-other'}">
          ${node.is_libsignal ? 'Libsignal' : 'External'}
        </div>`}
        ${getVerificationBadge(node.verification_status)}
        ${getKindBadge(node.kind)}
        ${getLanguageBadge(node.language)}
      </div>
    </div>
    ${blueprintHtml}
    ${sourcePath ? `
    <div class="node-detail">
      <strong>File:</strong> ${escapeHtml(sourceFile)}
      ${lineInfo ? `<span style="color: var(--pg-text-faint); margin-left: 0.5rem;">(${escapeHtml(lineInfo)})</span>` : ''}
    </div>
    <div class="node-detail">
      <strong>Path:</strong>
      <code class="code-block">${escapeHtml(sourcePath)}</code>
    </div>` : ''}
    <div class="node-detail">
      <button id="navigate-to-source-btn" class="github-link" style="background: none; border: none; cursor: pointer; padding: 0; text-decoration: underline; color: inherit;">
        ${isVSCodeEnvironment() ? 'Open in Editor' : (githubLink ? 'View on GitHub' : '')}
      </button>
    </div>
    ${mappingHtml}
    ${specsHtml}
    ${rustSourceHtml}
    <div class="node-detail">
      <strong>${callersLabel} (${allCallers.length}):</strong>
      <ul class="node-list">${callersHtml}</ul>
    </div>
    <div class="node-detail">
      <strong>${calleesLabel} (${allCallees.length}):</strong>
      <ul class="node-list">${calleesHtml}</ul>
    </div>
    ${node.similar_lemmas && node.similar_lemmas.length > 0 ? `
      <div class="node-detail">
        <strong>Similar Lemmas:</strong>
        <ul class="similar-lemmas-list">
          ${node.similar_lemmas.map(lemma => `
            <li class="similar-lemma-item">
              <span class="similar-lemma-name">${escapeHtml(lemma.name)}</span>
              <span class="similar-lemma-score">${(lemma.score * 100).toFixed(0)}%</span>
              <div class="similar-lemma-meta">
                ${escapeHtml(lemma.file_path)}${lemma.line_number ? `:${escapeHtml(lemma.line_number)}` : ''}
              </div>
            </li>
          `).join('')}
        </ul>
      </div>
    ` : ''}
  `;

  // Add click handler for navigate button
  const navigateBtn = document.getElementById('navigate-to-source-btn');
  if (navigateBtn && node) {
    navigateBtn.addEventListener('click', () => {
      navigateToSource(node);
    });
  }

  // Add click handlers for cross-reference navigation links
  nodeInfoDiv.querySelectorAll('.navigate-to-node').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const targetId = (el as HTMLElement).dataset.nodeId;
      if (!targetId || !state.fullGraph) return;
      const targetNode = state.fullGraph.nodes.find(n => n.id === targetId);
      if (targetNode) {
        const newState = { ...state };
        newState.selectedNode = targetNode;
        handleStateChange(newState, false);
      }
    });
  });
}

/**
 * Information about a file entry for the file list
 */
interface FileListEntry {
  fileName: string;           // Base file name (e.g., "edwards.rs")
  relativePath: string;       // Full relative path (e.g., "curve25519-dalek/src/edwards.rs")
  displayName: string;        // Display name with disambiguation if needed
  filterPattern: string;      // Pattern to use in the filter (may include path for disambiguation)
  count: number;              // Number of functions in this file
  isDuplicate: boolean;       // Whether this filename has duplicates
}

/**
 * Compute the shortest disambiguating path suffix for a set of paths
 * For example, given:
 *   - "curve25519-dalek/src/edwards.rs"
 *   - "curve25519-dalek/src/backend/vector/ifma/edwards.rs"
 * Returns:
 *   - "src/edwards.rs"
 *   - "ifma/edwards.rs"
 */
function computeDisambiguatedPaths(paths: string[]): Map<string, string> {
  const result = new Map<string, string>();
  
  if (paths.length <= 1) {
    // No disambiguation needed
    paths.forEach(p => {
      const fileName = p.split('/').pop() || p;
      result.set(p, fileName);
    });
    return result;
  }
  
  // Split each path into segments (reversed for bottom-up comparison)
  const pathSegments = paths.map(p => p.split('/').reverse());
  
  // For each path, find the minimum number of segments needed to be unique
  for (let i = 0; i < paths.length; i++) {
    const segments = pathSegments[i];
    let numSegments = 1;  // Start with just the filename
    
    // Increase segments until this path is unique among all paths
    while (numSegments < segments.length) {
      const suffix = segments.slice(0, numSegments).reverse().join('/');
      
      // Check if any other path has the same suffix
      let isUnique = true;
      for (let j = 0; j < paths.length; j++) {
        if (i === j) continue;
        const otherSuffix = pathSegments[j].slice(0, numSegments).reverse().join('/');
        if (suffix === otherSuffix) {
          isUnique = false;
          break;
        }
      }
      
      if (isUnique) break;
      numSegments++;
    }
    
    const disambiguatedPath = segments.slice(0, numSegments).reverse().join('/');
    result.set(paths[i], disambiguatedPath);
  }
  
  return result;
}

/** Graph and selection the crate dropdowns were last built for. */
let crateDropdownKey = '';

/**
 * Populate the Source Crate / Target Crate dropdowns with unique crate names
 * and select selectedSourceCrate / selectedTargetCrate. A selection missing
 * from its filtered list is cleared. Skipped when nothing changed, since
 * setIntent calls this on every keystroke.
 */
function populateCrateDropdowns(): void {
  if (!state.fullGraph) return;

  const key = `${graphLoadGeneration}\0${selectedSourceCrate}\0${selectedTargetCrate}`;
  if (key === crateDropdownKey) return;

  ensureCrateGraphBuilt();

  const allCrateNames = new Set<string>();
  for (const node of state.fullGraph.nodes) {
    if (node.crate_name && node.crate_name !== 'unknown') {
      allCrateNames.add(node.crate_name);
    }
  }

  const allSorted = [...allCrateNames].sort((a, b) => a.localeCompare(b));

  const fill = (sel: HTMLSelectElement, names: string[], selected: string): string => {
    sel.innerHTML = '<option value="">--</option>';
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }
    const kept = names.includes(selected) ? selected : '';
    sel.value = kept;
    return kept;
  };

  // Source dropdown: filtered to callers of the selected target crate (or all if none)
  const srcSel = document.getElementById('source-crate-select') as HTMLSelectElement | null;
  if (srcSel) {
    const rdeps = selectedTargetCrate ? crateReverseDependencyMap.get(selectedTargetCrate) : null;
    const sourceList = rdeps ? allSorted.filter(n => rdeps.has(n)) : allSorted;
    selectedSourceCrate = fill(srcSel, sourceList, selectedSourceCrate);
  }

  // Target dropdown: filtered to dependencies of the selected source crate (or all if none)
  const tgtSel = document.getElementById('target-crate-select') as HTMLSelectElement | null;
  if (tgtSel) {
    const deps = selectedSourceCrate ? crateDependencyMap.get(selectedSourceCrate) : null;
    const targetList = deps ? allSorted.filter(n => deps.has(n)) : allSorted;
    selectedTargetCrate = fill(tgtSel, targetList, selectedTargetCrate);
  }

  crateDropdownKey = `${graphLoadGeneration}\0${selectedSourceCrate}\0${selectedTargetCrate}`;
}

/**
 * Populate the file list panel with unique files from the graph
 * Shows disambiguated names for files with duplicate names
 */
function populateFileList(): void {
  if (!state.fullGraph) return;
  
  const fileListDiv = document.getElementById('file-list');
  const fileCountSpan = document.getElementById('file-count');
  if (!fileListDiv) return;

  // Group nodes by file_name and relative_path
  // Key: relative_path, Value: { fileName, count }
  const filesByPath = new Map<string, { fileName: string; count: number }>();
  state.fullGraph.nodes.forEach(node => {
    const fileName = node.file_name || 'unknown';
    const relativePath = node.relative_path || fileName;
    
    const existing = filesByPath.get(relativePath);
    if (existing) {
      existing.count++;
    } else {
      filesByPath.set(relativePath, { fileName, count: 1 });
    }
  });

  // Group by filename to detect duplicates
  const pathsByFileName = new Map<string, string[]>();
  for (const [relativePath, { fileName }] of filesByPath) {
    if (!pathsByFileName.has(fileName)) {
      pathsByFileName.set(fileName, []);
    }
    pathsByFileName.get(fileName)!.push(relativePath);
  }

  // Build file list entries with disambiguation
  const entries: FileListEntry[] = [];
  
  for (const [fileName, paths] of pathsByFileName) {
    const isDuplicate = paths.length > 1;
    
    if (isDuplicate) {
      // Compute disambiguated paths
      const disambiguated = computeDisambiguatedPaths(paths);
      
      for (const relativePath of paths) {
        const { count } = filesByPath.get(relativePath)!;
        const disambiguatedPath = disambiguated.get(relativePath)!;
        
        entries.push({
          fileName,
          relativePath,
          displayName: fileName,
          filterPattern: disambiguatedPath,  // Use disambiguated path for filtering
          count,
          isDuplicate: true,
        });
      }
    } else {
      // No duplication, use simple filename
      const relativePath = paths[0];
      const { count } = filesByPath.get(relativePath)!;
      
      entries.push({
        fileName,
        relativePath,
        displayName: fileName,
        filterPattern: fileName,  // Simple filename for filtering
        count,
        isDuplicate: false,
      });
    }
  }

  // Sort entries: first by filename, then by path for duplicates
  entries.sort((a, b) => {
    const nameCompare = a.fileName.localeCompare(b.fileName);
    if (nameCompare !== 0) return nameCompare;
    return a.relativePath.localeCompare(b.relativePath);
  });

  // Update count (unique relative paths)
  if (fileCountSpan) {
    fileCountSpan.textContent = entries.length.toString();
  }

  // Build file list HTML
  fileListDiv.innerHTML = entries.map(entry => {
    const disambigHtml = entry.isDuplicate 
      ? `<span class="file-disambig">(${escapeHtml(entry.filterPattern.replace('/' + entry.fileName, ''))})</span>`
      : '';
    
    return `
      <div class="file-list-item${entry.isDuplicate ? ' has-duplicates' : ''}" 
           data-file="${escapeHtml(entry.filterPattern)}"
           data-path="${escapeHtml(entry.relativePath)}"
           title="${escapeHtml(entry.relativePath)}">
        <span class="file-icon">📄</span>
        <span class="file-name">${escapeHtml(entry.fileName)}</span>
        ${disambigHtml}
        <span class="file-count">${entry.count}</span>
      </div>
    `;
  }).join('');

  // Add click handlers to toggle file selection
  fileListDiv.querySelectorAll('.file-list-item').forEach(item => {
    item.addEventListener('click', () => {
      const filterPattern = item.getAttribute('data-file');
      if (filterPattern) {
        toggleFileInFilter(filterPattern);
      }
    });
  });

  // Update selection state based on current filter
  updateFileListSelection();
}

/** Empty the file list until populateFileList runs for the current graph. */
function clearFileList(): void {
  const fileListDiv = document.getElementById('file-list');
  if (fileListDiv) fileListDiv.innerHTML = '';
  const fileCountSpan = document.getElementById('file-count');
  if (fileCountSpan) fileCountSpan.textContent = '0';
}

/**
 * Information about a file that matches an ambiguous pattern
 */
interface AmbiguousFileMatch {
  fileName: string;
  relativePath: string;
  disambiguatedPath: string;
  count: number;
}

/**
 * Find files that match an ambiguous pattern (filename without path)
 * Returns null if not ambiguous, or array of matches if multiple files match
 */
function findAmbiguousMatches(pattern: string): AmbiguousFileMatch[] | null {
  if (!state.fullGraph) return null;
  
  // Only check for ambiguity if pattern is a simple filename (no path separators, no complex globs)
  if (pattern.includes('/') || pattern.includes('**')) {
    return null;  // Already disambiguated or complex pattern
  }
  
  // Convert simple glob to regex
  let regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  regexStr = regexStr.replace(/\*/g, '.*');
  regexStr = regexStr.replace(/\?/g, '.');
  const regex = new RegExp('^' + regexStr + '$', 'i');
  
  // Find all files that match this pattern
  const filesByPath = new Map<string, { fileName: string; count: number }>();
  state.fullGraph.nodes.forEach(node => {
    const fileName = node.file_name || '';
    const relativePath = node.relative_path || fileName;
    
    if (regex.test(fileName)) {
      const existing = filesByPath.get(relativePath);
      if (existing) {
        existing.count++;
      } else {
        filesByPath.set(relativePath, { fileName, count: 1 });
      }
    }
  });
  
  // If only one file matches, not ambiguous
  if (filesByPath.size <= 1) {
    return null;
  }
  
  // Multiple files match - compute disambiguated paths
  const paths = Array.from(filesByPath.keys());
  const disambiguated = computeDisambiguatedPaths(paths);
  
  const matches: AmbiguousFileMatch[] = [];
  for (const [relativePath, { fileName, count }] of filesByPath) {
    matches.push({
      fileName,
      relativePath,
      disambiguatedPath: disambiguated.get(relativePath) || relativePath,
      count,
    });
  }
  
  // Sort by path for consistent display
  matches.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  
  return matches;
}

/**
 * Current disambiguation state
 */
let disambiguationState: {
  pattern: string;
  matches: AmbiguousFileMatch[];
  selectedPaths: Set<string>;
} | null = null;

/**
 * Show the disambiguation dropdown for an ambiguous pattern
 */
function showDisambiguationDropdown(pattern: string, matches: AmbiguousFileMatch[]): void {
  const dropdown = document.getElementById('file-disambiguation-dropdown');
  if (!dropdown) return;
  
  disambiguationState = {
    pattern,
    matches,
    selectedPaths: new Set(),
  };
  
  // Build dropdown HTML
  dropdown.innerHTML = `
    <div class="dropdown-header">
      Multiple files match "<strong>${escapeHtml(pattern)}</strong>" - select which to include:
    </div>
    ${matches.map((match, index) => `
      <div class="dropdown-item" data-path="${escapeHtml(match.disambiguatedPath)}" data-index="${index}">
        <input type="checkbox" class="checkbox" />
        <span class="file-name">${escapeHtml(match.fileName)}</span>
        <span class="file-path" title="${escapeHtml(match.relativePath)}">${escapeHtml(match.disambiguatedPath.replace('/' + match.fileName, ''))}</span>
        <span class="file-count" style="background: var(--pg-border-soft); padding: 2px 6px; border-radius: 10px; font-size: 0.7rem; color: var(--pg-text-muted);">${match.count}</span>
      </div>
    `).join('')}
    <div class="dropdown-actions">
      <button class="btn-all" title="Include all matching files">All</button>
      <button class="btn-cancel">Cancel</button>
      <button class="btn-apply">Apply</button>
    </div>
  `;
  
  // Show dropdown
  dropdown.style.display = 'block';
  
  // Add click handlers for items
  dropdown.querySelectorAll('.dropdown-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      // Don't toggle if clicking the checkbox directly (it will toggle itself)
      if (target.tagName === 'INPUT') return;
      
      const checkbox = item.querySelector('input[type="checkbox"]') as HTMLInputElement;
      if (checkbox) {
        checkbox.checked = !checkbox.checked;
        item.classList.toggle('selected', checkbox.checked);
        
        const path = item.getAttribute('data-path');
        if (path) {
          if (checkbox.checked) {
            disambiguationState?.selectedPaths.add(path);
          } else {
            disambiguationState?.selectedPaths.delete(path);
          }
        }
      }
    });
    
    // Handle checkbox changes directly
    const checkbox = item.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox?.addEventListener('change', () => {
      item.classList.toggle('selected', checkbox.checked);
      const path = item.getAttribute('data-path');
      if (path) {
        if (checkbox.checked) {
          disambiguationState?.selectedPaths.add(path);
        } else {
          disambiguationState?.selectedPaths.delete(path);
        }
      }
    });
  });
  
  // Add button handlers
  dropdown.querySelector('.btn-all')?.addEventListener('click', () => {
    // Select all and apply
    dropdown.querySelectorAll('.dropdown-item').forEach(item => {
      const checkbox = item.querySelector('input[type="checkbox"]') as HTMLInputElement;
      if (checkbox) {
        checkbox.checked = true;
        item.classList.add('selected');
        const path = item.getAttribute('data-path');
        if (path) disambiguationState?.selectedPaths.add(path);
      }
    });
    applyDisambiguationSelection();
  });
  
  dropdown.querySelector('.btn-cancel')?.addEventListener('click', () => {
    hideDisambiguationDropdown();
  });
  
  dropdown.querySelector('.btn-apply')?.addEventListener('click', () => {
    applyDisambiguationSelection();
  });
}

/**
 * Hide the disambiguation dropdown
 */
function hideDisambiguationDropdown(): void {
  const dropdown = document.getElementById('file-disambiguation-dropdown');
  if (dropdown) {
    dropdown.style.display = 'none';
  }
  disambiguationState = null;
}

/**
 * Apply the selection from the disambiguation dropdown
 */
function applyDisambiguationSelection(): void {
  if (!disambiguationState || disambiguationState.selectedPaths.size === 0) {
    hideDisambiguationDropdown();
    return;
  }
  
  const input = document.getElementById('include-files') as HTMLInputElement;
  if (!input) {
    hideDisambiguationDropdown();
    return;
  }
  
  // Get current patterns and replace the ambiguous one with selected paths
  const currentPatterns = input.value
    .split(',')
    .map(p => p.trim())
    .filter(p => p.length > 0);
  
  // Find and replace the ambiguous pattern
  const patternIndex = currentPatterns.findIndex(
    p => p.toLowerCase() === disambiguationState!.pattern.toLowerCase()
  );
  
  if (patternIndex >= 0) {
    // Replace the ambiguous pattern with selected paths
    currentPatterns.splice(patternIndex, 1, ...disambiguationState.selectedPaths);
  } else {
    // Pattern not found (maybe already modified), just add selected paths
    currentPatterns.push(...disambiguationState.selectedPaths);
  }
  
  // Update input and filter
  input.value = currentPatterns.join(', ');
  state.filters.includeFiles = input.value;
  
  hideDisambiguationDropdown();
  updateFileListSelection();
  applyFiltersAndUpdate();
}

/**
 * Check for ambiguous patterns in the include files input and show disambiguation if needed
 * Returns true if disambiguation dropdown was shown
 */
function checkAndShowDisambiguation(): boolean {
  console.log('checkAndShowDisambiguation called');
  if (!state.fullGraph) {
    console.log('No fullGraph loaded');
    return false;
  }
  
  const input = document.getElementById('include-files') as HTMLInputElement;
  if (!input) {
    console.log('No include-files input found');
    return false;
  }
  
  const patterns = input.value
    .split(',')
    .map(p => p.trim())
    .filter(p => p.length > 0);
  
  console.log('Checking patterns:', patterns);
  
  // Check each pattern for ambiguity
  for (const pattern of patterns) {
    const matches = findAmbiguousMatches(pattern);
    console.log(`Pattern "${pattern}" has ${matches?.length || 0} matches:`, matches);
    if (matches && matches.length > 1) {
      console.log('Showing disambiguation dropdown');
      showDisambiguationDropdown(pattern, matches);
      return true;
    }
  }
  
  console.log('No ambiguous patterns found');
  return false;
}

/**
 * Toggle a file in the include filter
 */
function toggleFileInFilter(fileName: string): void {
  const input = document.getElementById('include-files') as HTMLInputElement;
  if (!input) return;

  const currentPatterns = input.value
    .split(',')
    .map(p => p.trim())
    .filter(p => p.length > 0);

  const fileIndex = currentPatterns.indexOf(fileName);
  if (fileIndex >= 0) {
    // Remove the file
    currentPatterns.splice(fileIndex, 1);
  } else {
    // Add the file
    currentPatterns.push(fileName);
  }

  // Update input and filter
  input.value = currentPatterns.join(', ');
  state.filters.includeFiles = input.value;
  updateFileListSelection();
  applyFiltersAndUpdate();
}

/**
 * Update the file list to show which files are currently selected
 */
function updateFileListSelection(): void {
  const fileListDiv = document.getElementById('file-list');
  if (!fileListDiv) return;

  const currentPatterns = state.filters.includeFiles
    .split(',')
    .map(p => p.trim().toLowerCase())
    .filter(p => p.length > 0);

  fileListDiv.querySelectorAll('.file-list-item').forEach(item => {
    const filterPattern = item.getAttribute('data-file')?.toLowerCase() || '';
    const relativePath = item.getAttribute('data-path')?.toLowerCase() || '';
    
    const isSelected = currentPatterns.some(pattern => {
      // Check for exact match with the filter pattern first
      if (filterPattern === pattern) return true;
      
      // Check if pattern matches the relative path (for path-based patterns)
      if (pattern.includes('/')) {
        // Path pattern - check if relative path ends with or contains this pattern
        if (relativePath.endsWith(pattern) || relativePath.includes('/' + pattern)) {
          return true;
        }
      }
      
      // Check glob pattern matching
      if (pattern.includes('*') || pattern.includes('?')) {
        // Convert glob to regex for matching
        const regexStr = pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]')
          .replace(/<<<DOUBLESTAR>>>/g, '.*');
        
        // For path patterns, match against relative path
        if (pattern.includes('/')) {
          const pathRegex = new RegExp('(^|/)' + regexStr + '$', 'i');
          return pathRegex.test(relativePath);
        }
        // For filename patterns, match against the filter pattern (filename or disambig path)
        return new RegExp('^' + regexStr + '$', 'i').test(filterPattern);
      }
      
      // Simple filename match (no glob, no path)
      // Extract just the filename from the filter pattern for comparison
      const justFileName = filterPattern.split('/').pop() || filterPattern;
      return justFileName === pattern;
    });
    
    if (currentPatterns.length === 0) {
      // No filter = nothing selected (all shown)
      item.classList.remove('selected');
    } else {
      item.classList.toggle('selected', isSelected);
    }
  });
}

/**
 * Reset all filters
 */
function resetFilters(): void {
  // Deep copy filters - spread only does shallow copy, so Sets would be shared!
  state.filters = freshFilters(graphDefaultFilters ?? initialFilters);
  seededRequestedDepth = null;  // A reset drops the seeded depth request too

  // Every control from the defaults (the intent is already none)
  syncFilterUI();

  // Clears the intent (focus set included), inputs and crate dropdowns
  setIntent(NONE_INTENT, { history: 'replace' });
}

/**
 * Update the focus set indicator in the UI
 */
function updateFocusIndicator(): void {
  const container = document.getElementById('focus-indicator');
  if (!container) return;
  
  const intent = state.filters.intent;
  if (!isFocusIntent(intent)) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  const focusCount = intent.ids.length;

  container.style.display = 'block';
  container.innerHTML = `
    <div style="background: var(--pg-accent-soft); padding: 10px; border-radius: 6px; border-left: 4px solid var(--pg-accent);">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <strong style="color: var(--pg-accent);">Focus Set Active</strong>
          <div style="font-size: 0.85rem; color: var(--pg-text-muted); margin-top: 2px;">
            Showing <strong>${focusCount}</strong> entry-point functions<span id="focus-label"></span>
          </div>
        </div>
        <button id="clear-focus-btn" style="background: var(--pg-accent); color: white; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 0.8rem;">
          Clear
        </button>
      </div>
      <div style="font-size: 0.75rem; color: var(--pg-text-faint); margin-top: 4px;">
        Use Source/Sink to expand beyond the focus set
      </div>
    </div>
  `;
  
  const labelEl = document.getElementById('focus-label');
  if (labelEl && intent.label) labelEl.textContent = ` (${intent.label})`;

  // Add click handler for Clear button
  document.getElementById('clear-focus-btn')?.addEventListener('click', () => {
    clearFocusSet();
  });
}

/**
 * Clear the focus set and return to the full graph view
 */
function clearFocusSet(): void {
  setIntent(NONE_INTENT, { history: 'replace' });
}

/**
 * Update the hidden nodes UI
 */
function updateHiddenNodesUI(): void {
  const container = document.getElementById('hidden-nodes-container');
  const list = document.getElementById('hidden-nodes-list');
  const count = document.getElementById('hidden-count');
  
  if (!container || !list || !count) return;
  
  const hiddenCount = state.filters.hiddenNodes.size;
  count.textContent = hiddenCount.toString();
  
  if (hiddenCount === 0) {
    container.style.display = 'none';
    return;
  }
  
  container.style.display = 'block';
  
  // Build list of hidden nodes
  const nodeMap = new Map(state.fullGraph?.nodes.map(n => [n.id, n]) || []);
  list.innerHTML = '';
  
  state.filters.hiddenNodes.forEach(nodeId => {
    const node = nodeMap.get(nodeId);
    if (node) {
      const item = document.createElement('li');
      item.className = 'hidden-node-item';
      item.textContent = node.display_name;
      item.title = 'Click to unhide';
      item.style.cursor = 'pointer';
      item.addEventListener('click', () => {
        state.filters.hiddenNodes.delete(nodeId);
        applyFiltersAndUpdate();
      });
      list.appendChild(item);
    }
  });
}

/**
 * Show all hidden nodes
 */
function showAllHiddenNodes(): void {
  state.filters.hiddenNodes.clear();
  applyFiltersAndUpdate();
}

/**
 * Handle window resize
 */
function handleResize(): void {
  const graphContainer = document.getElementById('graph-container');
  if (!graphContainer || !visualization) return;
  
  const rect = graphContainer.getBoundingClientRect();
  visualization.resize(rect.width, rect.height);
}

// ============================================================================
// VS Code Message Handler
// ============================================================================

/**
 * Handle messages from VS Code extension
 */
function handleVSCodeMessage(event: MessageEvent): void {
  const message = event.data;
  
  switch (message.type) {
    case 'loadGraph':
      // Load graph data sent from extension
      if (message.graph) {
        // Normalize the graph format (supports both D3Graph and simplified formats)
        const normalizedGraph = parseAndNormalizeGraph(message.graph);
        console.log('[VS Code] Received graph data:', normalizedGraph.nodes?.length, 'nodes');
        
        const initialQuery = message.initialQuery ?? {};
        const selectedId: string | undefined = message.selectedNodeId || undefined;
        // The editor's selection and query name code declarations
        const editorQuery = !!(selectedId || initialQuery.source || initialQuery.sink);
        loadGraph(normalizedGraph, 'Loaded from VS Code extension', editorQuery ? 'code' : undefined);

        const selectedNode = selectedId
          ? state.fullGraph?.nodes.find(n => n.id === selectedId)
          : undefined;
        let intent: QueryIntent;
        if (selectedNode) {
          console.log('[VS Code] Selected node ID:', selectedNode.id.slice(-60));
          intent = vscodeIntent(
            selectedNode.id, selectedNode.display_name,
            !!initialQuery.source, !!initialQuery.sink,
          );
        } else {
          intent = textIntent(initialQuery.source ?? '', initialQuery.sink ?? '');
        }
        if (intent.kind !== 'none' || initialQuery.depth !== undefined) {
          setIntent(intent, {
            history: 'replace',
            before: () => {
              // An explicit depth wins; a directional exact intent uses
              // unlimited depth, as Guide transitions do
              const depth: number | null | undefined = initialQuery.depth !== undefined
                ? (initialQuery.depth || null)
                : intent.kind === 'ids' && intent.dir !== 'none' ? null : undefined;
              if (depth !== undefined) {
                state.filters.maxDepth = depth;
                syncDepthSliderUI(depth);
              }
            },
          });
        }
      }
      break;
      
    case 'setQuery':
      // Update the query (e.g., user clicked on a different function)
      if (activeLayer !== 'code') switchLayer('code');
      setIntent(
        vscodeSetQueryIntent(state.filters.intent, message.source, message.sink),
        { history: 'replace' },
      );
      break;
      
    case 'refresh':
      // Reload the graph (extension will send new data)
      postMessageToExtension({ type: 'requestRefresh' });
      break;
  }
}

/**
 * Setup VS Code integration if running in webview
 */
function setupVSCodeIntegration(): void {
  if (!isVSCodeEnvironment()) {
    return;
  }
  
  console.log('[VS Code] Running in VS Code webview');
  
  // Listen for messages from extension
  window.addEventListener('message', handleVSCodeMessage);
  
  // Hide file input (not needed in VS Code)
  const fileInputContainer = document.querySelector('.file-input-container') as HTMLElement;
  if (fileInputContainer) {
    fileInputContainer.style.display = 'none';
  }
  
  // Update title
  const header = document.querySelector('.header h1');
  if (header) {
    header.textContent = 'Call Graph Explorer';
  }
  
  // Notify extension that we're ready
  postMessageToExtension({ type: 'ready' });
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', init);

