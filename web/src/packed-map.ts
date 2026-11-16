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
      .attr('class', 'packed-map-svg');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 200])
      .on('zoom', (event) => { this.g.attr('transform', event.transform); });
    this.svg.call(zoom);

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
  }

  public destroy(): void {
    this.svg.interrupt();
    this.svg.remove();
    this.container.querySelector('.pm-legend')?.remove();
    this.hideEmpty();
  }

  public resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  public clear(): void {
    this.g.selectAll('*').remove();
    this.layoutKey = null;
  }

  // ----- Rendering -----

  private render(graph: D3Graph): void {
    this.g.selectAll('*').remove();

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
    const fns = nodes.filter(d => d.data.kind === 'fn');

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
      .attr('cx', d => d.x)
      .attr('cy', d => d.y)
      .attr('r', d => d.r)
      .attr('fill', d => statusColor(d.data.node!.verification_status))
      .style('cursor', 'pointer')
      .on('click', (event: MouseEvent, d) => {
        event.stopPropagation();
        this.state = { ...this.state, selectedNode: d.data.node! };
        this.renderSelection();
        this.onStateChange(this.state);
      })
      .append('title')
      .text(d => d.data.label);

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

  private renderSelection(): void {
    const selectedId = this.state.selectedNode?.id;
    this.g.selectAll<SVGCircleElement, PackNode>('.pm-fn')
      .attr('stroke', d => d.data.node!.id === selectedId ? SELECTION_COLOR : null)
      .attr('stroke-width', d => d.data.node!.id === selectedId ? Math.max(d.r / 3, 1.5) : null);
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
        <div class="hm-legend-section"><strong>Interactions</strong></div>
        <div class="hm-legend-item"><span style="font-size:0.75rem; color:var(--pg-text-muted);">Click function: details panel</span></div>
        <div class="hm-legend-item"><span style="font-size:0.75rem; color:var(--pg-text-muted);">Wheel and drag: zoom and pan</span></div>
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
