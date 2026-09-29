import * as d3 from 'd3';
import dagreModule from '@dagrejs/dagre';
const dagre = dagreModule as any;
import { D3Graph, GraphState } from './types';
import {
  HierarchyTree, HierarchyGroup, CutMember,
  buildHierarchyTree, computeCut, pruneExpanded, descendantGroupIds,
} from './hierarchy';
import { STATUS_COLORS as THEME_STATUS, edgeTypeColor, groupColors } from './theme';

// --- Color palette (matches the Crate Map look) ---

const GROUP_FILL_COLORS = groupColors(0.12);
const GROUP_STROKE_COLORS = groupColors(0.50);

const STATUS_COLORS: Record<string, string> = {
  'verified': THEME_STATUS['verified'],
  'transitively-verified': THEME_STATUS['verified'],
  'trusted': THEME_STATUS['verified'],
  'failed': THEME_STATUS['failed'],
  'unverified': THEME_STATUS['unverified'],
};

const GROUP_H = 56;
const FN_H = 28;
const CHAR_WIDTH = 6.5;
const NODE_PAD = 20;

function textWidth(name: string): number {
  return Math.max(100, name.length * CHAR_WIDTH + NODE_PAD);
}

function statsLine(g: HierarchyGroup): string {
  const files = g.kind === 'file' ? '' : `, ${g.fileCount} files`;
  return `${g.fnCount} fn${files}`;
}

function verifiedFraction(g: HierarchyGroup): number {
  return g.fnCount > 0 ? g.verifiedCount / g.fnCount : 0;
}

/**
 * Hierarchy view: renders a cut through the crate → directory → file →
 * function tree. Collapsed groups are boxes with rollup stats; expanded
 * groups are containers holding their children (Dagre compound layout).
 * Edges are aggregated between visible cut members.
 */
export class HierarchyMapVisualization {
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private g: d3.Selection<SVGGElement, unknown, null, undefined>;
  private width: number;
  private height: number;
  private state: GraphState;
  private onStateChange: (state: GraphState, selectionChanged?: boolean) => void;
  private container: HTMLElement;
  private legendVisible = true;

  private tree: HierarchyTree | null = null;
  private expanded = new Set<string>();
  private lastFilteredGraph: D3Graph | null = null;
  private colorMap = new Map<string, number>();

  constructor(
    container: HTMLElement,
    state: GraphState,
    onStateChange: (state: GraphState, selectionChanged?: boolean) => void,
  ) {
    this.container = container;
    this.state = state;
    this.onStateChange = onStateChange;

    const rect = container.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;

    this.svg = d3.select(container)
      .append('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('viewBox', `0 0 ${this.width} ${this.height}`)
      .attr('class', 'hierarchy-map-svg');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 30])
      .on('zoom', (event) => { this.g.attr('transform', event.transform); });
    this.svg.call(zoom);

    this.g = this.svg.append('g');

    const defs = this.svg.append('defs');
    defs.append('marker')
      .attr('id', 'hm-arrow')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 10).attr('refY', 0)
      .attr('markerWidth', 7).attr('markerHeight', 7)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-4L10,0L0,4')
      .attr('fill', '#666');

    this.renderLegend();

    document.addEventListener('keydown', this.handleKeyDown);
  }

  // ----- Public interface -----

  public update(filteredGraph: D3Graph): void {
    if (!filteredGraph || filteredGraph.nodes.length === 0) {
      this.clear();
      return;
    }

    this.lastFilteredGraph = filteredGraph;
    this.tree = buildHierarchyTree(filteredGraph);
    this.expanded = pruneExpanded(this.expanded, this.tree);

    this.colorMap.clear();
    [...this.tree.roots]
      .sort((a, b) => b.fnCount - a.fnCount)
      .forEach((root, i) => { this.colorMap.set(root.id, i); });

    this.render();
  }

  public destroy(): void {
    document.removeEventListener('keydown', this.handleKeyDown);
    this.svg.remove();
    const legend = this.container.querySelector('.hm-legend');
    if (legend) legend.remove();
  }

  public resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  public clear(): void {
    this.g.selectAll('*').remove();
    // No tree for an empty result, so setExpanded does not redraw the old one
    this.tree = null;
  }

  public highlightNodes(ids: Set<string>): void {
    this.g.selectAll<SVGGElement, CutMember>('.hm-fn-group')
      .select('.hm-fn-box')
      .attr('stroke-width', d => (d.node && ids.has(d.node.id)) ? 3.5 : 1.5);
  }

  /** Restore expansion state (from the ?expanded= URL parameter). */
  public setExpanded(ids: string[]): void {
    this.expanded = new Set(ids);
    if (this.tree) {
      this.expanded = pruneExpanded(this.expanded, this.tree);
      this.render();
    }
  }

  public getExpanded(): string[] {
    return [...this.expanded];
  }

  // ----- Expansion state -----

  private expandGroup(group: HierarchyGroup): void {
    this.expanded.add(group.id);
    this.notifyExpandedChanged();
    this.render();
  }

  private collapseGroup(group: HierarchyGroup): void {
    for (const id of descendantGroupIds(group)) this.expanded.delete(id);
    this.notifyExpandedChanged();
    this.render();
  }

  private collapseAll(): void {
    if (this.expanded.size === 0) return;
    this.expanded.clear();
    this.notifyExpandedChanged();
    this.render();
  }

  private notifyExpandedChanged(): void {
    window.dispatchEvent(new CustomEvent('hierarchy-expanded-changed', {
      detail: { expanded: [...this.expanded] },
    }));
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.collapseAll();
    }
  };

  /** Color index of a member/container: inherited from its root crate. */
  private colorIndexFor(groupId: string): number {
    let group = this.tree?.groupById.get(groupId);
    while (group && group.parentId) {
      group = this.tree?.groupById.get(group.parentId);
    }
    return (group && this.colorMap.get(group.id)) ?? 0;
  }

  // ----- Rendering -----

  private render(): void {
    if (!this.tree || !this.lastFilteredGraph) return;
    const cut = computeCut(this.tree, this.lastFilteredGraph, this.expanded);

    this.g.selectAll('*').remove();

    // Layout. Edges only ever connect leaf dagre nodes (collapsed-group boxes
    // and function boxes), never compound parents, so no proxy nodes are
    // needed (cf. the dagre parent-edge crash worked around in crate-map.ts).
    const gGraph = new dagre.graphlib.Graph({ compound: true });
    gGraph.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 100, marginx: 50, marginy: 50 });
    gGraph.setDefaultEdgeLabel(() => ({}));

    for (const { group, containerId } of cut.containers) {
      gGraph.setNode(group.id, { label: group.label, clusterLabelPos: 'top' });
      if (containerId) gGraph.setParent(group.id, containerId);
    }

    const memberWidths = new Map<string, number>();
    for (const member of cut.members) {
      let w: number;
      let h: number;
      if (member.kind === 'group' && member.group) {
        w = Math.max(textWidth(member.group.label), textWidth(statsLine(member.group))) + 30;
        h = GROUP_H;
      } else {
        w = textWidth(member.node?.display_name || member.id);
        h = FN_H;
      }
      memberWidths.set(member.id, w);
      gGraph.setNode(member.id, { width: w, height: h + 8 });
      if (member.containerId) gGraph.setParent(member.id, member.containerId);
    }

    for (const edge of cut.edges) {
      gGraph.setEdge(edge.source, edge.target);
    }

    dagre.layout(gGraph);

    // Containers first (bottom layer), outermost first for correct stacking.
    for (const { group } of cut.containers) {
      const info = gGraph.node(group.id);
      if (!info || !info.width || !info.height) continue;
      this.renderContainer(group, info);
    }

    // Edges above containers, below member boxes.
    const posMap = new Map<string, { x: number; y: number }>();
    for (const member of cut.members) {
      const info = gGraph.node(member.id);
      if (info) posMap.set(member.id, { x: info.x, y: info.y });
    }
    const maxCalls = Math.max(1, ...cut.edges.map(e => e.callCount));
    for (const edge of cut.edges) {
      this.renderEdge(edge, posMap, memberWidths, maxCalls);
    }

    // Member boxes on top.
    for (const member of cut.members) {
      const pos = posMap.get(member.id);
      if (!pos) continue;
      if (member.kind === 'group' && member.group) {
        this.renderGroupBox(member, pos, memberWidths.get(member.id) || 100);
      } else if (member.node) {
        this.renderFnBox(member, pos, memberWidths.get(member.id) || 100);
      }
    }

    if (this.expanded.size > 0) {
      this.g.append('text')
        .attr('x', 20)
        .attr('y', 20)
        .attr('font-size', '11px')
        .attr('font-family', 'system-ui, sans-serif')
        .attr('fill', '#999')
        .text('Click a container border to collapse it; Esc collapses all');
    }

    const graphInfo = gGraph.graph();
    if (graphInfo && graphInfo.width && graphInfo.height) {
      this.svg.attr('viewBox', `0 0 ${graphInfo.width + 100} ${graphInfo.height + 100}`);
    }
  }

  private renderContainer(
    group: HierarchyGroup,
    info: { x: number; y: number; width: number; height: number },
  ): void {
    const ci = this.colorIndexFor(group.id);
    const fill = GROUP_FILL_COLORS[ci % GROUP_FILL_COLORS.length];
    const stroke = GROUP_STROKE_COLORS[ci % GROUP_STROKE_COLORS.length];

    const rect = this.g.append('rect')
      .attr('class', 'hm-container')
      .attr('x', info.x - info.width / 2)
      .attr('y', info.y - info.height / 2)
      .attr('width', info.width)
      .attr('height', info.height)
      .attr('rx', 10)
      .attr('fill', fill)
      .attr('stroke', stroke)
      .attr('stroke-width', 2)
      .style('cursor', 'pointer');

    rect.on('click', (event: MouseEvent) => {
      event.stopPropagation();
      this.collapseGroup(group);
    });

    this.g.append('text')
      .attr('x', info.x - info.width / 2 + 10)
      .attr('y', info.y - info.height / 2 + 16)
      .attr('font-size', '11px')
      .attr('font-weight', '600')
      .attr('font-family', 'system-ui, sans-serif')
      .attr('fill', '#333')
      .attr('pointer-events', 'none')
      .text(`${group.label} — ${group.verifiedCount}/${group.fnCount} ✓`);
  }

  private renderEdge(
    edge: { source: string; target: string; callCount: number; calls: Array<{ type: string }> },
    posMap: Map<string, { x: number; y: number }>,
    widths: Map<string, number>,
    maxCalls: number,
  ): void {
    const sp = posMap.get(edge.source);
    const tp = posMap.get(edge.target);
    if (!sp || !tp) return;

    const sw = (widths.get(edge.source) || 100) / 2;
    const tw = (widths.get(edge.target) || 100) / 2;
    const dx = tp.x - sp.x;

    // Single fn→fn calls keep the per-type styling; aggregates are grey with
    // width scaled by call count.
    const single = edge.callCount === 1 ? edge.calls[0] : null;
    const edgeColor = !single ? '#888' : edgeTypeColor(single.type, '#666');
    const dashArray = single && (single.type === 'precondition' || single.type === 'postcondition') ? '6,3'
      : single?.type === 'mapping' ? '2,4'
      : single?.type === 'spec' ? '3,3'
      : 'none';
    const strokeW = 1.5 + (edge.callCount / maxCalls) * 3.5;

    this.g.append('path')
      .datum({ source: edge.source, target: edge.target })
      .attr('class', 'hm-edge')
      .attr('fill', 'none')
      .attr('stroke', edgeColor)
      .attr('stroke-opacity', 0.55)
      .attr('stroke-width', strokeW)
      .attr('stroke-dasharray', dashArray)
      .attr('marker-end', 'url(#hm-arrow)')
      .attr('d', `M${sp.x + sw},${sp.y} C${sp.x + sw + dx * 0.4},${sp.y} ${tp.x - tw - dx * 0.4},${tp.y} ${tp.x - tw},${tp.y}`);

    if (edge.callCount > 1) {
      this.g.append('text')
        .attr('class', 'hm-edge-label')
        .attr('x', (sp.x + sw + tp.x - tw) / 2)
        .attr('y', (sp.y + tp.y) / 2 - 8)
        .attr('text-anchor', 'middle')
        .attr('font-size', '10px')
        .attr('font-family', 'system-ui, sans-serif')
        .attr('fill', '#555')
        .attr('pointer-events', 'none')
        .text(`${edge.callCount} calls`);
    }
  }

  private renderGroupBox(member: CutMember, pos: { x: number; y: number }, w: number): void {
    const group = member.group!;
    const ci = this.colorIndexFor(group.id);
    const fill = GROUP_FILL_COLORS[ci % GROUP_FILL_COLORS.length];
    const stroke = GROUP_STROKE_COLORS[ci % GROUP_STROKE_COLORS.length];

    const box = this.g.append('g')
      .attr('class', 'hm-group')
      .attr('transform', `translate(${pos.x}, ${pos.y})`)
      .style('cursor', 'pointer');

    box.append('rect')
      .attr('x', -w / 2)
      .attr('y', -GROUP_H / 2)
      .attr('width', w)
      .attr('height', GROUP_H)
      .attr('rx', group.kind === 'file' ? 4 : 10)
      .attr('fill', fill)
      .attr('stroke', stroke)
      .attr('stroke-width', 2);

    box.append('text')
      .attr('text-anchor', 'middle')
      .attr('y', -8)
      .attr('font-size', '12px')
      .attr('font-weight', '600')
      .attr('font-family', 'system-ui, sans-serif')
      .attr('fill', '#222')
      .attr('pointer-events', 'none')
      .text(group.label);

    box.append('text')
      .attr('text-anchor', 'middle')
      .attr('y', 10)
      .attr('font-size', '10px')
      .attr('font-family', 'system-ui, sans-serif')
      .attr('fill', '#666')
      .attr('pointer-events', 'none')
      .text(statsLine(group));

    // Verified-fraction bar along the bottom edge.
    const barW = w - 16;
    const frac = verifiedFraction(group);
    box.append('rect')
      .attr('x', -barW / 2)
      .attr('y', GROUP_H / 2 - 9)
      .attr('width', barW)
      .attr('height', 4)
      .attr('rx', 2)
      .attr('fill', '#e5e7eb')
      .attr('pointer-events', 'none');
    if (frac > 0) {
      box.append('rect')
        .attr('x', -barW / 2)
        .attr('y', GROUP_H / 2 - 9)
        .attr('width', barW * frac)
        .attr('height', 4)
        .attr('rx', 2)
        .attr('fill', THEME_STATUS['verified'])
        .attr('pointer-events', 'none');
    }

    box.on('click', (event: MouseEvent) => {
      event.stopPropagation();
      this.expandGroup(group);
    });

    box.on('mouseenter', () => this.handleGroupHover(member.id, true));
    box.on('mouseleave', () => this.handleGroupHover(member.id, false));
  }

  private renderFnBox(member: CutMember, pos: { x: number; y: number }, w: number): void {
    const node = member.node!;
    const stroke = STATUS_COLORS[node.verification_status || ''] || THEME_STATUS['unknown'];

    const box = this.g.append('g')
      .datum(member)
      .attr('class', 'hm-fn-group')
      .attr('transform', `translate(${pos.x}, ${pos.y})`)
      .style('cursor', 'pointer');

    box.append('rect')
      .attr('class', 'hm-fn-box')
      .attr('x', -w / 2)
      .attr('y', -FN_H / 2)
      .attr('width', w)
      .attr('height', FN_H)
      .attr('rx', 5)
      .attr('fill', '#fff')
      .attr('stroke', stroke)
      .attr('stroke-width', 1.5);

    box.append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('font-size', '10px')
      .attr('font-family', 'system-ui, sans-serif')
      .attr('fill', '#333')
      .attr('pointer-events', 'none')
      .text(node.display_name);

    box.on('click', (event: MouseEvent) => {
      event.stopPropagation();
      const newState = { ...this.state, selectedNode: node };
      this.state = newState;
      this.onStateChange(newState, true);
    });
  }

  private handleGroupHover(memberId: string, entering: boolean): void {
    if (!entering) {
      this.g.selectAll('.hm-edge').attr('stroke-opacity', 0.55);
      return;
    }
    this.g.selectAll<SVGPathElement, { source: string; target: string }>('.hm-edge')
      .attr('stroke-opacity', d => (d.source === memberId || d.target === memberId) ? 0.9 : 0.15);
  }

  // ----- Legend -----

  private renderLegend(): void {
    const existing = this.container.querySelector('.hm-legend');
    if (existing) existing.remove();

    const legend = document.createElement('div');
    legend.className = 'hm-legend';
    legend.innerHTML = `
      <div class="hm-legend-header" id="hm-legend-toggle">
        <strong>Hierarchy</strong> <span class="hm-legend-arrow">${this.legendVisible ? '▼' : '▶'}</span>
      </div>
      <div class="hm-legend-body" style="display:${this.legendVisible ? 'block' : 'none'}">
        <div class="hm-legend-item">
          <svg width="24" height="16"><rect x="1" y="1" width="22" height="14" rx="4" fill="rgba(66,133,244,0.12)" stroke="rgba(66,133,244,0.5)" stroke-width="1.5"/></svg>
          <span>Collapsed group</span>
        </div>
        <div class="hm-legend-item">
          <svg width="24" height="16"><rect x="1" y="1" width="22" height="14" rx="4" fill="#fff" stroke="${THEME_STATUS['verified']}" stroke-width="1.5"/></svg>
          <span>Function (border = status)</span>
        </div>
        <div class="hm-legend-item">
          <svg width="24" height="10"><rect x="1" y="3" width="22" height="4" rx="2" fill="${THEME_STATUS['verified']}"/></svg>
          <span>Verified fraction</span>
        </div>
        <div class="hm-legend-section"><strong>Interactions</strong></div>
        <div class="hm-legend-item"><span style="font-size:0.75rem; color:var(--pg-text-muted);">Click group: expand in place</span></div>
        <div class="hm-legend-item"><span style="font-size:0.75rem; color:var(--pg-text-muted);">Click container border: collapse</span></div>
        <div class="hm-legend-item"><span style="font-size:0.75rem; color:var(--pg-text-muted);">Click function: details panel</span></div>
        <div class="hm-legend-item"><span style="font-size:0.75rem; color:var(--pg-text-muted);">Esc: collapse all</span></div>
      </div>
    `;
    this.container.appendChild(legend);

    legend.querySelector('#hm-legend-toggle')?.addEventListener('click', () => {
      this.legendVisible = !this.legendVisible;
      const body = legend.querySelector('.hm-legend-body') as HTMLElement;
      const arrow = legend.querySelector('.hm-legend-arrow') as HTMLElement;
      if (body) body.style.display = this.legendVisible ? 'block' : 'none';
      if (arrow) arrow.innerHTML = this.legendVisible ? '▼' : '▶';
    });
  }
}
