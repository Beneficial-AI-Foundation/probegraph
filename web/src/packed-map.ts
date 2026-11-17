/**
 * Packed Map view: a bird's-eye view of the Rust code. Crates, directories
 * and files are nested circles (d3.pack); the smallest circles are `exec`
 * functions, sized by connectivity and filled with their verification
 * status. Plan: docs/plans/packed-map.md.
 */

import * as d3 from 'd3';
import { D3Graph, D3Node, GraphState } from './types';
import { buildHierarchyTree, HierarchyGroup } from './hierarchy';
import { statusColor, STATUS_COLORS, SELECTION_COLOR } from './theme';
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

// ============================================================================
// Visualization
// ============================================================================

type PackNode = d3.HierarchyCircularNode<PackDatum>;

/**
 * The function leaves of a pack tree in depth-first order: crate by crate,
 * file by file. This is the keyboard order. `descendants()` is
 * breadth-first, so it would mix files at different directory depths.
 */
export function functionOrder<T extends d3.HierarchyNode<PackDatum>>(root: T): T[] {
  return root.leaves().filter(d => d.data.kind === 'fn') as T[];
}

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

export class PackedMapVisualization {
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private g: d3.Selection<SVGGElement, unknown, null, undefined>;
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
  private zoom: d3.ZoomBehavior<SVGSVGElement, unknown>;
  /** Function circles in pack order, the keyboard navigation order. */
  private fnNodes: PackNode[] = [];
  /**
   * Position in `fnNodes` of the function with the keyboard focus, or -1.
   * A position, not a node id: a graph can repeat an id (two atoms with
   * one name), and each copy is its own circle.
   */
  private focusIndex = -1;
  /** Opens a function in the Call Graph (double-click, Shift+Enter). */
  private onOpen: (node: D3Node) => void;

  constructor(
    container: HTMLElement,
    state: GraphState,
    onStateChange: (state: GraphState, selectionChanged?: boolean) => void,
    onOpen: (node: D3Node) => void = () => {},
  ) {
    this.container = container;
    this.state = state;
    this.onStateChange = onStateChange;
    this.onOpen = onOpen;

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
      .attr('aria-label', 'Packed Map functions. Arrow keys move between functions, Enter or Space opens the details, Shift+Enter opens the function in the Call Graph.')
      .on('keydown', (event: KeyboardEvent) => this.handleKeyDown(event))
      .on('focus', () => this.renderFocus())
      .on('blur', () => this.renderFocus());

    this.zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 200])
      .on('zoom', (event) => {
        this.g.attr('transform', event.transform);
        this.renderFocus();
      });
    this.svg.call(this.zoom);

    this.g = this.svg.append('g');
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
    }
    this.renderSelection();
    // After the layout: the zoom reset in render ran before the new circles existed
    this.renderFocus();
  }

  public destroy(): void {
    this.svg.interrupt();
    this.svg.remove();
    this.container.querySelector('.pm-legend')?.remove();
    this.hideEmpty();
  }

  /**
   * The viewBox scales with the SVG, so a resize keeps the layout. The next
   * layout packs into the new size. `width` and `height` stay in viewBox
   * units, which the focus check compares against.
   */
  public resize(_width: number, _height: number): void {}

  public clear(): void {
    this.g.selectAll('*').remove();
    this.layoutKey = null;
    this.fnNodes = [];
    this.focusIndex = -1;
    this.svg.attr('aria-activedescendant', null);
  }

  // ----- Rendering -----

  private render(graph: D3Graph): void {
    this.g.selectAll('*').remove();
    // A new layout moves every circle: the old zoom could show empty space
    this.svg.call(this.zoom.transform, d3.zoomIdentity);

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
    const groups = nodes.filter(d => d.data.kind !== 'fn');
    const fns = functionOrder(packed);
    // Keep the focus on the same function in the new layout, if it is drawn
    const focusedId = this.fnNodes[this.focusIndex]?.data.node!.id;
    this.focusIndex = focusedId === undefined ? -1 : fns.findIndex(d => d.data.node!.id === focusedId);
    this.fnNodes = fns;

    const groupSel = this.g.append('g').attr('class', 'pm-groups')
      .selectAll<SVGGElement, PackNode>('g')
      .data(groups)
      .join('g')
      .attr('class', 'pm-group')
      .attr('transform', d => `translate(${d.x},${d.y})`);

    groupSel.append('circle')
      .attr('r', d => d.r)
      .attr('fill', d => groupFill(d.depth))
      .attr('stroke', GROUP_STROKE)
      .attr('stroke-width', 0.75);

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
      .data(fns)
      .join('circle')
      .attr('class', 'pm-fn')
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
        this.focusIndex = this.fnNodes.indexOf(d);
        this.select(d);
      })
      // Not the zoom's double-click: the map stays as it is for Back
      .on('dblclick', (event: MouseEvent, d) => {
        event.stopPropagation();
        this.onOpen(d.data.node!);
      })
      .append('title')
      .text(d => d.data.label);

    // Above the circles and labels; drawn only while the map has the focus
    this.g.append('circle')
      .attr('class', 'pm-focus-ring')
      .attr('fill', 'none')
      .attr('stroke', 'var(--pg-text)')
      .attr('stroke-dasharray', '3 2')
      .attr('pointer-events', 'none')
      .style('display', 'none');

    // Crate names only; the label rules for every level come in Phase 2
    this.g.append('g').attr('class', 'pm-labels')
      .selectAll('text')
      .data(groups.filter(d => d.depth === 1 && d.r > 30))
      .join('text')
      .attr('x', d => d.x)
      .attr('y', d => d.y - d.r + Math.min(d.r / 5, 16) + 4)
      .attr('text-anchor', 'middle')
      .attr('font-size', d => `${Math.min(d.r / 5, 16)}px`)
      .attr('font-family', 'system-ui, sans-serif')
      .attr('fill', 'var(--pg-text)')
      .attr('pointer-events', 'none')
      .text(d => d.data.label);
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
      .attr('stroke-width', d => d.data.node!.id === selectedId ? Math.max(d.r / 3, 1.5) : null);
  }

  // ----- Keyboard -----

  private handleKeyDown(event: KeyboardEvent): void {
    const count = this.fnNodes.length;
    if (count === 0) return;
    let index = this.focusIndex;
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      if (index >= 0) this.onOpen(this.fnNodes[index].data.node!);
      return;
    }
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
    this.focusIndex = index;
    // Keep the focused function on screen at the current zoom
    const svgNode = this.svg.node()!;
    const [sx, sy] = d3.zoomTransform(svgNode).apply([d.x, d.y]);
    if (sx < 0 || sx > this.width || sy < 0 || sy > this.height) {
      this.svg.call(this.zoom.translateTo, d.x, d.y);
    }
    this.renderFocus();
  }

  /** Draw the focus ring and set the active option while the map has the focus. */
  private renderFocus(): void {
    const svgNode = this.svg.node();
    const index = this.focusIndex;
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

    const legend = document.createElement('div');
    legend.className = 'hm-legend pm-legend';
    legend.innerHTML = `
      <button type="button" class="hm-legend-header pm-legend-toggle" aria-expanded="${this.legendVisible}">
        <strong>Packed Map</strong> <span class="hm-legend-arrow" aria-hidden="true">${this.legendVisible ? '▼' : '▶'}</span>
      </button>
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
        <div class="hm-legend-section"><strong>Interactions</strong></div>
        <div class="hm-legend-item"><span style="font-size:0.75rem; color:var(--pg-text-muted);">Click function: details panel</span></div>
        <div class="hm-legend-item"><span style="font-size:0.75rem; color:var(--pg-text-muted);">Double-click function: open in Call Graph</span></div>
        <div class="hm-legend-item"><span style="font-size:0.75rem; color:var(--pg-text-muted);">Wheel and drag: zoom and pan</span></div>
        <div class="hm-legend-item"><span style="font-size:0.75rem; color:var(--pg-text-muted);">Tab, then arrow keys: move between functions</span></div>
        <div class="hm-legend-item"><span style="font-size:0.75rem; color:var(--pg-text-muted);">Enter or Space: details panel</span></div>
        <div class="hm-legend-item"><span style="font-size:0.75rem; color:var(--pg-text-muted);">Shift+Enter: open in Call Graph</span></div>
      </div>
    `;
    this.container.appendChild(legend);

    const toggle = legend.querySelector('.pm-legend-toggle') as HTMLButtonElement;
    toggle.addEventListener('click', () => {
      this.legendVisible = !this.legendVisible;
      toggle.setAttribute('aria-expanded', String(this.legendVisible));
      const body = legend.querySelector('.hm-legend-body') as HTMLElement;
      const arrow = legend.querySelector('.hm-legend-arrow') as HTMLElement;
      if (body) body.style.display = this.legendVisible ? 'block' : 'none';
      if (arrow) arrow.textContent = this.legendVisible ? '▼' : '▶';
    });
  }
}
