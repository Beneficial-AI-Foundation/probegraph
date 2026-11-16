/**
 * Packed Map view: a bird's-eye view of the Rust code. Crates, directories
 * and files are nested circles (d3.pack); the smallest circles are `exec`
 * functions, sized by connectivity and filled with their verification
 * status. Plan: docs/plans/packed-map.md.
 */

import * as d3 from 'd3';
import { D3Graph, D3Node, GraphState } from './types';
import { buildHierarchyTree, HierarchyGroup } from './hierarchy';
import { statusColor, edgeTypeColor, STATUS_COLORS, SELECTION_COLOR } from './theme';
import { escapeHtml } from './html';

// ============================================================================
// Data model (pure, unit-tested)
// ============================================================================

/**
 * Whether the Packed Map draws `node`: Rust code only. Older graphs have no
 * `kind`; the kind filters treat that as `exec` too (renderKindFilters).
 */
export function isPackedMapNode(node: D3Node): boolean {
  return (node.kind || 'exec') === 'exec';
}

/** Whether `graph` has anything the Packed Map can draw. */
export function hasPackedMapNodes(graph: D3Graph | null): boolean {
  return !!graph && graph.nodes.some(isPackedMapNode);
}

function endpointId(end: string | D3Node): string {
  return typeof end === 'string' ? end : end.id;
}

/**
 * The Packed Map's part of a filtered graph: its `exec` nodes and the links
 * between them. Applied in the filter step, so stats and node details count
 * what the view draws.
 */
export function restrictToPackedNodes(graph: D3Graph): D3Graph {
  const nodes = graph.nodes.filter(isPackedMapNode);
  if (nodes.length === graph.nodes.length) return graph;
  const ids = new Set(nodes.map(n => n.id));
  const links = graph.links.filter(l => ids.has(endpointId(l.source)) && ids.has(endpointId(l.target)));
  return { ...graph, nodes, links };
}

/**
 * Number of distinct neighbors of each node over `graph.links`, in either
 * direction. A node that both calls and is called by another counts it
 * once; self-calls and links to nodes outside the graph do not count.
 */
export function connectivity(graph: D3Graph): Map<string, number> {
  const neighbors = new Map<string, Set<string>>();
  for (const n of graph.nodes) neighbors.set(n.id, new Set());
  for (const l of graph.links) {
    const s = endpointId(l.source);
    const t = endpointId(l.target);
    if (s === t) continue;
    const ns = neighbors.get(s);
    const nt = neighbors.get(t);
    if (!ns || !nt) continue;
    ns.add(t);
    nt.add(s);
  }
  const degree = new Map<string, number>();
  for (const [id, set] of neighbors) degree.set(id, set.size);
  return degree;
}

export type PackKind = 'root' | 'crate' | 'dir' | 'file' | 'fn';

export interface PackDatum {
  /** `g:<group id>`, `f:<node id>`, or `root`: groups and functions cannot collide. */
  id: string;
  label: string;
  kind: PackKind;
  /** Leaf weight (1 + connectivity); 0 for groups, which d3 sums. */
  value: number;
  group?: HierarchyGroup;
  node?: D3Node;
  children?: PackDatum[];
}

/**
 * Pack input for `graph`: one synthetic root over the crate → directory →
 * file → function tree. Every group contributes its child groups and its
 * own functions (functions with no path sit directly under their crate).
 */
export function buildPackData(graph: D3Graph): PackDatum {
  const tree = buildHierarchyTree(graph);
  const degree = connectivity(graph);
  const nodeById = new Map(graph.nodes.map(n => [n.id, n]));

  const fnLeaf = (id: string): PackDatum => {
    const node = nodeById.get(id)!;
    return {
      id: `f:${id}`,
      label: node.display_name,
      kind: 'fn',
      value: 1 + (degree.get(id) ?? 0),
      node,
    };
  };

  const convert = (group: HierarchyGroup): PackDatum => ({
    id: `g:${group.id}`,
    label: group.label,
    kind: group.kind,
    value: 0,
    group,
    children: [...group.children.map(convert), ...group.nodeIds.map(fnLeaf)],
  });

  return { id: 'root', label: '', kind: 'root', value: 0, children: tree.roots.map(convert) };
}

/** A d3.zoom transform, as plain numbers: screen = data * k + (x, y). */
export interface Camera { k: number; x: number; y: number }

/**
 * The camera that fits the circle (cx, cy, r) in a width × height view,
 * centered, with `margin` (a fraction of the view) around it.
 */
export function fitCamera(
  cx: number, cy: number, r: number, width: number, height: number, margin = 0.05,
): Camera {
  const k = r > 0 ? (Math.min(width, height) * (1 - 2 * margin)) / (2 * r) : 1;
  return { k, x: width / 2 - k * cx, y: height / 2 - k * cy };
}

/** Screen size thresholds for labels, in px of circle radius (the plan gives diameters). */
export const GROUP_LABEL_MIN_R = 30;
export const FN_LABEL_MIN_R = 20;

/**
 * Ids of the groups whose label shows at zoom scale `k`. A group gets a
 * label when its screen radius is at least `minR`, unless one of its child
 * groups is that large too: then a label further down shows instead, and
 * labels do not stack.
 */
export function visibleGroupLabels(
  groups: ReadonlyArray<{ id: string; r: number; childIds: readonly string[] }>,
  k: number,
  minR = GROUP_LABEL_MIN_R,
): Set<string> {
  const large = new Set(groups.filter(g => g.r * k >= minR).map(g => g.id));
  const shown = new Set<string>();
  for (const g of groups) {
    if (large.has(g.id) && !g.childIds.some(c => large.has(c))) shown.add(g.id);
  }
  return shown;
}

/**
 * `text` cut to fit `maxWidth` px at `fontSize` px, ending with an
 * ellipsis when cut. Uses an average character width, not a measurement.
 * Empty when not even one character and the ellipsis fit.
 */
export function fitLabel(text: string, maxWidth: number, fontSize: number): string {
  const charWidth = fontSize * 0.6;
  const max = Math.floor(maxWidth / charWidth);
  if (text.length <= max) return text;
  if (max < 2) return '';
  return text.slice(0, max - 1) + '…';
}

export interface PackedEdge { source: string; target: string; type: string }

/**
 * The calls of `fnId` to and from other drawn functions, one per source,
 * target and type. Self-calls and calls to functions not in `drawn` are left out.
 */
export function edgesOf(
  links: ReadonlyArray<{ source: string | D3Node; target: string | D3Node; type: string }>,
  fnId: string,
  drawn: ReadonlySet<string>,
): PackedEdge[] {
  const seen = new Set<string>();
  const out: PackedEdge[] = [];
  for (const l of links) {
    const source = endpointId(l.source);
    const target = endpointId(l.target);
    if (source === target || (source !== fnId && target !== fnId)) continue;
    if (!drawn.has(source) || !drawn.has(target)) continue;
    const key = `${source}\0${target}\0${l.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source, target, type: l.type });
  }
  return out;
}

// ============================================================================
// Visualization
// ============================================================================

type PackNode = d3.HierarchyCircularNode<PackDatum>;

/**
 * Keyboard navigation over the function circles, in pack order (crate by
 * crate, file by file): the index `key` moves the focus to, or null for a
 * key that does not move it. The focus stops at both ends.
 */
export function nextFocusIndex(current: number, key: string, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return Math.min(current + 1, count - 1);
    case 'ArrowLeft':
    case 'ArrowUp':
      return Math.max(current - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

const GROUP_STROKE = 'rgba(100, 116, 139, 0.45)';
const ARC_WIDTH = 3;

function groupFill(depth: number): string {
  return `rgba(100, 116, 139, ${Math.min(0.05 + 0.035 * depth, 0.25)})`;
}

function verifiedFraction(group: HierarchyGroup): number {
  return group.fnCount > 0 ? group.verifiedCount / group.fnCount : 0;
}

/** Screen font sizes of the labels, px. */
const GROUP_FONT = 12;
const FN_FONT = 11;
/** Distance of a group label's baseline below the top of its circle, px. */
const GROUP_LABEL_INSET = 16;
const ZOOM_MS = 600;
const PLAIN_EDGE_COLOR = '#666';
const EDGE_TYPES = ['inner', 'precondition', 'postcondition', 'mapping', 'spec'];

function edgeColor(type: string): string {
  return edgeTypeColor(type, PLAIN_EDGE_COLOR);
}

function markerId(type: string): string {
  return `pm-arrow-${EDGE_TYPES.includes(type) ? type : 'inner'}`;
}

export class PackedMapVisualization {
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  /** Pack coordinates, under the camera transform. */
  private g: d3.Selection<SVGGElement, unknown, null, undefined>;
  /** Screen coordinates: edges and labels, redrawn on every zoom event. */
  private overlay: d3.Selection<SVGGElement, unknown, null, undefined>;
  private zoom: d3.ZoomBehavior<SVGSVGElement, unknown>;
  private width: number;
  private height: number;
  private state: GraphState;
  private onStateChange: (state: GraphState, selectionChanged?: boolean) => void;
  private container: HTMLElement;
  private legendVisible = true;
  /**
   * Node ids and link endpoints of the drawn graph: an update with the same
   * graph keeps the layout. A new graph load resets it (`clear`), because the
   * ids can stay while statuses and paths change.
   */
  private layoutKey: string | null = null;
  private graph: D3Graph | null = null;
  private groupNodes: PackNode[] = [];
  private fnNodes: PackNode[] = [];
  private groupById = new Map<string, PackNode>();
  private fnById = new Map<string, PackNode>();
  /** Width and height the pack was laid out in; null before a layout. */
  private layoutSize: { width: number; height: number } | null = null;
  /** Ids of the drawn functions (the keys of `fnById`), for `edgesOf`. */
  private drawnIds: ReadonlySet<string> = new Set();
  /** Group pack id → its child group pack ids, for the label rules. */
  private groupChildIds = new Map<string, string[]>();
  /** Edges of one function in one graph: zoom events reuse them. */
  private edgeCache: { fnId: string; graph: D3Graph; edges: PackedEdge[] } | null = null;
  /** Hierarchy group id (no `g:` prefix) of the zoomed-to group; null: the whole project. */
  private focusId: string | null = null;
  private hoverId: string | null = null;
  /** Node id of the function with the keyboard focus ring (not the zoomed group). */
  private focusedId: string | null = null;

  constructor(
    container: HTMLElement,
    state: GraphState,
    onStateChange: (state: GraphState, selectionChanged?: boolean) => void,
  ) {
    this.container = container;
    this.state = state;
    this.onStateChange = onStateChange;

    const rect = container.getBoundingClientRect();
    this.width = rect.width || 800;
    this.height = rect.height || 600;

    this.svg = d3.select(container)
      .append('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('viewBox', `0 0 ${this.width} ${this.height}`)
      .attr('class', 'packed-map-svg')
      // One tab stop for the whole map; arrow keys move between functions
      .attr('tabindex', 0)
      .attr('role', 'listbox')
      .attr('aria-label', 'Packed Map functions. Arrow keys move between functions, Enter or Space opens the details.')
      .on('keydown', (event: KeyboardEvent) => this.handleMapKeyDown(event))
      .on('focus', () => this.renderFocus())
      .on('blur', () => this.renderFocus());

    const defs = this.svg.append('defs');
    for (const type of EDGE_TYPES) {
      defs.append('marker')
        .attr('id', markerId(type))
        .attr('viewBox', '0 -4 8 8')
        .attr('refX', 8)
        .attr('refY', 0)
        .attr('markerWidth', 7)
        .attr('markerHeight', 7)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-4L8,0L0,4')
        .attr('fill', edgeColor(type));
    }

    // One camera: wheel, drag and click zoom all change this transform
    this.zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 10000])
      .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        this.g.attr('transform', event.transform.toString());
        this.renderOverlay();
        this.renderFocus();
      });
    this.svg.call(this.zoom).on('dblclick.zoom', null);
    // A click on no circle: zoom out to the parent
    this.svg.on('click', (event: MouseEvent) => {
      if (event.target === this.svg.node()) this.zoomOut();
    });

    this.g = this.svg.append('g').attr('class', 'pm-camera');
    this.overlay = this.svg.append('g').attr('class', 'pm-overlay').attr('pointer-events', 'none');
    this.overlay.append('g').attr('class', 'pm-edges');
    this.overlay.append('g').attr('class', 'pm-labels');
    document.addEventListener('keydown', this.handleKeyDown);
    this.renderLegend();
  }

  // ----- Public interface -----

  public update(filteredGraph: D3Graph): void {
    if (!filteredGraph || filteredGraph.nodes.length === 0) {
      this.clear();
      this.showEmpty();
      return;
    }
    this.hideEmpty();

    const key = filteredGraph.nodes.map(n => n.id).join('\n') + '\0'
      + filteredGraph.links.map(l => `${endpointId(l.source)}>${endpointId(l.target)}`).join('\n');
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.render(filteredGraph);
    } else {
      // Same layout, but the links can differ in type (edge filters)
      this.graph = filteredGraph;
      // A `?packed=` id kept for this update (setFocus) that the layout lacks
      if (this.focusId && !this.groupById.has(this.focusId)) {
        this.focusId = null;
        this.svg.attr('data-packed-focus', '');
        this.notifyFocusChanged();
      }
    }
    this.renderSelection();
  }

  public destroy(): void {
    this.svg.interrupt();
    document.removeEventListener('keydown', this.handleKeyDown);
    this.svg.remove();
    this.container.querySelector('.pm-legend')?.remove();
    this.hideEmpty();
  }

  public resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.svg.interrupt();
    this.width = width;
    this.height = height;
    this.svg.attr('viewBox', `0 0 ${width} ${height}`);
    // Keep the layout; put the camera back on the focus in the new size
    if (this.layoutKey !== null) this.svg.call(this.zoom.transform, this.focusTransform());
  }

  public clear(): void {
    this.svg.interrupt();
    this.g.selectAll('*').remove();
    this.overlay.selectAll('.pm-edges > *, .pm-labels > *').remove();
    this.layoutKey = null;
    this.graph = null;
    this.groupNodes = [];
    this.fnNodes = [];
    this.groupById.clear();
    this.fnById.clear();
    this.layoutSize = null;
    this.drawnIds = new Set();
    this.groupChildIds.clear();
    this.edgeCache = null;
    this.hoverId = null;
  }

  /**
   * Zoom to a group by its hierarchy id (`?packed=`), or to the whole
   * project with null. Before a layout exists the id is kept for it.
   */
  public setFocus(groupId: string | null): void {
    this.focusId = groupId;
    if (this.layoutKey === null) return;
    // An id missing from this layout can belong to the next one (a load
    // calls this before its render), so it is kept until a render drops it
    this.svg.interrupt();
    const known = !groupId || this.groupById.has(groupId);
    this.svg.attr('data-packed-focus', known ? groupId ?? '' : '');
    this.svg.call(this.zoom.transform, known ? this.focusTransform() : d3.zoomIdentity);
  }

  public getFocus(): string | null {
    return this.focusId;
  }

  // ----- Camera -----

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    this.zoomOut();
  };

  private zoomOut(): void {
    if (this.layoutKey === null) return;
    const focus = this.focusId ? this.groupById.get(this.focusId) : undefined;
    const parent = focus?.parent;
    this.zoomToGroup(parent && parent.depth > 0 ? parent : null);
  }

  /** Animate the camera to fit `node`, or the whole project for null. */
  private zoomToGroup(node: PackNode | null): void {
    const id = node ? node.data.group!.id : null;
    const changed = id !== this.focusId;
    this.focusId = id;
    this.svg.interrupt();
    this.svg.transition().duration(ZOOM_MS).call(this.zoom.transform, this.focusTransform());
    this.svg.attr('data-packed-focus', id ?? '');
    if (changed) this.notifyFocusChanged();
  }

  /**
   * Put the camera on the focused group without animation. A focus that
   * is not in the layout (stale `?packed=`, filtered out) falls back to the
   * whole project.
   */
  private applyFocus(): void {
    this.svg.interrupt();
    if (this.focusId && !this.groupById.has(this.focusId)) {
      this.focusId = null;
      this.notifyFocusChanged();
    }
    this.svg.attr('data-packed-focus', this.focusId ?? '');
    this.svg.call(this.zoom.transform, this.focusTransform());
  }

  /**
   * The camera on the focused group, or on the whole pack. The pack fills
   * the view it was laid out in, so the whole pack is the identity until a
   * resize.
   */
  private focusTransform(): d3.ZoomTransform {
    const node = this.focusId ? this.groupById.get(this.focusId) : undefined;
    if (node) {
      const c = fitCamera(node.x, node.y, node.r, this.width, this.height);
      return d3.zoomIdentity.translate(c.x, c.y).scale(c.k);
    }
    const size = this.layoutSize;
    if (!size || (size.width === this.width && size.height === this.height)) return d3.zoomIdentity;
    // Scale the pack by the change of the shorter side, and center it
    const k = Math.min(this.width, this.height) / Math.min(size.width, size.height);
    return d3.zoomIdentity
      .translate((this.width - k * size.width) / 2, (this.height - k * size.height) / 2)
      .scale(k);
  }

  private notifyFocusChanged(): void {
    window.dispatchEvent(new CustomEvent('packed-focus-changed', { detail: { focus: this.focusId } }));
  }

  // ----- Rendering -----

  private render(graph: D3Graph): void {
    this.svg.interrupt();
    this.g.selectAll('*').remove();
    this.graph = graph;

    // Pack into the container's current size: it can change after construction
    const rect = this.container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.width = rect.width;
      this.height = rect.height;
      this.svg.attr('viewBox', `0 0 ${this.width} ${this.height}`);
    }

    const root = d3.hierarchy(buildPackData(graph))
      .sum(d => d.kind === 'fn' ? d.value : 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const packed: PackNode = d3.pack<PackDatum>()
      .size([this.width, this.height])
      .padding(d => d.depth === 0 ? 8 : 3)(root);

    const nodes = packed.descendants().filter(d => d.depth > 0);
    this.groupNodes = nodes.filter(d => d.data.kind !== 'fn');
    this.fnNodes = nodes.filter(d => d.data.kind === 'fn');
    this.groupById = new Map(this.groupNodes.map(d => [d.data.group!.id, d]));
    this.fnById = new Map(this.fnNodes.map(d => [d.data.node!.id, d]));
    this.layoutSize = { width: this.width, height: this.height };
    this.drawnIds = new Set(this.fnById.keys());
    this.groupChildIds = new Map(this.groupNodes.map(d => [
      d.data.id,
      (d.children ?? []).filter(c => c.data.kind !== 'fn').map(c => c.data.id),
    ]));
    this.edgeCache = null;
    if (this.hoverId && !this.fnById.has(this.hoverId)) this.hoverId = null;
    if (this.focusedId && !this.fnById.has(this.focusedId)) this.focusedId = null;

    const groupSel = this.g.append('g').attr('class', 'pm-groups')
      .selectAll<SVGGElement, PackNode>('g')
      .data(this.groupNodes)
      .join('g')
      .attr('class', 'pm-group')
      .attr('data-group-id', d => d.data.group!.id)
      .attr('transform', d => `translate(${d.x},${d.y})`)
      .style('cursor', 'zoom-in')
      .on('click', (event: MouseEvent, d) => {
        event.stopPropagation();
        this.zoomToGroup(d);
      });

    groupSel.append('circle')
      .attr('r', d => d.r)
      .attr('fill', d => groupFill(d.depth))
      .attr('stroke', GROUP_STROKE)
      .attr('stroke-width', 0.75)
      .attr('vector-effect', 'non-scaling-stroke');

    const arc = d3.arc<PackNode>()
      .innerRadius(d => d.r)
      .outerRadius(d => d.r + ARC_WIDTH)
      .startAngle(0)
      .endAngle(d => 2 * Math.PI * verifiedFraction(d.data.group!));
    groupSel.filter(d => verifiedFraction(d.data.group!) > 0)
      .append('path')
      .attr('class', 'pm-verified-arc')
      .attr('d', arc)
      .attr('fill', STATUS_COLORS['verified']);

    groupSel.append('title')
      .text(d => {
        const grp = d.data.group!;
        return `${grp.label}\n${grp.fnCount} functions, ${grp.verifiedCount} verified, transitively verified or trusted`;
      });

    this.g.append('g').attr('class', 'pm-fns')
      .selectAll<SVGCircleElement, PackNode>('circle')
      .data(this.fnNodes)
      .join('circle')
      .attr('class', 'pm-fn')
      .attr('data-node-id', d => d.data.node!.id)
      .attr('id', (_d, i) => `pm-fn-${i}`)
      .attr('role', 'option')
      .attr('aria-label', d => `${d.data.label}, ${d.data.node!.verification_status ?? 'no status'}`)
      .attr('cx', d => d.x)
      .attr('cy', d => d.y)
      .attr('r', d => d.r)
      .attr('fill', d => statusColor(d.data.node!.verification_status))
      .style('cursor', 'pointer')
      .on('click', (event: MouseEvent, d) => {
        event.stopPropagation();
        this.focusedId = d.data.node!.id;
        this.select(d);
      })
      .on('mouseenter', (_event: MouseEvent, d) => {
        this.hoverId = d.data.node!.id;
        this.renderEdges();
      })
      .on('mouseleave', () => {
        this.hoverId = null;
        this.renderEdges();
      })
      .append('title')
      .text(d => d.data.label);

    // Above the circles; drawn only while the map has the keyboard focus
    this.g.append('circle')
      .attr('class', 'pm-focus-ring')
      .attr('fill', 'none')
      .attr('stroke', 'var(--pg-text)')
      .attr('stroke-dasharray', '3 2')
      .attr('pointer-events', 'none')
      .style('display', 'none');

    // A new layout: the old camera points at nothing meaningful
    this.applyFocus();
  }

  private select(d: PackNode): void {
    this.state = { ...this.state, selectedNode: d.data.node! };
    this.renderSelection();
    this.renderFocus();
    this.onStateChange(this.state);
  }

  private renderSelection(): void {
    const selectedId = this.state.selectedNode?.id;
    this.g.selectAll<SVGCircleElement, PackNode>('.pm-fn')
      .attr('aria-selected', d => d.data.node!.id === selectedId ? 'true' : 'false')
      .attr('stroke', d => d.data.node!.id === selectedId ? SELECTION_COLOR : null)
      .attr('stroke-width', d => d.data.node!.id === selectedId ? 2 : null)
      .attr('vector-effect', d => d.data.node!.id === selectedId ? 'non-scaling-stroke' : null);
    this.renderEdges();
  }

  /** Edges and labels, in screen coordinates for the current camera. */
  private renderOverlay(): void {
    this.renderEdges();
    this.renderLabels();
  }

  /** Whether the screen circle (x, y, r) touches the view. */
  private onScreen(x: number, y: number, r: number): boolean {
    return x + r >= 0 && x - r <= this.width && y + r >= 0 && y - r <= this.height;
  }

  private renderLabels(): void {
    const t = d3.zoomTransform(this.svg.node()!);
    const visible = this.groupNodes.filter(d => this.onScreen(t.applyX(d.x), t.applyY(d.y), d.r * t.k));
    const shownIds = visibleGroupLabels(
      visible.map(d => ({
        id: d.data.id,
        r: d.r,
        childIds: this.groupChildIds.get(d.data.id) ?? [],
      })),
      t.k,
    );

    interface Label { id: string; x: number; y: number; text: string; size: number; kind: 'group' | 'fn' }
    const labels: Label[] = [];
    for (const d of visible) {
      if (!shownIds.has(d.data.id)) continue;
      const r = d.r * t.k;
      const inset = Math.min(GROUP_LABEL_INSET, r);
      // Chord of the circle at the label's baseline
      const width = 2 * Math.sqrt(Math.max(r * r - (r - inset) * (r - inset), 0)) * 0.9;
      const text = fitLabel(d.data.label, width, GROUP_FONT);
      if (text) labels.push({ id: d.data.id, x: t.applyX(d.x), y: t.applyY(d.y) - r + inset, text, size: GROUP_FONT, kind: 'group' });
    }
    for (const d of this.fnNodes) {
      const r = d.r * t.k;
      if (r < FN_LABEL_MIN_R) continue;
      const x = t.applyX(d.x);
      const y = t.applyY(d.y);
      if (!this.onScreen(x, y, r)) continue;
      const text = fitLabel(d.data.label, 2 * r * 0.85, FN_FONT);
      if (text) labels.push({ id: d.data.id, x, y: y + FN_FONT / 3, text, size: FN_FONT, kind: 'fn' });
    }

    this.overlay.select('.pm-labels')
      .selectAll<SVGTextElement, Label>('text')
      .data(labels, d => d.id)
      .join('text')
      .attr('class', d => `pm-label pm-label-${d.kind}`)
      .attr('x', d => d.x)
      .attr('y', d => d.y)
      .attr('text-anchor', 'middle')
      .attr('font-size', d => `${d.size}px`)
      .attr('font-weight', d => d.kind === 'group' ? 600 : 400)
      .text(d => d.text);
  }

  private renderEdges(): void {
    const layer = this.overlay.select('.pm-edges');
    const fnId = this.hoverId ?? this.state.selectedNode?.id ?? null;
    const from = fnId ? this.fnById.get(fnId) : undefined;
    if (!this.graph || !from) {
      layer.selectAll('*').remove();
      return;
    }
    const t = d3.zoomTransform(this.svg.node()!);
    if (!this.edgeCache || this.edgeCache.fnId !== fnId || this.edgeCache.graph !== this.graph) {
      this.edgeCache = { fnId: fnId!, graph: this.graph, edges: edgesOf(this.graph.links, fnId!, this.drawnIds) };
    }
    const edges = this.edgeCache.edges;

    const path = (e: PackedEdge): string => {
      const a = this.fnById.get(e.source)!;
      const b = this.fnById.get(e.target)!;
      const x1 = t.applyX(a.x), y1 = t.applyY(a.y);
      const x2 = t.applyX(b.x), y2 = t.applyY(b.y);
      const dx = x2 - x1, dy = y2 - y1;
      const dist = Math.hypot(dx, dy) || 1;
      // Bend to one side, so a call each way gives two curves
      const cx = (x1 + x2) / 2 - dy * 0.2;
      const cy = (y1 + y2) / 2 + dx * 0.2;
      // Start and end on the circles' edges, toward the control point
      const toward = (px: number, py: number, r: number) => {
        const ex = cx - px, ey = cy - py;
        const len = Math.hypot(ex, ey) || 1;
        const step = Math.min(r, dist / 3);
        return [px + (ex / len) * step, py + (ey / len) * step];
      };
      const [sx, sy] = toward(x1, y1, a.r * t.k);
      const [tx, ty] = toward(x2, y2, b.r * t.k);
      return `M${sx},${sy}Q${cx},${cy} ${tx},${ty}`;
    };

    layer.selectAll<SVGPathElement, PackedEdge>('path')
      .data(edges)
      .join('path')
      .attr('class', 'pm-edge')
      .attr('d', path)
      .attr('fill', 'none')
      .attr('stroke', d => edgeColor(d.type))
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', 0.85)
      .attr('marker-end', d => `url(#${markerId(d.type)})`);
  }

  // ----- Keyboard -----

  private focusedIndex(): number {
    return this.fnNodes.findIndex(d => d.data.node!.id === this.focusedId);
  }

  private handleMapKeyDown(event: KeyboardEvent): void {
    const count = this.fnNodes.length;
    if (count === 0) return;
    let index = this.focusedIndex();
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (index >= 0) this.select(this.fnNodes[index]);
      return;
    }
    // The first arrow key starts at the selected function, or else the first
    if (index < 0) {
      const selectedId = this.state.selectedNode?.id;
      index = Math.max(this.fnNodes.findIndex(d => d.data.node!.id === selectedId), 0);
      if (event.key.startsWith('Arrow')) {
        event.preventDefault();
        this.moveFocus(index);
        return;
      }
    }
    const next = nextFocusIndex(index, event.key, count);
    if (next === null) return;
    event.preventDefault();
    this.moveFocus(next);
  }

  private moveFocus(index: number): void {
    const d = this.fnNodes[index];
    this.focusedId = d.data.node!.id;
    // Keep the focused function on screen at the current zoom
    const svgNode = this.svg.node()!;
    const [sx, sy] = d3.zoomTransform(svgNode).apply([d.x, d.y]);
    if (sx < 0 || sx > this.width || sy < 0 || sy > this.height) {
      this.svg.interrupt();
      this.svg.call(this.zoom.translateTo, d.x, d.y);
    }
    this.renderFocus();
  }

  /** Draw the focus ring and set the active option while the map has the focus. */
  private renderFocus(): void {
    const svgNode = this.svg.node();
    const index = this.focusedIndex();
    const ring = this.g.select<SVGCircleElement>('.pm-focus-ring');
    if (!svgNode || index < 0 || document.activeElement !== svgNode) {
      ring.style('display', 'none');
      this.svg.attr('aria-activedescendant', null);
      return;
    }
    const d = this.fnNodes[index];
    const k = d3.zoomTransform(svgNode).k;
    ring.style('display', null)
      .attr('cx', d.x)
      .attr('cy', d.y)
      .attr('r', d.r + 3 / k)
      .attr('stroke-width', 1.5 / k);
    this.svg.attr('aria-activedescendant', `pm-fn-${index}`);
  }

  // ----- Empty state -----

  private showEmpty(): void {
    if (this.container.querySelector('.pm-empty')) return;
    const div = document.createElement('div');
    div.className = 'pm-empty';
    div.textContent = 'No Rust functions match the filters.';
    this.container.appendChild(div);
  }

  private hideEmpty(): void {
    this.container.querySelector('.pm-empty')?.remove();
  }

  // ----- Legend -----

  private renderLegend(): void {
    this.container.querySelector('.pm-legend')?.remove();

    const swatch = (status: string, label: string) => `
      <div class="hm-legend-item">
        <svg width="16" height="16"><circle cx="8" cy="8" r="6" fill="${statusColor(status)}"/></svg>
        <span>${escapeHtml(label)}</span>
      </div>`;

    const edgeSwatch = (type: string, label: string) => `
      <div class="hm-legend-item">
        <svg width="16" height="16"><line x1="1" y1="8" x2="15" y2="8" stroke="${edgeColor(type)}" stroke-width="2"/></svg>
        <span>${escapeHtml(label)}</span>
      </div>`;
    const hint = (text: string) =>
      `<div class="hm-legend-item"><span style="font-size:0.75rem; color:var(--pg-text-muted);">${escapeHtml(text)}</span></div>`;

    const legend = document.createElement('div');
    legend.className = 'hm-legend pm-legend';
    legend.innerHTML = `
      <div class="hm-legend-header pm-legend-toggle">
        <strong>Packed Map</strong> <span class="hm-legend-arrow">${this.legendVisible ? '▼' : '▶'}</span>
      </div>
      <div class="hm-legend-body" style="display:${this.legendVisible ? 'block' : 'none'}">
        <div class="hm-legend-item"><span>Rust (<code>exec</code>) functions only</span></div>
        <div class="hm-legend-section"><strong>Size</strong></div>
        <div class="hm-legend-item"><span>Function: 1 + distinct callers and callees</span></div>
        <div class="hm-legend-item"><span>Group: summed size of the functions inside</span></div>
        <div class="hm-legend-section"><strong>Color</strong></div>
        ${swatch('verified', 'Verified')}
        ${swatch('transitively-verified', 'Transitively verified')}
        ${swatch('trusted', 'Trusted')}
        ${swatch('failed', 'Failed')}
        ${swatch('unverified', 'Unverified')}
        ${swatch('unknown', 'No status')}
        <div class="hm-legend-item">
          <svg width="16" height="16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="${STATUS_COLORS['verified']}" stroke-width="3" stroke-dasharray="20 100"/></svg>
          <span>Arc: share verified, transitively verified or trusted</span>
        </div>
        <div class="hm-legend-section"><strong>Edges</strong></div>
        <div class="hm-legend-item"><span>Calls of the hovered or selected function</span></div>
        ${edgeSwatch('inner', 'Body call')}
        ${edgeSwatch('precondition', 'Requires')}
        ${edgeSwatch('postcondition', 'Ensures')}
        <div class="hm-legend-section"><strong>Interactions</strong></div>
        ${hint('Click group: zoom to it')}
        ${hint('Esc or click background: zoom out one level')}
        ${hint('Click function: details panel')}
        ${hint('Wheel and drag: zoom and pan')}
        ${hint('Tab, then arrow keys: move between functions')}
        ${hint('Enter or Space: details panel')}
      </div>
    `;
    this.container.appendChild(legend);

    legend.querySelector('.pm-legend-toggle')?.addEventListener('click', () => {
      this.legendVisible = !this.legendVisible;
      const body = legend.querySelector('.hm-legend-body') as HTMLElement;
      const arrow = legend.querySelector('.hm-legend-arrow') as HTMLElement;
      if (body) body.style.display = this.legendVisible ? 'block' : 'none';
      if (arrow) arrow.textContent = this.legendVisible ? '▼' : '▶';
    });
  }
}
