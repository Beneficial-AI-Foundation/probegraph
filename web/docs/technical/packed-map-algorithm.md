# Packed Map Algorithm

The Packed Map is a circle packing of the code. Crates, directories and
files are nested circles. The smallest circles are Rust `exec` functions
or Lean declarations. A circle is sized by its connectivity and filled
with its verification status. Implementation: `web/src/packed-map.ts`. The design
decisions are in [docs/plans/packed-map.md](../../../docs/plans/packed-map.md).

## Input

The filtered graph $G = (V, E)$ from the query pipeline. When the Packed Map
is the active view, the filter step (`applyFilters`, `filters.ts`) applies
`restrictToPackedNodes`. This step keeps the candidates and the links
between them. `isPackedMapCandidate(node, language)` picks the candidates:

- A Rust node, in a `verus`, `unknown` or `mixed` graph: `(kind || 'exec')
  === 'exec'`. Older graphs have no `kind`, so their nodes count as `exec`.
- A Lean node, in a `lean` graph or a node with `language: lean` in a
  `mixed` graph: a node without `is_hidden`, or a hidden node with the
  status `unverified` (it contains a `sorry`).
- Nothing on the blueprint layer.

The stats and the node details therefore count the drawn nodes only.

If a graph has no candidate, for example the blueprint layer, the button
is hidden and the view falls back to the Call Graph. The filters do not
change this test. The
Packed Map draws every function, but like the Crate Map and the Hierarchy it
is in `isAggregatedView`: the large-graph gate and the 200-node result limit
do not apply. In the Phase 1 measurement, a graph with 9,737 nodes (5,454
drawn) took 210 ms to load and draw.

## Step 1. Tree

`buildPackData` reuses `buildHierarchyTree` (see
[hierarchy-algorithm.md](hierarchy-algorithm.md#step-1-tree)): crate,
directory and file groups, with single-child directory chains merged. One
synthetic root holds the crates and is not drawn. Every group gives its
child groups and its own functions as children, because a function with no
path sits directly under its crate. Pack ids are `g:<group id>` for groups
and `f:<node id>` for functions, so a group and a function with the same
name do not collide.

## Step 2. Size

The value of a function $v$ is

$$
w(v) = 1 + \bigl|\{\, u \ne v : (u, v) \in E \lor (v, u) \in E \,\}\bigr|
$$

This is the number of distinct neighbors in either direction, plus 1
(`connectivity`). The 1 keeps an isolated function visible. A function that both
calls and is called by $u$ counts $u$ once. Self-calls do not count.
Groups have no value of their own: `d3.hierarchy(...).sum` adds the leaf
values, and `.sort` puts larger children first.

In `d3.pack`, the area of a leaf circle is proportional to its value. A
group circle is the smallest circle around its packed children. Its size
grows with the summed value, but it is not exactly proportional to it.

## Step 3. Layout

`d3.pack()` lays out the tree in the container's current size, with a
padding of 8 px between the crates and 3 px inside them. If the node
ids or the link endpoints change, the layout is built again. A selection, a
hover or a change of link types only redraws. A new graph load always
builds a new layout, because the ids can stay while statuses change.

## Step 4. Visual encoding

- **Function circle**: filled with the status colour (`statusColor`).
  A function with no status gets `--pg-status-unknown`. The selected function has
  a 2 px ring in the selection colour.
- **Group circle**: a neutral grey fill whose alpha is
  $\min(0.05 + 0.035\,d,\ 0.25)$ at depth $d$, so deeper groups are darker.
- **Verified arc**: a 3 px arc outside each group circle, from 12 o'clock
  clockwise, over $2\pi \cdot n_\text{verified} / n$
  (`packedArcStatus`). For a Rust node, the verified statuses are
  verified, transitively verified and trusted, as in the Hierarchy
  rollup. For a Lean node, only transitively verified and trusted count,
  because a Lean `verified` declaration can rest on a `sorry`. In a
  mixed graph, each node uses the rule of its own language.

## Camera

One `d3.zoom` transform is the only camera. Wheel, drag and click zoom all
change it, so a wheel step after a click zoom starts where the click zoom
stopped. A click on a group animates the camera to fit the group
(600 ms). `fitCamera` fits a circle $(c_x, c_y, r)$ in a $W \times H$ view, with
a margin $m = 0.05$:

$$
k = \frac{\min(W, H)\,(1 - 2m)}{2r}, \qquad
t = \left(\tfrac{W}{2} - k\,c_x,\ \tfrac{H}{2} - k\,c_y\right)
$$
 Esc, `-` or a background click zoom out to the parent group.
With no zoomed group, the camera is the identity for the size the pack was
laid out in. After a resize it scales the pack by the change of the shorter
side and centers it. The lowest zoom scale is half the scale that fits the
whole pack (`minZoomScale`), and the highest is 10,000. No camera that the
view sets is at the lower limit.

A new click, a new layout, a resize and `destroy` stop a running zoom.

## Labels

Labels and edges are drawn in screen coordinates on every zoom event, so
their font size and stroke width do not change with the zoom.

- If a group has a screen radius of at least 30 px, and none of its child
  groups is that large, it gets a label (`visibleGroupLabels`). Only one level of
  labels shows on each branch, the deepest large one. The label is 12 px,
  16 px below the top of the circle, cut to 90% of the chord at that height.
- If a function has a screen radius of at least 20 px, it gets a label. The label
  is 11 px, centered, cut to 85% of the diameter.
- `fitLabel` cuts a name with "…", with an estimated character width of
  0.6 times the font size. Only labels of circles on screen are drawn.

## Edges

No edges are drawn by default. For the hovered function, or else the
selected one, `edgesOf` collects its calls to and from other drawn
functions, one per source, target and type. The list is cached for the
function and the graph, so a zoom event only computes the curves.

A type map runs first. A `lean` graph draws every link as `inner`, so a
Lean dependency is one edge. A `mixed` graph draws a `spec` link as
`inner` (`mixedEdgeType`) and keeps the other types, also `mapping`.
Only the Lean side of a mixed graph has `spec` links.

Each call is a quadratic Bézier between the two centers, with the control
point at the midpoint moved sideways by `bend` times the distance
(`edgeCurve`). The bend is 0.2 for the first call between a pair and grows
by 0.15 for each further type (`edgeBends`), so a call in each direction, or
two call types, give separate curves. The curve is cut where it leaves the
source circle and where it enters the target circle, by bisection, and the
cut part is again a quadratic Bézier. The edge has an arrowhead at the
callee and the colour of its type (`--pg-edge-<type>`). The edge layer takes
no pointer events.

## Keyboard

The SVG is one tab stop with `role="listbox"`, and each function circle is
an option. The arrow keys move a focus ring through the functions in
depth-first order, crate by crate and file by file (`functionOrder`). Home
and End go to the first and the last. If the focused function is off
screen, the camera pans to it. Enter or Space selects it. `+` zooms in one
level toward it (`zoomInTarget`). A live region announces each zoom.

## URL state

The zoomed group is kept in `?packed=<group id>`, written with
`replaceState`, so Back does not step through zooms. Free pan and zoom are
not kept. If the group is not in the layout after a load, a filter change
or Back, the view shows the whole project and drops the parameter. The
user-facing description is in the
[viewer guide](../../../docs/guides/viewer.md#views).

## References

- W. Wang, H. Wang, G. Dai and H. Wang, "Visualization of large
  hierarchical data by circle packing," *CHI 2006*, pp. 517–520,
  <https://doi.org/10.1145/1124772.1124851>. The layout of `d3.pack`.
- d3-hierarchy, "Pack," <https://d3js.org/d3-hierarchy/pack>. `d3.pack`,
  `d3.packSiblings` and `d3.packEnclose`. The enclosing circle uses Welzl's
  algorithm.
- M. Bostock, "Zoomable circle packing,"
  <https://observablehq.com/@d3/zoomable-circle-packing>. The click zoom
  pattern.
