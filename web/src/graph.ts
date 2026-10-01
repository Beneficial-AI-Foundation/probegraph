import * as d3 from 'd3';
import { D3Graph, D3Node, D3Link, GraphState } from './types';
import { statusColor, edgeTypeColor, SELECTION_COLOR, TEXT_COLOR } from './theme';
import { anchorIds } from './intent';

/**
 * Compute topological depth for each node in the graph.
 * Nodes with no incoming edges (callers) are at depth 0.
 * Depth increases as we follow call edges (longest path on a DAG).
 * On cyclic inputs, depths around a cycle are capped at the node count so the
 * walk terminates; the resulting layering is arbitrary there but finite.
 * Returns a Map from node id to depth.
 *
 * Exported for testing (the renderer calls it as the fallback when the
 * filtered graph carries no precomputed nodeDepths).
 */
export function computeTopologicalDepth(nodes: D3Node[], links: D3Link[]): Map<string, number> {
  const depths = new Map<string, number>();
  const nodeIds = new Set(nodes.map(n => n.id));
  
  // Build adjacency lists
  const incomingEdges = new Map<string, string[]>();  // node -> list of nodes that call it
  const outgoingEdges = new Map<string, string[]>();  // node -> list of nodes it calls
  
  for (const node of nodes) {
    incomingEdges.set(node.id, []);
    outgoingEdges.set(node.id, []);
  }
  
  for (const link of links) {
    const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
    const targetId = typeof link.target === 'string' ? link.target : link.target.id;
    
    // Only consider edges between nodes in our current graph
    if (nodeIds.has(sourceId) && nodeIds.has(targetId)) {
      outgoingEdges.get(sourceId)?.push(targetId);
      incomingEdges.get(targetId)?.push(sourceId);
    }
  }
  
  // Find root nodes (no incoming edges) - these are "entry points"
  const roots: string[] = [];
  for (const node of nodes) {
    if (incomingEdges.get(node.id)?.length === 0) {
      roots.push(node.id);
    }
  }
  
  // If no roots found (cycles?), use nodes with lowest in-degree
  if (roots.length === 0) {
    const nodesByInDegree = [...nodes].sort((a, b) => 
      (incomingEdges.get(a.id)?.length || 0) - (incomingEdges.get(b.id)?.length || 0)
    );
    if (nodesByInDegree.length > 0) {
      roots.push(nodesByInDegree[0].id);
    }
  }
  
  // BFS to compute depths
  const queue: Array<{ id: string; depth: number }> = roots.map(id => ({ id, depth: 0 }));
  
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;

    // Take max depth if already visited (handles DAG correctly).
    // The depth cap makes cycles terminate: without it, a reachable cycle
    // raises depths forever and this loop never ends.
    const currentDepth = depths.get(id);
    if ((currentDepth !== undefined && currentDepth >= depth) || depth > nodes.length) {
      continue;
    }

    depths.set(id, depth);
    
    // Process callees (outgoing edges)
    for (const calleeId of outgoingEdges.get(id) || []) {
      queue.push({ id: calleeId, depth: depth + 1 });
    }
  }
  
  // Handle any unvisited nodes (disconnected components)
  for (const node of nodes) {
    if (!depths.has(node.id)) {
      depths.set(node.id, 0);
    }
  }
  
  return depths;
}

/**
 * Minimize edge crossings using the barycenter heuristic (Sugiyama framework).
 * For each layer, reorder nodes by the average position of their neighbors in
 * the adjacent layer. Multiple forward+backward sweeps converge toward a
 * crossing-minimal ordering.
 */
function minimizeCrossings(
  nodesByDepth: Map<number, D3Node[]>,
  links: D3Link[],
  iterations: number = 6
): void {
  const nodeIds = new Set<string>();
  for (const layer of nodesByDepth.values()) {
    for (const n of layer) nodeIds.add(n.id);
  }

  // Build bidirectional adjacency limited to displayed nodes
  const forward = new Map<string, string[]>();   // source → targets
  const backward = new Map<string, string[]>();   // target → sources
  for (const link of links) {
    const s = typeof link.source === 'string' ? link.source : link.source.id;
    const t = typeof link.target === 'string' ? link.target : link.target.id;
    if (!nodeIds.has(s) || !nodeIds.has(t)) continue;
    if (!forward.has(s)) forward.set(s, []);
    forward.get(s)!.push(t);
    if (!backward.has(t)) backward.set(t, []);
    backward.get(t)!.push(s);
  }

  // Map node id → current index within its layer (updated each sweep)
  const positionOf = new Map<string, number>();
  const refreshPositions = () => {
    for (const layer of nodesByDepth.values()) {
      layer.forEach((n, i) => positionOf.set(n.id, i));
    }
  };

  const sortedDepths = [...nodesByDepth.keys()].sort((a, b) => a - b);

  for (let iter = 0; iter < iterations; iter++) {
    refreshPositions();

    // Forward sweep (low depth → high): order by neighbors in previous layer
    for (let di = 1; di < sortedDepths.length; di++) {
      const layer = nodesByDepth.get(sortedDepths[di])!;
      const bary = new Map<string, number>();
      for (const node of layer) {
        const neighbors = backward.get(node.id);
        if (neighbors && neighbors.length > 0) {
          let sum = 0;
          for (const nid of neighbors) sum += positionOf.get(nid) ?? 0;
          bary.set(node.id, sum / neighbors.length);
        } else {
          bary.set(node.id, positionOf.get(node.id) ?? 0);
        }
      }
      layer.sort((a, b) => bary.get(a.id)! - bary.get(b.id)!);
      layer.forEach((n, i) => positionOf.set(n.id, i));
    }

    // Backward sweep (high depth → low): order by neighbors in next layer
    for (let di = sortedDepths.length - 2; di >= 0; di--) {
      const layer = nodesByDepth.get(sortedDepths[di])!;
      const bary = new Map<string, number>();
      for (const node of layer) {
        const neighbors = forward.get(node.id);
        if (neighbors && neighbors.length > 0) {
          let sum = 0;
          for (const nid of neighbors) sum += positionOf.get(nid) ?? 0;
          bary.set(node.id, sum / neighbors.length);
        } else {
          bary.set(node.id, positionOf.get(node.id) ?? 0);
        }
      }
      layer.sort((a, b) => bary.get(a.id)! - bary.get(b.id)!);
      layer.forEach((n, i) => positionOf.set(n.id, i));
    }
  }
}

interface LayoutInfo {
  depths: Map<string, number>;
  maxDepth: number;
  maxLayerWidth: number;
  nodesByDepth: Map<number, D3Node[]>;
}

/**
 * Assign initial positions based on topological or traversal-provided depth.
 * Uses barycenter heuristic to minimize edge crossings within each layer.
 */
function assignTopologicalPositions(
  nodes: D3Node[],
  links: D3Link[],
  width: number,
  height: number,
  precomputedDepths?: Map<string, number>
): LayoutInfo {
  const depths = precomputedDepths ?? computeTopologicalDepth(nodes, links);

  const nodesByDepth = new Map<number, D3Node[]>();
  let maxDepth = 0;

  for (const node of nodes) {
    const depth = depths.get(node.id) ?? 0;
    maxDepth = Math.max(maxDepth, depth);
    if (!nodesByDepth.has(depth)) nodesByDepth.set(depth, []);
    nodesByDepth.get(depth)!.push(node);
  }

  // Initial ordering: alphabetical (deterministic seed for barycenter)
  for (const layer of nodesByDepth.values()) {
    layer.sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  // Apply barycenter crossing minimization
  minimizeCrossings(nodesByDepth, links);

  let maxLayerWidth = 0;
  for (const layer of nodesByDepth.values()) {
    maxLayerWidth = Math.max(maxLayerWidth, layer.length);
  }

  const padding = 100;
  const usableWidth = width - 2 * padding;
  const usableHeight = height - 2 * padding;
  const xSpacing = maxDepth > 0 ? usableWidth / maxDepth : usableWidth / 2;

  for (const [depth, nodesAtDepth] of nodesByDepth) {
    const x = padding + depth * xSpacing;
    const ySpacing = usableHeight / (nodesAtDepth.length + 1);

    nodesAtDepth.forEach((node, index) => {
      node.x = x;
      node.y = padding + (index + 1) * ySpacing;
    });
  }

  return { depths, maxDepth, maxLayerWidth, nodesByDepth };
}

/** Camera transform produced by the fit-to-view computation. */
export interface FitTransform {
  k: number;
  x: number;
  y: number;
}

/**
 * Compute a zoom transform that fits the given node positions into the
 * viewport, clamped to [minScale, maxScale] so large graphs stay readable
 * instead of shrinking to dots. When the true fit scale falls below
 * minScale, the transform centers on `focus` (if given) at minScale so the
 * relevant node is in view even though the whole graph is not.
 * Returns null when there are no positioned nodes or the viewport is empty.
 *
 * Exported for testing (the renderer applies the result via d3.zoom).
 */
export function computeFitTransform(
  nodes: Array<{ x?: number; y?: number }>,
  width: number,
  height: number,
  focus?: { x?: number; y?: number } | null,
  minScale: number = 0.4,
  maxScale: number = 1,
  margin: number = 60
): FitTransform | null {
  const positioned = nodes.filter(n => n.x !== undefined && n.y !== undefined);
  if (positioned.length === 0 || width <= 0 || height <= 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of positioned) {
    if (n.x! < minX) minX = n.x!;
    if (n.x! > maxX) maxX = n.x!;
    if (n.y! < minY) minY = n.y!;
    if (n.y! > maxY) maxY = n.y!;
  }

  const bboxWidth = maxX - minX + 2 * margin;
  const bboxHeight = maxY - minY + 2 * margin;
  const fitScale = Math.min(width / bboxWidth, height / bboxHeight);
  const k = Math.max(minScale, Math.min(maxScale, fitScale));

  let cx = (minX + maxX) / 2;
  let cy = (minY + maxY) / 2;
  if (fitScale < minScale && focus && focus.x !== undefined && focus.y !== undefined) {
    cx = focus.x;
    cy = focus.y;
  }

  return { k, x: width / 2 - k * cx, y: height / 2 - k * cy };
}

export class CallGraphVisualization {
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private g: d3.Selection<SVGGElement, unknown, null, undefined>;
  private width: number;
  private height: number;
  private simulation: d3.Simulation<D3Node, D3Link> | null = null;
  private state: GraphState;
  private onStateChange: (state: GraphState, selectionChanged?: boolean) => void;

  private linkElements: d3.Selection<SVGPathElement, D3Link, SVGGElement, unknown> | null = null;
  private nodeElements: d3.Selection<SVGCircleElement, D3Node, SVGGElement, unknown> | null = null;
  private textElements: d3.Selection<SVGTextElement, D3Node, SVGGElement, unknown> | null = null;

  private zoom: d3.ZoomBehavior<SVGSVGElement, unknown>;
  // Node ids of the last render; the camera only auto-fits when this set
  // changes, so hover/selection re-renders never move the user's view.
  private renderedNodeIds: Set<string> = new Set();
  private currentNodes: D3Node[] = [];

  /**
   * Gets whether the node was selected before the double-click's first
   * click; returns whether it handled the double-click.
   */
  private onNodeDoubleClick?: (node: D3Node, wasSelected: boolean) => boolean;
  private lastNodeClick: { node: D3Node; wasSelected: boolean } | null = null;

  constructor(
    container: HTMLElement,
    state: GraphState,
    onStateChange: (state: GraphState, selectionChanged?: boolean) => void,
    onNodeDoubleClick?: (node: D3Node, wasSelected: boolean) => boolean,
  ) {
    this.state = state;
    this.onStateChange = onStateChange;
    this.onNodeDoubleClick = onNodeDoubleClick;

    // Get container dimensions
    const rect = container.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;

    // Create SVG
    this.svg = d3
      .select(container)
      .append('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('viewBox', `0 0 ${this.width} ${this.height}`);

    // Add zoom behavior
    this.zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 10])
      .on('zoom', (event) => {
        this.g.attr('transform', event.transform);
      });

    this.svg.call(this.zoom);

    // The first click of a double-click selects the node, which re-queries
    // and can move it from under the pointer; the second click then misses
    // it. So a double-click is matched to the node of its first click, in
    // the capture phase to keep d3-zoom's double-click zoom off it when the
    // callback handles it. Every first click clears the match here, and a
    // click on a node sets it again in handleNodeClick.
    const svgNode = this.svg.node()!;
    svgNode.addEventListener('click', (event) => {
      if (event.detail <= 1) this.lastNodeClick = null;
    }, true);
    svgNode.addEventListener('dblclick', (event) => {
      const first = this.lastNodeClick;
      this.lastNodeClick = null;
      if (first && this.onNodeDoubleClick?.(first.node, first.wasSelected)) {
        event.stopImmediatePropagation();
      }
    }, true);

    // Create main group for zooming/panning
    this.g = this.svg.append('g');

    // Add arrow markers for directed edges
    this.svg
      .append('defs')
      .append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 20)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#999');
  }

  /**
   * Update the visualization with new filtered graph
   */
  public update(filteredGraph: D3Graph): void {
    if (!filteredGraph || filteredGraph.nodes.length === 0) {
      this.clear();
      return;
    }

    // Stop existing simulation
    if (this.simulation) {
      this.simulation.stop();
    }

    // Create a deep copy of nodes and links for D3
    const nodes = filteredGraph.nodes.map(node => ({ ...node }));
    const links = filteredGraph.links.map(link => ({ ...link }));

    // Use filter-provided depths when available (semantically correct for
    // source/sink queries), otherwise fall back to topological BFS.
    const precomputedDepths = filteredGraph.nodeDepths;

    // Assign initial positions with barycenter crossing minimization
    const layout = assignTopologicalPositions(
      nodes, links, this.width, this.height, precomputedDepths
    );

    // Adaptive canvas: expand the effective layout area for large graphs
    const effectiveWidth = Math.max(this.width, layout.maxDepth * 200 + 200);
    const effectiveHeight = Math.max(this.height, layout.maxLayerWidth * 60 + 200);

    // Recompute positions if the effective area changed
    if (effectiveWidth !== this.width || effectiveHeight !== this.height) {
      const padding = 100;
      const usableW = effectiveWidth - 2 * padding;
      const usableH = effectiveHeight - 2 * padding;
      const xSp = layout.maxDepth > 0 ? usableW / layout.maxDepth : usableW / 2;

      for (const [depth, layer] of layout.nodesByDepth) {
        const x = padding + depth * xSp;
        const ySp = usableH / (layer.length + 1);
        layer.forEach((node, i) => {
          node.x = x;
          node.y = padding + (i + 1) * ySp;
        });
      }
    }

    // Compute target X positions for the x-force
    const padding = 100;
    const layoutWidth = Math.max(effectiveWidth, this.width);
    const usableWidth = layoutWidth - 2 * padding;
    const xSpacing = layout.maxDepth > 0 ? usableWidth / layout.maxDepth : usableWidth / 2;

    const targetX = new Map<string, number>();
    const targetY = new Map<string, number>();
    for (const node of nodes) {
      const depth = layout.depths.get(node.id) ?? 0;
      targetX.set(node.id, padding + depth * xSpacing);
      targetY.set(node.id, node.y!);
    }

    // Adaptive force parameters based on graph size
    const nodeCount = nodes.length;
    const charge = Math.max(-600, Math.min(-150, -150 - nodeCount * 3));
    const linkDist = Math.max(60, Math.min(200, 60 + layout.maxLayerWidth * 8));
    const collisionRadius = 25 + Math.min(nodeCount * 0.3, 20);
    const yStrength = layout.maxLayerWidth > 0
      ? 0.03 + 0.02 * (layout.maxLayerWidth / Math.max(nodeCount, 1))
      : 0.05;

    // Create force simulation with layered layout
    this.simulation = d3
      .forceSimulation<D3Node>(nodes)
      .force(
        'link',
        d3.forceLink<D3Node, D3Link>(links)
          .id(d => d.id)
          .distance(linkDist)
          .strength(0.5)
      )
      .force('charge', d3.forceManyBody().strength(charge))
      .force('x', d3.forceX<D3Node>(d => targetX.get(d.id) || layoutWidth / 2).strength(0.8))
      .force('y', d3.forceY<D3Node>(d => targetY.get(d.id) || effectiveHeight / 2).strength(yStrength))
      .force('collision', d3.forceCollide().radius(collisionRadius));

    // Update links (curved <path> elements instead of straight <line>)
    this.linkElements = this.g
      .selectAll<SVGPathElement, D3Link>('path.link')
      .data(links, (d: D3Link) => {
        const source = typeof d.source === 'string' ? d.source : d.source.id;
        const target = typeof d.target === 'string' ? d.target : d.target.id;
        const linkType = d.type || 'inner';
        return `${source}-${target}-${linkType}`;
      });

    this.linkElements.exit().remove();

    const linkEnter = this.linkElements
      .enter()
      .append('path')
      .attr('class', 'link')
      .attr('fill', 'none')
      .attr('stroke', (d) => edgeTypeColor(d.type))
      .attr('stroke-opacity', 0.6)
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', (d) => {
        const linkType = d.type || 'inner';
        if (linkType === 'precondition' || linkType === 'postcondition') return '5,3';
        if (linkType === 'mapping') return '2,4';
        if (linkType === 'spec') return '3,3';
        return 'none';
      })
      .attr('marker-end', 'url(#arrowhead)');

    this.linkElements = linkEnter.merge(this.linkElements);

    // Update nodes
    this.nodeElements = this.g
      .selectAll<SVGCircleElement, D3Node>('circle')
      .data(nodes, (d: D3Node) => d.id);

    this.nodeElements.exit().remove();

    const nodeEnter = this.nodeElements
      .enter()
      .append('circle')
      .attr('class', 'node')
      .attr('r', (d) => Math.max(5, Math.min(15, Math.sqrt(d.dependents.length + (d.dependencies?.length || 0)) * 2)))
      .attr('fill', (d) => this.getNodeColor(d))
      .attr('stroke', '#fff')
      .attr('stroke-width', 2)
      .style('cursor', 'pointer')
      .call(this.dragBehavior() as any);

    nodeEnter
      .on('click', (event, d) => this.handleNodeClick(event, d))
      .on('mouseenter', (event, d) => this.handleNodeHover(event, d))
      .on('mouseleave', () => this.handleNodeLeave());

    this.nodeElements = nodeEnter.merge(this.nodeElements);

    // Update text labels
    this.textElements = this.g
      .selectAll<SVGTextElement, D3Node>('text')
      .data(nodes, (d: D3Node) => d.id);

    this.textElements.exit().remove();

    const textEnter = this.textElements
      .enter()
      .append('text')
      .attr('class', 'label')
      .attr('text-anchor', 'middle')
      .attr('dy', -20)
      .attr('font-size', '10px')
      .attr('font-family', 'sans-serif')
      .attr('fill', TEXT_COLOR)
      .attr('pointer-events', 'none')
      .text((d) => d.display_name);

    this.textElements = textEnter.merge(this.textElements);

    // Update positions on each tick
    this.simulation.on('tick', () => {
      this.linkElements?.attr('d', (d) => {
        const sx = (d.source as D3Node).x!;
        const sy = (d.source as D3Node).y!;
        const tx = (d.target as D3Node).x!;
        const ty = (d.target as D3Node).y!;
        const dx = tx - sx;
        return `M${sx},${sy} C${sx + dx * 0.4},${sy} ${tx - dx * 0.4},${ty} ${tx},${ty}`;
      });

      this.nodeElements
        ?.attr('cx', (d) => d.x!)
        .attr('cy', (d) => d.y!);

      this.textElements
        ?.attr('x', (d) => d.x!)
        .attr('y', (d) => d.y!);
    });

    // Reheat simulation
    this.simulation.alpha(1).restart();

    // Auto-fit the camera when the displayed node set changed (new query or
    // filter result); an unchanged set means a cosmetic re-render and the
    // user's camera stays put.
    const nodeIds = new Set(nodes.map(n => n.id));
    const setChanged =
      nodeIds.size !== this.renderedNodeIds.size ||
      [...nodeIds].some(id => !this.renderedNodeIds.has(id));
    this.renderedNodeIds = nodeIds;
    this.currentNodes = nodes;
    if (setChanged) {
      this.fitToView();
    }
  }

  /**
   * Fit the camera to the current graph, or center on the focus node at the
   * minimum readable scale when the graph is too large to fit. Also exposed
   * on the "Reset View" button.
   */
  public resetView(): void {
    this.fitToView();
  }

  private fitToView(): void {
    const t = computeFitTransform(
      this.currentNodes, this.width, this.height, this.findFocusNode()
    );
    if (!t) return;
    this.svg
      .transition()
      .duration(400)
      .call(this.zoom.transform as any, d3.zoomIdentity.translate(t.x, t.y).scale(t.k));
  }

  /** The node to center on when the whole graph cannot fit: the selected
   * node if it is displayed, else the first displayed focus-set or exact
   * intent node. */
  private findFocusNode(): D3Node | null {
    const selectedId = this.state.selectedNode?.id;
    if (selectedId) {
      const selected = this.currentNodes.find(n => n.id === selectedId);
      if (selected) return selected;
    }
    const focusIds = new Set(anchorIds(this.state.filters.intent));
    if (focusIds.size > 0) {
      const focused = this.currentNodes.find(n => focusIds.has(n.id));
      if (focused) return focused;
    }
    return null;
  }

  /** Get node color based on verification status (palette in theme.ts). */
  private getNodeColor(node: D3Node): string {
    return statusColor(node.verification_status);
  }

  /**
   * Drag behavior for nodes
   */
  private dragBehavior(): d3.DragBehavior<Element, D3Node, D3Node | d3.SubjectPosition> {
    return d3
      .drag<Element, D3Node>()
      .on('start', (event, d) => {
        if (!event.active && this.simulation) {
          this.simulation.alphaTarget(0.3).restart();
        }
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active && this.simulation) {
          this.simulation.alphaTarget(0);
        }
        d.fx = null;
        d.fy = null;
      });
  }

  /**
   * Handle node click
   * - Normal click: select/deselect node
   * - Shift+click: hide node
   */
  private handleNodeClick(event: MouseEvent, node: D3Node): void {
    event.stopPropagation();
    if (event.detail <= 1 && !event.shiftKey) {
      this.lastNodeClick = { node, wasSelected: this.state.filters.selectedNodes.has(node.id) };
    }
    
    const newState = { ...this.state };
    
    // Shift+click: hide the node
    if (event.shiftKey) {
      newState.filters.hiddenNodes.add(node.id);
      // Clear selection if hiding the selected node
      if (newState.selectedNode?.id === node.id) {
        newState.selectedNode = null;
      }
      newState.filters.selectedNodes.delete(node.id);
      this.state = newState;
      this.onStateChange(newState, true);  // Triggers re-filter
      return;
    }
    
    // Normal click: toggle selection
    newState.selectedNode = node;
    
    // Toggle node selection for filtering
    if (newState.filters.selectedNodes.has(node.id)) {
      newState.filters.selectedNodes.delete(node.id);
    } else {
      newState.filters.selectedNodes.add(node.id);
    }
    
    this.state = newState;  // Keep local state in sync
    this.onStateChange(newState, true);  // Selection changed
    this.highlightNode(node);
  }

  /**
   * Handle node hover
   */
  private handleNodeHover(_event: MouseEvent, node: D3Node): void {
    const newState = { ...this.state };
    newState.hoveredNode = node;
    this.state = newState;  // Keep local state in sync
    this.onStateChange(newState, false);  // Hover only, no selection change
    
    // Highlight connected nodes
    this.nodeElements?.style('opacity', (d) => {
      if (d.id === node.id) return 1;
      // Check if connected
      const isConnected = this.state.filteredGraph?.links.some(link => {
        const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
        const targetId = typeof link.target === 'string' ? link.target : link.target.id;
        return (sourceId === node.id && targetId === d.id) ||
               (targetId === node.id && sourceId === d.id);
      });
      return isConnected ? 1 : 0.2;
    });

    this.linkElements?.style('opacity', (link) => {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
      return (sourceId === node.id || targetId === node.id) ? 1 : 0.1;
    });
  }

  /**
   * Handle node leave
   */
  private handleNodeLeave(): void {
    const newState = { ...this.state };
    newState.hoveredNode = null;
    this.state = newState;  // Keep local state in sync
    this.onStateChange(newState, false);  // Hover only, no selection change
    
    this.nodeElements?.style('opacity', 1);
    this.linkElements?.style('opacity', 0.6);
  }

  /**
   * Highlight a specific node
   */
  private highlightNode(node: D3Node): void {
    this.nodeElements
      ?.attr('stroke', (d) => (d.id === node.id ? SELECTION_COLOR : '#fff'))
      .attr('stroke-width', (d) => (d.id === node.id ? 4 : 2));
  }

  /**
   * Clear the visualization
   */
  public clear(): void {
    this.g.selectAll('*').remove();
    this.renderedNodeIds = new Set();
    this.currentNodes = [];
    if (this.simulation) {
      this.simulation.stop();
    }
  }

  /**
   * Resize the visualization
   */
  public resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.svg.attr('viewBox', `0 0 ${width} ${height}`);
    
    if (this.simulation) {
      // Update the y-centering force for new height
      this.simulation
        .force('y', d3.forceY(height / 2).strength(0.05))
        .alpha(0.3)
        .restart();
    }
  }
}

