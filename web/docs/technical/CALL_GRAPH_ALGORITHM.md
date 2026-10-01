# Call Graph Algorithm

The Call Graph draws every function in the query result as a circle and every
link as a curve, callers on the left and callees on the right. A layered
(Sugiyama-style) layout gives the starting positions and a D3 force
simulation then refines them. Implementation: `web/src/graph.ts`.

## Input

The filtered graph $G = (V, E)$ from the query pipeline, truncated to 200
nodes except in the seeded view of a large graph (see
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#performance)):

- each $v \in V$ has a display name, a verification status in
  {verified, transitively-verified, trusted, failed, unverified} or none, and
  its full-graph `dependencies` (callees) and `dependents` (callers);
- each link $(u, v, t) \in E$ has a type
  $t \in \{\text{inner}, \text{precondition}, \text{postcondition}, \text{mapping}, \text{spec}\}$;
- optionally, depths $d_0: V \to \mathbb{N}$ precomputed by a source/sink
  query (`nodeDepths`).

Only links whose two ends are both in $V$ take part in the layout.

## Phase 1. Layer assignment

If $d_0$ is given it is used as is. Otherwise `computeTopologicalDepth`
computes a longest-path layering:

1. Roots $R = \{v \mid \text{in-degree}(v) = 0\}$. If $R = \emptyset$ (every
   node is on or below a cycle), $R$ is the single node of minimum in-degree.
2. BFS from $R$ at depth 0, following outgoing links. A node is re-queued
   whenever it is reached with a larger depth, so

$$
d(v) = \max_{(u, v, \_) \in E} \big( d(u) + 1 \big)
$$

   on a DAG. Depths are capped at $|V|$ so that a reachable cycle terminates;
   the layering around a cycle is then arbitrary but finite.
3. Nodes the BFS never reached get $d(v) = 0$.

Layers are $L_k = \{v \mid d(v) = k\}$ for $k = 0, \ldots, d_{\max}$.

## Phase 2. Crossing minimization

Each layer starts sorted by display name (a deterministic seed), then
`minimizeCrossings` runs $I = 6$ iterations of a forward and a backward
barycenter sweep. In the forward sweep (layers $1 \ldots d_{\max}$) each node
gets

$$
\text{bary}(v) = \frac{1}{|N^-(v)|} \sum_{u \in N^-(v)} \text{idx}(u)
$$

where $N^-(v)$ are its predecessors and $\text{idx}(u)$ is $u$'s current
index within its own layer; the layer is then sorted by barycenter. The
backward sweep (layers $d_{\max} - 1 \ldots 0$) is symmetric over successors
$N^+(v)$. A node with no neighbours on the swept side keeps its current index
as its barycenter.

$N^\pm$ are not restricted to the adjacent layer: any displayed neighbour
contributes its index, whatever its depth.

## Phase 3. Initial coordinates

The layout area grows with the graph:

$$
W_{\text{eff}} = \max(W, \; 200\,d_{\max} + 200), \qquad
H_{\text{eff}} = \max(H, \; 60 \max_k |L_k| + 200)
$$

where $W \times H$ is the container. With padding $p = 100$, a node at rank
$i$ (zero-based) in layer $L_k$ is placed at

$$
x_v = p + d(v) \cdot \frac{W_{\text{eff}} - 2p}{d_{\max}}, \qquad
y_v = p + (i + 1) \cdot \frac{H_{\text{eff}} - 2p}{|L_k| + 1}
$$

When $d_{\max} = 0$ the column spacing is $(W_{\text{eff}} - 2p)/2$, so every
node sits at $x = p$. These positions are also the targets
$x_{\text{target}}, y_{\text{target}}$ of the positional forces below.

## Phase 4. Force simulation

`d3.forceSimulation` refines the positions under five forces. With
$n = |V|$ and $m = \max_k |L_k|$ (the widest layer):

| Force | d3 force | Parameters |
|-------|----------|------------|
| Link (spring along each link) | `forceLink` | strength 0.5, distance $d_{\text{link}} = \text{clamp}(60 + 8m,\; 60,\; 200)$ |
| Charge (repulsion, Barnes–Hut) | `forceManyBody` | strength $q = \text{clamp}(-150 - 3n,\; -600,\; -150)$ |
| Column pull | `forceX` | target $x_{\text{target}}(v)$, strength 0.8 |
| Row pull | `forceY` | target $y_{\text{target}}(v)$, strength $k_y = 0.03 + 0.02\,m/n$ (0.05 if $m = 0$) |
| Collision | `forceCollide` | radius $r_c = 25 + \min(0.3\,n,\; 20)$ |

The strong column pull keeps the layered left-to-right structure; the weak
row pull ($k_y \in [0.03, 0.05]$) lets the other forces rearrange nodes
vertically. The simulation starts at $\alpha = 1$ and cools with d3-force's
default decay; link curves and labels are redrawn on every tick.

Dragging a node pins it ($f_x, f_y$ follow the pointer) and reheats the
simulation to $\alpha_{\text{target}} = 0.3$; releasing it unpins the node and
sets $\alpha_{\text{target}} = 0$. Resizing the window replaces the row pull
with a pull toward the new vertical centre (strength 0.05) and reheats to
$\alpha = 0.3$.

## Phase 5. Visual encoding

**Nodes.** Circles with radius

$$
r(v) = \text{clamp}\!\left(2\sqrt{|\text{deps}(v)| + |\text{dependents}(v)|},\; 5,\; 15\right)
$$

using the full-graph degree, not the degree within the result. The fill is
`statusColor(status)`, i.e. the `--pg-status-<status>` token, with
`--pg-status-unknown` for a missing status. Nodes have a white 2px stroke;
the selected node gets a 4px `--pg-selection` stroke. Labels sit 20px above
the centre in `--pg-text`.

**Edges.** Centre-to-centre Béziers with $c = 0.4$, typed colours and dashes
as in [README.md](README.md#shared-edge-geometry), opacity 0.6, width 1.5,
with an arrowhead.

## Phase 6. Auto-fit camera

`computeFitTransform` fits the bounding box of the node positions, padded by a
60px margin, into the $W \times H$ viewport:

$$
k = \text{clamp}\!\left(\min\!\left(\frac{W}{w_b}, \frac{H}{h_b}\right),\; 0.4,\; 1\right)
$$

and translates the centre point to the viewport centre at scale $k$. The
centre point is the bounding-box centre, except when the true fit scale is
below 0.4 and a focus node exists: then it is the focus node, so the relevant
node is on screen even though the whole graph is not. The focus node is the
selected node if it is displayed, otherwise the first displayed node of the
query's focus set or exact intent (`anchorIds`); with neither, the camera
centres on the bounding box at scale 0.4.

The fit runs automatically only when the set of displayed node IDs changes,
before the simulation has ticked, so it fits the Phase 3 positions; it is
animated over 400ms. Hover, selection and resize re-renders leave the camera
alone. The **Reset View** button runs the same fit on the current positions.
Manual zoom is limited to $[0.1, 10]$.

## Interaction

Click, Shift+click, hover and double-click behaviour is described in the
[viewer guide](../../../docs/guides/viewer.md#clicking-nodes). Hover dims
non-neighbours to opacity 0.2 and non-incident links to 0.1.

## References

- Sugiyama, Tagawa & Toda, "Methods for Visual Understanding of Hierarchical System Structures," *IEEE SMC* 11(2), 1981 — layering and barycenter ordering.
- Fruchterman & Reingold, "Graph Drawing by Force-Directed Placement," *SP&E* 21(11), 1991 — spring-electric model.
- Barnes & Hut, "A Hierarchical $O(N \log N)$ Force-Calculation Algorithm," *Nature* 324, 1986 — charge approximation in `d3-force`.
- Dwyer, "Scalable, Versatile and Simple Constrained Graph Layout," *EuroVis* 2009 — force layout with layer constraints.
