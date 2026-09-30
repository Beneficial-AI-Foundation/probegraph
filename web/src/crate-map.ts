import * as d3 from 'd3';
import dagreModule from '@dagrejs/dagre';
const dagre = dagreModule as any;
import { D3Graph, D3Node, GraphState, CrateNode, CrateEdge, CrateGraph, crateMapLabel, crateNoun } from './types';
import { edgeTypeColor, groupColors, ACCENT } from './theme';
import { escapeHtml } from './html';

// --- Color palette for crate boxes ---

const CRATE_FILL_COLORS = groupColors(0.12);
const CRATE_STROKE_COLORS = groupColors(0.50);
const CRATE_STROKE_SELECTED = groupColors(0.85);

const NODE_H = 28;
const CHAR_WIDTH = 6.5;
const NODE_PAD = 20;

function nodeWidthFor(name: string): number {
  return Math.max(100, name.length * CHAR_WIDTH + NODE_PAD);
}

// ============================================================================
// Crate Aggregation
// ============================================================================

export function buildCrateGraph(graph: D3Graph): CrateGraph {
  const nodeMap = new Map<string, D3Node>();
  for (const node of graph.nodes) {
    nodeMap.set(node.id, node);
  }

  const crateMap = new Map<string, { nodeIds: string[]; files: Set<string>; isExternal: boolean }>();
  for (const node of graph.nodes) {
    const crate = node.crate_name || 'unknown';
    let entry = crateMap.get(crate);
    if (!entry) {
      entry = { nodeIds: [], files: new Set(), isExternal: node.id.includes('external:') };
      crateMap.set(crate, entry);
    }
    entry.nodeIds.push(node.id);
    if (node.file_name) entry.files.add(node.relative_path || node.file_name);
  }

  const crateNodes: CrateNode[] = [];
  for (const [name, entry] of crateMap) {
    crateNodes.push({
      name,
      functionCount: entry.nodeIds.length,
      fileCount: entry.files.size,
      nodeIds: entry.nodeIds,
      isExternal: entry.isExternal,
    });
  }

  const edgeKey = (s: string, t: string) => `${s}\0${t}`;
  const edgeMap = new Map<string, CrateEdge>();

  for (const link of graph.links) {
    const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
    const targetId = typeof link.target === 'string' ? link.target : link.target.id;
    const sourceNode = nodeMap.get(sourceId);
    const targetNode = nodeMap.get(targetId);
    if (!sourceNode || !targetNode) continue;

    const sourceCrate = sourceNode.crate_name || 'unknown';
    const targetCrate = targetNode.crate_name || 'unknown';
    if (sourceCrate === targetCrate) continue;

    const key = edgeKey(sourceCrate, targetCrate);
    let edge = edgeMap.get(key);
    if (!edge) {
      edge = { source: sourceCrate, target: targetCrate, callCount: 0, calls: [] };
      edgeMap.set(key, edge);
    }
    edge.callCount++;
    edge.calls.push({
      sourceId,
      targetId,
      type: (typeof link.type === 'string' ? link.type : 'inner'),
    });
  }

  return {
    nodes: crateNodes,
    edges: [...edgeMap.values()],
  };
}

// ============================================================================
// CrateMapVisualization
// ============================================================================

interface ExpandedEdge {
  source: string;
  target: string;
}

export class CrateMapVisualization {
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private g: d3.Selection<SVGGElement, unknown, null, undefined>;
  private width: number;
  private height: number;
  private state: GraphState;
  private onStateChange: (state: GraphState, selectionChanged?: boolean) => void;
  private container: HTMLElement;
  private legendVisible = true;

  private crateGraph: CrateGraph | null = null;
  private expandedEdge: ExpandedEdge | null = null;
  private lastFilteredGraph: D3Graph | null = null;
  private crateColorMap = new Map<string, number>();
  private selectedCrate: string | null = null;

  private boundarySource: string | null = null;
  private boundaryTarget: string | null = null;
  private boundaryActive = false;

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
      .attr('class', 'crate-map-svg');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 30])
      .on('zoom', (event) => { this.g.attr('transform', event.transform); });
    this.svg.call(zoom);

    this.svg.on('click', (event) => {
      if (event.target === this.svg.node()) {
        this.collapseEdge();
      }
    });

    this.g = this.svg.append('g');

    const defs = this.svg.append('defs');
    defs.append('marker')
      .attr('id', 'cm-arrow')
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
    this.crateGraph = buildCrateGraph(filteredGraph);

    this.crateColorMap.clear();
    this.crateGraph.nodes
      .sort((a, b) => b.functionCount - a.functionCount)
      .forEach((cn, i) => { this.crateColorMap.set(cn.name, i); });

    if (this.expandedEdge) {
      this.renderExpanded(filteredGraph);
    } else {
      this.renderCollapsed();
    }
  }

  public destroy(): void {
    document.removeEventListener('keydown', this.handleKeyDown);
    this.svg.remove();
    const legend = this.container.querySelector('.cm-legend');
    if (legend) legend.remove();
  }

  public resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  public clear(): void {
    this.g.selectAll('*').remove();
  }

  public highlightNodes(_ids: Set<string>): void {
    // Not applicable at crate level
  }

  // ----- Collapsed (overview) rendering -----

  private renderCollapsed(): void {
    const cg = this.crateGraph;
    if (!cg) return;

    this.g.selectAll('*').remove();

    const gGraph = new dagre.graphlib.Graph();
    gGraph.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 120, marginx: 50, marginy: 50 });
    gGraph.setDefaultEdgeLabel(() => ({}));

    const crateWidths = new Map<string, number>();
    for (const cn of cg.nodes) {
      const label = cn.name;
      const statsLine = `${cn.functionCount} fn, ${cn.fileCount} files`;
      const w = Math.max(nodeWidthFor(label), nodeWidthFor(statsLine)) + 30;
      const h = 56;
      crateWidths.set(cn.name, w);
      gGraph.setNode(cn.name, { width: w, height: h, label });
    }

    for (const edge of cg.edges) {
      gGraph.setEdge(edge.source, edge.target, { weight: edge.callCount });
    }

    dagre.layout(gGraph);

    const posMap = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const cn of cg.nodes) {
      const info = gGraph.node(cn.name);
      if (info) {
        posMap.set(cn.name, { x: info.x, y: info.y, w: info.width, h: info.height });
      }
    }

    // Render edges first (behind nodes)
    const maxCalls = Math.max(1, ...cg.edges.map(e => e.callCount));
    for (const edge of cg.edges) {
      const sp = posMap.get(edge.source);
      const tp = posMap.get(edge.target);
      if (!sp || !tp) continue;

      const sw = sp.w / 2;
      const tw = tp.w / 2;
      const strokeW = 1.5 + (edge.callCount / maxCalls) * 4;

      const path = this.g.append('path')
        .attr('class', 'cm-edge')
        .attr('fill', 'none')
        .attr('stroke', '#888')
        .attr('stroke-opacity', 0.5)
        .attr('stroke-width', strokeW)
        .attr('marker-end', 'url(#cm-arrow)')
        .attr('d', () => {
          const dx = tp.x - sp.x;
          return `M${sp.x + sw},${sp.y} C${sp.x + sw + dx * 0.4},${sp.y} ${tp.x - tw - dx * 0.4},${tp.y} ${tp.x - tw},${tp.y}`;
        })
        .style('cursor', 'pointer');

      path.on('click', (event: MouseEvent) => {
        event.stopPropagation();
        this.expandEdge(edge.source, edge.target);
      });

      path.on('mouseenter', function () {
        d3.select(this).attr('stroke-opacity', 0.9).attr('stroke', '#444');
      });
      path.on('mouseleave', function () {
        d3.select(this).attr('stroke-opacity', 0.5).attr('stroke', '#888');
      });

      // Edge label
      const mx = (sp.x + sw + tp.x - tw) / 2;
      const my = (sp.y + tp.y) / 2 - 10;
      this.g.append('text')
        .attr('class', 'cm-edge-label')
        .attr('x', mx)
        .attr('y', my)
        .attr('text-anchor', 'middle')
        .attr('font-size', '11px')
        .attr('font-family', 'system-ui, sans-serif')
        .attr('fill', '#555')
        .attr('pointer-events', 'none')
        .text(`${edge.callCount} calls`);
    }

    // Render crate boxes
    for (const cn of cg.nodes) {
      const pos = posMap.get(cn.name);
      if (!pos) continue;

      const ci = this.crateColorMap.get(cn.name) ?? 0;
      const fill = CRATE_FILL_COLORS[ci % CRATE_FILL_COLORS.length];
      const stroke = this.selectedCrate === cn.name
        ? CRATE_STROKE_SELECTED[ci % CRATE_STROKE_SELECTED.length]
        : CRATE_STROKE_COLORS[ci % CRATE_STROKE_COLORS.length];

      const group = this.g.append('g')
        .attr('class', 'cm-crate-group')
        .attr('transform', `translate(${pos.x}, ${pos.y})`)
        .style('cursor', 'pointer');

      group.append('rect')
        .attr('class', 'cm-crate-box')
        .attr('x', -pos.w / 2)
        .attr('y', -pos.h / 2)
        .attr('width', pos.w)
        .attr('height', pos.h)
        .attr('rx', 10)
        .attr('fill', fill)
        .attr('stroke', stroke)
        .attr('stroke-width', this.selectedCrate === cn.name ? 3 : 2);

      group.append('text')
        .attr('class', 'cm-crate-label')
        .attr('text-anchor', 'middle')
        .attr('y', -6)
        .attr('font-size', '12px')
        .attr('font-weight', '600')
        .attr('font-family', 'system-ui, sans-serif')
        .attr('fill', '#222')
        .attr('pointer-events', 'none')
        .text(cn.name);

      group.append('text')
        .attr('class', 'cm-crate-stats')
        .attr('text-anchor', 'middle')
        .attr('y', 12)
        .attr('font-size', '10px')
        .attr('font-family', 'system-ui, sans-serif')
        .attr('fill', '#666')
        .attr('pointer-events', 'none')
        .text(`${cn.functionCount} fn, ${cn.fileCount} files`);

      group.on('click', (event: MouseEvent) => {
        event.stopPropagation();
        this.handleCrateClick(cn);
      });

      group.on('dblclick', (event: MouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
        this.handleCrateDblClick(cn);
      });

      group.on('mouseenter', () => this.handleCrateHover(cn.name, true));
      group.on('mouseleave', () => this.handleCrateHover(cn.name, false));
    }

    // Fit to content
    const graphInfo = gGraph.graph();
    if (graphInfo && graphInfo.width && graphInfo.height) {
      this.svg.attr('viewBox', `0 0 ${graphInfo.width + 100} ${graphInfo.height + 100}`);
    }
  }

  // ----- Expanded (inline drill-down) rendering -----

  private renderExpanded(filteredGraph: D3Graph): void {
    const cg = this.crateGraph;
    const expanded = this.expandedEdge;
    if (!cg || !expanded) return;

    this.g.selectAll('*').remove();

    const nodeMap = new Map<string, D3Node>();
    for (const node of filteredGraph.nodes) {
      nodeMap.set(node.id, node);
    }

    const crateEdge = cg.edges.find(
      e => e.source === expanded.source && e.target === expanded.target
    );
    if (!crateEdge) {
      this.expandedEdge = null;
      this.renderCollapsed();
      return;
    }

    // Gather the function nodes involved in cross-crate calls
    const expandedNodeIds = new Set<string>();
    for (const call of crateEdge.calls) {
      expandedNodeIds.add(call.sourceId);
      expandedNodeIds.add(call.targetId);
    }

    const expandedNodes: D3Node[] = [];
    for (const id of expandedNodeIds) {
      const node = nodeMap.get(id);
      if (node) expandedNodes.push(node);
    }

    const fnWidths = new Map<string, number>();
    for (const node of expandedNodes) {
      fnWidths.set(node.id, nodeWidthFor(node.display_name));
    }

    // Build compound dagre graph.
    // Dagre crashes when edges connect directly to compound parent nodes
    // (see https://github.com/dagrejs/dagre/issues/236), so we use invisible
    // proxy leaf nodes inside each cluster as edge anchors for external edges.
    const gGraph = new dagre.graphlib.Graph({ compound: true });
    gGraph.setGraph({ rankdir: 'LR', nodesep: 20, ranksep: 140, marginx: 50, marginy: 50 });
    gGraph.setDefaultEdgeLabel(() => ({}));

    gGraph.setNode(`crate:${expanded.source}`, { label: expanded.source, clusterLabelPos: 'top' });
    gGraph.setNode(`crate:${expanded.target}`, { label: expanded.target, clusterLabelPos: 'top' });

    // Proxy nodes: invisible leaf nodes inside each cluster that external edges
    // can safely connect to (avoiding the parent-node edge crash).
    gGraph.setNode(`proxy:${expanded.source}`, { width: 0, height: 0 });
    gGraph.setParent(`proxy:${expanded.source}`, `crate:${expanded.source}`);
    gGraph.setNode(`proxy:${expanded.target}`, { width: 0, height: 0 });
    gGraph.setParent(`proxy:${expanded.target}`, `crate:${expanded.target}`);

    for (const cn of cg.nodes) {
      if (cn.name === expanded.source || cn.name === expanded.target) continue;
      const w = nodeWidthFor(cn.name) + 30;
      gGraph.setNode(`collapsed:${cn.name}`, { width: w, height: 44, label: cn.name });
    }

    for (const node of expandedNodes) {
      const nw = fnWidths.get(node.id) || 100;
      gGraph.setNode(node.id, { width: nw + 10, height: NODE_H + 8 });
      const crate = node.crate_name || 'unknown';
      if (crate === expanded.source || crate === expanded.target) {
        gGraph.setParent(node.id, `crate:${crate}`);
      }
    }

    for (const call of crateEdge.calls) {
      if (expandedNodeIds.has(call.sourceId) && expandedNodeIds.has(call.targetId)) {
        gGraph.setEdge(call.sourceId, call.targetId);
      }
    }

    for (const edge of cg.edges) {
      if (edge.source === expanded.source && edge.target === expanded.target) continue;

      const sIsExpanded = edge.source === expanded.source || edge.source === expanded.target;
      const tIsExpanded = edge.target === expanded.source || edge.target === expanded.target;

      if (!sIsExpanded && !tIsExpanded) {
        gGraph.setEdge(`collapsed:${edge.source}`, `collapsed:${edge.target}`);
      } else if (sIsExpanded && !tIsExpanded) {
        gGraph.setEdge(`proxy:${edge.source}`, `collapsed:${edge.target}`);
      } else if (!sIsExpanded && tIsExpanded) {
        gGraph.setEdge(`collapsed:${edge.source}`, `proxy:${edge.target}`);
      }
    }

    dagre.layout(gGraph);

    // Render expanded crate group backgrounds
    for (const crateName of [expanded.source, expanded.target]) {
      const groupId = `crate:${crateName}`;
      const info = gGraph.node(groupId);
      if (!info || !info.width || !info.height) continue;

      const ci = this.crateColorMap.get(crateName) ?? 0;
      const fill = CRATE_FILL_COLORS[ci % CRATE_FILL_COLORS.length];
      const stroke = CRATE_STROKE_SELECTED[ci % CRATE_STROKE_SELECTED.length];

      this.g.append('rect')
        .attr('class', 'cm-expanded-group')
        .attr('x', info.x - info.width / 2)
        .attr('y', info.y - info.height / 2)
        .attr('width', info.width)
        .attr('height', info.height)
        .attr('rx', 10)
        .attr('fill', fill)
        .attr('stroke', stroke)
        .attr('stroke-width', 2);

      this.g.append('text')
        .attr('x', info.x - info.width / 2 + 10)
        .attr('y', info.y - info.height / 2 + 16)
        .attr('font-size', '11px')
        .attr('font-weight', '600')
        .attr('font-family', 'system-ui, sans-serif')
        .attr('fill', '#333')
        .attr('pointer-events', 'none')
        .text(crateName);
    }

    // Render collapsed crate boxes
    for (const cn of cg.nodes) {
      if (cn.name === expanded.source || cn.name === expanded.target) continue;
      const nodeId = `collapsed:${cn.name}`;
      const info = gGraph.node(nodeId);
      if (!info) continue;

      const ci = this.crateColorMap.get(cn.name) ?? 0;
      const fill = CRATE_FILL_COLORS[ci % CRATE_FILL_COLORS.length];
      const stroke = CRATE_STROKE_COLORS[ci % CRATE_STROKE_COLORS.length];

      const group = this.g.append('g')
        .attr('transform', `translate(${info.x}, ${info.y})`);

      group.append('rect')
        .attr('x', -info.width / 2)
        .attr('y', -info.height / 2)
        .attr('width', info.width)
        .attr('height', info.height)
        .attr('rx', 8)
        .attr('fill', fill)
        .attr('stroke', stroke)
        .attr('stroke-width', 1.5)
        .attr('opacity', 0.6);

      group.append('text')
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .attr('font-size', '10px')
        .attr('font-family', 'system-ui, sans-serif')
        .attr('fill', '#666')
        .attr('pointer-events', 'none')
        .text(cn.name);
    }

    // Render function-level edges
    const posMap = new Map<string, { x: number; y: number }>();
    for (const node of expandedNodes) {
      const info = gGraph.node(node.id);
      if (info) posMap.set(node.id, { x: info.x, y: info.y });
    }

    for (const call of crateEdge.calls) {
      const sp = posMap.get(call.sourceId);
      const tp = posMap.get(call.targetId);
      if (!sp || !tp) continue;

      const sw = (fnWidths.get(call.sourceId) || 100) / 2;
      const tw = (fnWidths.get(call.targetId) || 100) / 2;
      const dx = tp.x - sp.x;

      const edgeColor = edgeTypeColor(call.type, '#666');
      const dashArray = (call.type === 'precondition' || call.type === 'postcondition') ? '6,3'
        : (call.type === 'mapping') ? '2,4'
        : (call.type === 'spec') ? '3,3'
        : 'none';

      this.g.append('path')
        .attr('class', 'cm-fn-edge')
        .attr('fill', 'none')
        .attr('stroke', edgeColor)
        .attr('stroke-opacity', 0.6)
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', dashArray)
        .attr('marker-end', 'url(#cm-arrow)')
        .attr('d', `M${sp.x + sw},${sp.y} C${sp.x + sw + dx * 0.35},${sp.y} ${tp.x - tw - dx * 0.35},${tp.y} ${tp.x - tw},${tp.y}`);
    }

    // Render function nodes
    for (const node of expandedNodes) {
      const pos = posMap.get(node.id);
      if (!pos) continue;

      const nw = fnWidths.get(node.id) || 100;
      const fnGroup = this.g.append('g')
        .attr('transform', `translate(${pos.x}, ${pos.y})`)
        .style('cursor', 'pointer');

      fnGroup.append('rect')
        .attr('x', -nw / 2)
        .attr('y', -NODE_H / 2)
        .attr('width', nw)
        .attr('height', NODE_H)
        .attr('rx', 5)
        .attr('fill', '#fff')
        .attr('stroke', '#888')
        .attr('stroke-width', 1.5);

      fnGroup.append('text')
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .attr('font-size', '10px')
        .attr('font-family', 'system-ui, sans-serif')
        .attr('fill', '#333')
        .attr('pointer-events', 'none')
        .text(node.display_name);

      fnGroup.on('click', (event: MouseEvent) => {
        event.stopPropagation();
        const newState = { ...this.state, selectedNode: node };
        this.state = newState;
        this.onStateChange(newState, true);
      });
    }

    // Collapse hint
    this.g.append('text')
      .attr('x', 20)
      .attr('y', 20)
      .attr('font-size', '11px')
      .attr('font-family', 'system-ui, sans-serif')
      .attr('fill', '#999')
      .text('Press Esc or click background to collapse');

    const graphInfo = gGraph.graph();
    if (graphInfo && graphInfo.width && graphInfo.height) {
      this.svg.attr('viewBox', `0 0 ${graphInfo.width + 100} ${graphInfo.height + 100}`);
    }
  }

  // ----- Boundary rendering -----

  private renderBoundary(): void {
    const cg = this.crateGraph;
    const src = this.boundarySource;
    const tgt = this.boundaryTarget;
    if (!cg || !src || !tgt || !this.lastFilteredGraph) return;

    this.g.selectAll('*').remove();

    const nodeMap = new Map<string, D3Node>();
    for (const node of this.lastFilteredGraph.nodes) {
      nodeMap.set(node.id, node);
    }

    // Collect cross-crate calls in both directions
    // "Boundary of A called by B" = edges where caller is in tgt and callee is in src
    // In CrateEdge model: source=caller, target=callee → edge(tgt, src)
    const callsInto: Array<{ sourceId: string; targetId: string; type: string }> = [];
    const callsFrom: Array<{ sourceId: string; targetId: string; type: string }> = [];

    for (const edge of cg.edges) {
      if (edge.source === tgt && edge.target === src) {
        callsInto.push(...edge.calls);
      }
      if (edge.source === src && edge.target === tgt) {
        callsFrom.push(...edge.calls);
      }
    }

    const allCalls = [...callsInto, ...callsFrom];
    if (allCalls.length === 0) {
      this.g.append('text')
        .attr('x', this.width / 2)
        .attr('y', this.height / 2)
        .attr('text-anchor', 'middle')
        .attr('font-size', '14px')
        .attr('font-family', 'system-ui, sans-serif')
        .attr('fill', '#999')
        .text(`No calls between ${src} and ${tgt}`);
      return;
    }

    // Gather unique function nodes involved
    const expandedNodeIds = new Set<string>();
    for (const call of allCalls) {
      expandedNodeIds.add(call.sourceId);
      expandedNodeIds.add(call.targetId);
    }

    const expandedNodes: D3Node[] = [];
    for (const id of expandedNodeIds) {
      const node = nodeMap.get(id);
      if (node) expandedNodes.push(node);
    }

    // Build dagre with compound groups
    const gGraph = new dagre.graphlib.Graph({ compound: true });
    gGraph.setGraph({ rankdir: 'LR', nodesep: 20, ranksep: 160, marginx: 60, marginy: 60 });
    gGraph.setDefaultEdgeLabel(() => ({}));

    gGraph.setNode(`crate:${src}`, { label: src, clusterLabelPos: 'top' });
    gGraph.setNode(`crate:${tgt}`, { label: tgt, clusterLabelPos: 'top' });

    const fnWidths = new Map<string, number>();
    for (const node of expandedNodes) {
      const nw = nodeWidthFor(node.display_name);
      fnWidths.set(node.id, nw);
      gGraph.setNode(node.id, { width: nw + 10, height: NODE_H + 8 });
      const crate = node.crate_name || 'unknown';
      if (crate === src) gGraph.setParent(node.id, `crate:${src}`);
      else if (crate === tgt) gGraph.setParent(node.id, `crate:${tgt}`);
    }

    for (const call of allCalls) {
      if (expandedNodeIds.has(call.sourceId) && expandedNodeIds.has(call.targetId)) {
        gGraph.setEdge(call.sourceId, call.targetId);
      }
    }

    dagre.layout(gGraph);

    // Render crate group backgrounds
    for (const crateName of [src, tgt]) {
      const groupId = `crate:${crateName}`;
      const info = gGraph.node(groupId);
      if (!info || !info.width || !info.height) continue;

      const isSource = crateName === src;
      this.g.append('rect')
        .attr('class', 'cm-expanded-group')
        .attr('x', info.x - info.width / 2)
        .attr('y', info.y - info.height / 2)
        .attr('width', info.width)
        .attr('height', info.height)
        .attr('rx', 10)
        .attr('fill', isSource ? 'rgba(30,115,218,0.06)' : 'rgba(230,81,0,0.06)')
        .attr('stroke', isSource ? ACCENT : edgeTypeColor('precondition'))
        .attr('stroke-width', 2);

      this.g.append('text')
        .attr('x', info.x - info.width / 2 + 10)
        .attr('y', info.y - info.height / 2 + 16)
        .attr('font-size', '11px')
        .attr('font-weight', '600')
        .attr('font-family', 'system-ui, sans-serif')
        .attr('fill', isSource ? ACCENT : edgeTypeColor('precondition'))
        .attr('pointer-events', 'none')
        .text(`${crateName} ${isSource ? '(source — called)' : '(target — caller)'}`);
    }

    // Render edges
    const posMap = new Map<string, { x: number; y: number }>();
    for (const node of expandedNodes) {
      const info = gGraph.node(node.id);
      if (info) posMap.set(node.id, { x: info.x, y: info.y });
    }

    for (const call of allCalls) {
      const sp = posMap.get(call.sourceId);
      const tp = posMap.get(call.targetId);
      if (!sp || !tp) continue;

      const sw = (fnWidths.get(call.sourceId) || 100) / 2;
      const tw = (fnWidths.get(call.targetId) || 100) / 2;
      const dx = tp.x - sp.x;

      const edgeColor = edgeTypeColor(call.type, '#666');
      const dashArray = (call.type === 'precondition' || call.type === 'postcondition') ? '6,3'
        : (call.type === 'mapping') ? '2,4'
        : (call.type === 'spec') ? '3,3'
        : 'none';

      this.g.append('path')
        .attr('class', 'cm-fn-edge')
        .attr('fill', 'none')
        .attr('stroke', edgeColor)
        .attr('stroke-opacity', 0.6)
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', dashArray)
        .attr('marker-end', 'url(#cm-arrow)')
        .attr('d', `M${sp.x + sw},${sp.y} C${sp.x + sw + dx * 0.35},${sp.y} ${tp.x - tw - dx * 0.35},${tp.y} ${tp.x - tw},${tp.y}`);
    }

    // Render function nodes
    for (const node of expandedNodes) {
      const pos = posMap.get(node.id);
      if (!pos) continue;

      const nw = fnWidths.get(node.id) || 100;
      const fnGroup = this.g.append('g')
        .attr('transform', `translate(${pos.x}, ${pos.y})`)
        .style('cursor', 'pointer');

      fnGroup.append('rect')
        .attr('x', -nw / 2)
        .attr('y', -NODE_H / 2)
        .attr('width', nw)
        .attr('height', NODE_H)
        .attr('rx', 5)
        .attr('fill', '#fff')
        .attr('stroke', '#888')
        .attr('stroke-width', 1.5);

      fnGroup.append('text')
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .attr('font-size', '10px')
        .attr('font-family', 'system-ui, sans-serif')
        .attr('fill', '#333')
        .attr('pointer-events', 'none')
        .text(node.display_name);

      fnGroup.on('click', (event: MouseEvent) => {
        event.stopPropagation();
        const newState = { ...this.state, selectedNode: node };
        this.state = newState;
        this.onStateChange(newState, true);
      });
    }

    // Summary + navigation buttons
    const btnY = 20;
    const summaryText = `Boundary: ${callsInto.length} call${callsInto.length !== 1 ? 's' : ''} from ${tgt} → ${src}` +
      (callsFrom.length > 0 ? `, ${callsFrom.length} call${callsFrom.length !== 1 ? 's' : ''} from ${src} → ${tgt}` : '');

    this.g.append('text')
      .attr('x', 20)
      .attr('y', btnY)
      .attr('font-size', '11px')
      .attr('font-family', 'system-ui, sans-serif')
      .attr('fill', '#555')
      .text(summaryText);

    // "View in Call Graph" button
    const btnGroup = this.g.append('g')
      .attr('transform', `translate(20, ${btnY + 10})`)
      .style('cursor', 'pointer');

    const btnText = `View in Call Graph →`;
    const btnW = btnText.length * 7 + 20;
    btnGroup.append('rect')
      .attr('width', btnW)
      .attr('height', 24)
      .attr('rx', 4)
      .attr('fill', ACCENT)
      .attr('opacity', 0.85);
    btnGroup.append('text')
      .attr('x', btnW / 2)
      .attr('y', 13)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('font-size', '11px')
      .attr('font-weight', '600')
      .attr('font-family', 'system-ui, sans-serif')
      .attr('fill', '#fff')
      .attr('pointer-events', 'none')
      .text(btnText);

    btnGroup.on('click', (event: MouseEvent) => {
      event.stopPropagation();
      this.navigateToCallGraph();
    });

    // Esc hint
    this.g.append('text')
      .attr('x', 20)
      .attr('y', btnY + 46)
      .attr('font-size', '10px')
      .attr('font-family', 'system-ui, sans-serif')
      .attr('fill', '#aaa')
      .text('Press Esc or click background to collapse');

    const graphInfo = gGraph.graph();
    if (graphInfo && graphInfo.width && graphInfo.height) {
      this.svg.attr('viewBox', `0 0 ${graphInfo.width + 100} ${graphInfo.height + 100}`);
    }
  }

  private navigateToCallGraph(): void {
    const src = this.boundarySource;
    const tgt = this.boundaryTarget;
    if (!src || !tgt) return;

    window.dispatchEvent(new CustomEvent('crate-map-switch-view', {
      detail: {
        view: 'callgraph',
        sourceGroup: src,
        targetGroup: tgt,
      },
    }));
  }

  // ----- Edge expansion -----

  private expandEdge(source: string, target: string): void {
    if (this.expandedEdge?.source === source && this.expandedEdge?.target === target) {
      this.collapseEdge();
      return;
    }
    this.expandedEdge = { source, target };
    if (this.lastFilteredGraph) {
      this.renderExpanded(this.lastFilteredGraph);
    }
  }

  private collapseEdge(): void {
    if (!this.expandedEdge && !this.boundaryActive) return;
    this.expandedEdge = null;
    if (this.boundaryActive) {
      this.boundaryActive = false;
      this.boundarySource = null;
      this.boundaryTarget = null;
      this.syncDropdowns();
    }
    this.renderCollapsed();
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.collapseEdge();
    }
  };

  // ----- Crate interactions -----

  private handleCrateClick(cn: CrateNode): void {
    // Two-crate boundary selection logic:
    // 1st click → source, 2nd click on different crate → target, click selected → deselect
    if (this.boundarySource === cn.name) {
      this.boundarySource = null;
      this.boundaryActive = false;
    } else if (this.boundaryTarget === cn.name) {
      this.boundaryTarget = null;
      this.boundaryActive = false;
    } else if (!this.boundarySource) {
      this.boundarySource = cn.name;
    } else if (!this.boundaryTarget) {
      this.boundaryTarget = cn.name;
    } else {
      this.boundaryTarget = cn.name;
    }

    this.selectedCrate = cn.name;
    this.syncDropdowns();
    this.updateCrateSelectionStyle();
    this.showCrateInfo(cn);

    if (this.boundarySource && this.boundaryTarget) {
      this.boundaryActive = true;
      this.expandedEdge = null;
      this.renderBoundary();
    } else {
      if (this.boundaryActive) {
        this.boundaryActive = false;
        this.renderCollapsed();
        this.updateCrateSelectionStyle();
      }
    }
  }

  private showCrateInfo(cn: CrateNode): void {
    const nodeInfoDiv = document.getElementById('node-info');
    if (!nodeInfoDiv) return;

    const cg = this.crateGraph;
    if (!cg) return;

    const outgoing = cg.edges
      .filter(e => e.source === cn.name)
      .sort((a, b) => b.callCount - a.callCount);
    const incoming = cg.edges
      .filter(e => e.target === cn.name)
      .sort((a, b) => b.callCount - a.callCount);

    const fileCountMap = new Map<string, number>();
    if (this.lastFilteredGraph) {
      for (const node of this.lastFilteredGraph.nodes) {
        if (node.crate_name === cn.name) {
          const rp = node.relative_path || node.file_name;
          fileCountMap.set(rp, (fileCountMap.get(rp) || 0) + 1);
        }
      }
    }
    const topFiles = [...fileCountMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    const role = this.boundarySource === cn.name ? ' (Source)' :
                 this.boundaryTarget === cn.name ? ' (Target)' : '';

    nodeInfoDiv.innerHTML = `
      <div class="cm-info">
        <h3>${escapeHtml(cn.name)}${role}</h3>
        <p><strong>${cn.functionCount}</strong> functions, <strong>${cn.fileCount}</strong> files</p>
        ${cn.isExternal ? '<p><em>External dependency</em></p>' : ''}
        ${outgoing.length > 0 ? `
          <h4>Calls into:</h4>
          <ul>${outgoing.map(e => `<li>${escapeHtml(e.target)} (${e.callCount} calls)</li>`).join('')}</ul>
        ` : ''}
        ${incoming.length > 0 ? `
          <h4>Called by:</h4>
          <ul>${incoming.map(e => `<li>${escapeHtml(e.source)} (${e.callCount} calls)</li>`).join('')}</ul>
        ` : ''}
        ${topFiles.length > 0 ? `
          <h4>Top files:</h4>
          <ul>${topFiles.map(([f, c]) => `<li>${escapeHtml(shortPath(f))} (${c} fn)</li>`).join('')}</ul>
        ` : ''}
        <p class="cm-hint"><em>Double-click to view in Call Graph</em></p>
      </div>
    `;
  }

  private updateCrateSelectionStyle(): void {
    const self = this;
    this.g.selectAll<SVGGElement, unknown>('.cm-crate-group').each(function () {
      const group = d3.select(this);
      const label = group.select('.cm-crate-label').text();
      const ci = self.crateColorMap.get(label) ?? 0;
      const isSource = self.boundarySource === label;
      const isTarget = self.boundaryTarget === label;
      const isRole = isSource || isTarget;

      group.select('.cm-crate-box')
        .attr('stroke', isSource ? ACCENT
          : isTarget ? edgeTypeColor('precondition')
          : isRole ? CRATE_STROKE_SELECTED[ci % CRATE_STROKE_SELECTED.length]
          : CRATE_STROKE_COLORS[ci % CRATE_STROKE_COLORS.length])
        .attr('stroke-width', isRole ? 3.5 : 2);

      // Show/remove role label
      group.selectAll('.cm-role-label').remove();
      if (isSource || isTarget) {
        const box = group.select('.cm-crate-box');
        const bw = parseFloat(box.attr('width'));
        group.append('text')
          .attr('class', 'cm-role-label')
          .attr('x', -bw / 2 + 6)
          .attr('y', parseFloat(box.attr('y')) + 12)
          .attr('font-size', '9px')
          .attr('font-weight', '700')
          .attr('font-family', 'system-ui, sans-serif')
          .attr('fill', isSource ? ACCENT : edgeTypeColor('precondition'))
          .attr('pointer-events', 'none')
          .text(isSource ? 'SOURCE' : 'TARGET');
      }
    });
  }

  private syncDropdowns(): void {
    const srcSel = document.getElementById('source-crate-select') as HTMLSelectElement | null;
    const tgtSel = document.getElementById('target-crate-select') as HTMLSelectElement | null;
    if (srcSel) srcSel.value = this.boundarySource ?? '';
    if (tgtSel) tgtSel.value = this.boundaryTarget ?? '';
    window.dispatchEvent(new CustomEvent('crate-boundary-changed', {
      detail: { source: this.boundarySource, target: this.boundaryTarget },
    }));
  }

  public setBoundaryCrates(source: string | null, target: string | null): void {
    this.boundarySource = source;
    this.boundaryTarget = target;
    if (source && target) {
      this.boundaryActive = true;
      this.expandedEdge = null;
      this.renderBoundary();
    } else {
      if (this.boundaryActive) {
        this.boundaryActive = false;
        if (this.lastFilteredGraph) {
          this.crateGraph = buildCrateGraph(this.lastFilteredGraph);
          this.renderCollapsed();
        }
      }
      this.updateCrateSelectionStyle();
    }
  }

  public getBoundarySource(): string | null { return this.boundarySource; }
  public getBoundaryTarget(): string | null { return this.boundaryTarget; }

  private handleCrateDblClick(cn: CrateNode): void {
    if (!this.lastFilteredGraph) return;

    // Collect all files belonging to this crate
    const files = new Set<string>();
    for (const node of this.lastFilteredGraph.nodes) {
      if (node.crate_name === cn.name && node.file_name) {
        files.add(node.file_name);
      }
    }

    // Set includeFiles filter and switch view by dispatching a custom event
    const newState = { ...this.state };
    newState.filters = { ...newState.filters, includeFiles: [...files].join(', ') };
    this.state = newState;
    this.onStateChange(newState, true);

    // Dispatch event so main.ts can switch the view
    window.dispatchEvent(new CustomEvent('crate-map-switch-view', {
      detail: { view: 'callgraph', includeFiles: [...files].join(', ') },
    }));
  }

  private handleCrateHover(crateName: string, entering: boolean): void {
    if (!entering) {
      this.g.selectAll('.cm-crate-group').style('opacity', 1);
      this.g.selectAll('.cm-edge').attr('stroke-opacity', 0.5);
      this.g.selectAll('.cm-edge-label').style('opacity', 1);
      return;
    }

    const cg = this.crateGraph;
    if (!cg) return;

    const connectedCrates = new Set<string>();
    connectedCrates.add(crateName);
    for (const edge of cg.edges) {
      if (edge.source === crateName) connectedCrates.add(edge.target);
      if (edge.target === crateName) connectedCrates.add(edge.source);
    }

    this.g.selectAll('.cm-crate-group').style('opacity', function () {
      const labelEl = d3.select(this).select('.cm-crate-label');
      const name = labelEl.empty() ? null : labelEl.text();
      return name && connectedCrates.has(name) ? 1 : 0.25;
    });

    this.g.selectAll('.cm-edge').attr('stroke-opacity', function () {
      return 0.25;
    });

    this.g.selectAll('.cm-edge-label').style('opacity', 0.25);
  }

  // ----- Legend -----

  private renderLegend(): void {
    const existing = this.container.querySelector('.cm-legend');
    if (existing) existing.remove();

    const legend = document.createElement('div');
    legend.className = 'cm-legend';
    const mapTitle = crateMapLabel(this.state.projectLanguage);
    const noun = crateNoun(this.state.projectLanguage);
    const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
    legend.innerHTML = `
      <div class="cm-legend-header" id="cm-legend-toggle">
        <strong>${mapTitle}</strong> <span class="cm-legend-arrow">${this.legendVisible ? '\u25BC' : '\u25B6'}</span>
      </div>
      <div class="cm-legend-body" style="display:${this.legendVisible ? 'block' : 'none'}">
        <div class="cm-legend-item">
          <svg width="24" height="16"><rect x="1" y="1" width="22" height="14" rx="4" fill="rgba(66,133,244,0.12)" stroke="rgba(66,133,244,0.5)" stroke-width="1.5"/></svg>
          <span>${Noun}</span>
        </div>
        <div class="cm-legend-item">
          <svg width="24" height="10"><line x1="0" y1="5" x2="24" y2="5" stroke="#888" stroke-width="2"/></svg>
          <span>Cross-${noun} calls</span>
        </div>
        <div class="cm-legend-item">
          <span style="font-size:0.75rem; color:var(--pg-text-muted);">Line width = call count</span>
        </div>
        <div class="cm-legend-section"><strong>Interactions</strong></div>
        <div class="cm-legend-item"><span style="font-size:0.75rem; color:var(--pg-text-muted);">Click edge: expand functions</span></div>
        <div class="cm-legend-item"><span style="font-size:0.75rem; color:var(--pg-text-muted);">Click ${noun}: show info</span></div>
        <div class="cm-legend-item"><span style="font-size:0.75rem; color:var(--pg-text-muted);">Dbl-click ${noun}: open in Call Graph</span></div>
      </div>
    `;
    this.container.appendChild(legend);

    legend.querySelector('#cm-legend-toggle')?.addEventListener('click', () => {
      this.legendVisible = !this.legendVisible;
      const body = legend.querySelector('.cm-legend-body') as HTMLElement;
      const arrow = legend.querySelector('.cm-legend-arrow') as HTMLElement;
      if (body) body.style.display = this.legendVisible ? 'block' : 'none';
      if (arrow) arrow.innerHTML = this.legendVisible ? '\u25BC' : '\u25B6';
    });
  }
}

function shortPath(relativePath: string): string {
  const parts = relativePath.split('/').filter(Boolean);
  if (parts.length <= 2) return relativePath;
  return parts.slice(-2).join('/');
}

