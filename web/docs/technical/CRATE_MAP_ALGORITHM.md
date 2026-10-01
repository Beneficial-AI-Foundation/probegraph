# Crate Map Algorithm

The Crate Map collapses the function graph into one box per crate with
weighted edges between crates, and offers two drill-downs: expand one crate
edge into its function calls, or show all calls between two selected crates.
Implementation: `web/src/crate-map.ts`.

The view is labelled by project language (`crateMapLabel` in `types.ts`):
**Crate Map** for Rust/Verus, **Namespace Map** for Lean, and **Chapter Map**
on the blueprint layer. The algorithm is the same in all three; only the
partition key differs.

## Input

The filtered graph $G = (V, E)$ from the query pipeline. The Crate Map is an
aggregated view, so the large-graph gate and the 200-node result limit don't
apply: with no query it aggregates the whole graph, and with a query or
filters it aggregates their result.

The partition key is `crate_name`, backfilled on every node at load time by
`extractCrateName` (`types.ts`) and chosen per node:

| Node | `crate_name` |
|------|--------------|
| Lean node (Lean project, or Lean node in a mixed graph) | first two segments of `relative_path`, e.g. `ArkLib/Data` |
| Blueprint entry | first two segments of its `code-path`, i.e. `blueprint/<chapter>` (the Chapter Map) |
| `scip:` or `probe:` ID | the segment after the prefix, up to the first `/` |
| otherwise | first segment of `relative_path`, else `unknown` |

## Phase 1. Aggregation (quotient graph)

`buildCrateGraph` partitions $V$ by crate, $V_c = \{v \mid \text{crate}(v) = c\}$,
and builds a node per crate with

- the function count $|V_c|$;
- the file count: distinct `relative_path` (or `file_name`) among members
  that have a file name;
- an external flag: whether the **first** member seen has `external:` in its
  ID.

For each ordered pair of distinct crates it keeps the cross-crate links and
their count:

$$
\text{calls}(c_i, c_j) = \{(u, v, t) \in E \mid u \in V_{c_i},\, v \in V_{c_j}\},
\qquad w(c_i, c_j) = |\text{calls}(c_i, c_j)|
$$

Intra-crate links are dropped; pairs with $w = 0$ get no edge. Each crate
edge keeps its `calls` list for the drill-downs. The result is the quotient
graph $G / \mathcal{C}$ with edge weights.

## Phase 2. Colour assignment

Crates are ranked by function count, descending, and crate $c$ at rank
$i$ uses hue $i \bmod 8$ of the shared group palette (`groupColors` in
`theme.ts`): 0.12 alpha fill, 0.50 alpha stroke, 0.85 alpha stroke when
selected.

## Mode A. Collapsed (default)

**Layout.** Each crate box is $w(c) \times 56$ with

$$
w(c) = \max\big(\text{nw}(\text{name}),\; \text{nw}(\text{"}|V_c|\text{ fn, }F\text{ files"})\big) + 30,
\qquad \text{nw}(s) = \max(100,\; 6.5\,|s| + 20)
$$

dagre lays out $G / \mathcal{C}$ with `rankdir: 'LR'`, `nodesep: 60`,
`ranksep: 120`, margins 50, and each edge's dagre `weight` set to its call
count, so heavy edges are kept shorter and straighter.

**Rendering.** Boxes show the name (12px, bold) and the stats line (10px).
Edges are grey Béziers with $c = 0.4$ (see
[README.md](README.md#shared-edge-geometry)), opacity 0.5, a "$w$ calls"
label above the midpoint, and width

$$
\text{strokeWidth}(c_i, c_j) = 1.5 + 4 \cdot \frac{w(c_i, c_j)}{\max_e w(e)} \in [1.5,\; 5.5]
$$

The SVG `viewBox` is fitted to the layout plus 100; manual zoom is limited to
$[0.05, 30]$.

**Selection.** Clicking crates fills two roles. A click on the current source
or target clears that role; otherwise it sets the source if empty, then the
target, and once both are set it replaces the target. The Source/Target crate
dropdowns in the sidebar set the same roles (`setBoundaryCrates`). The source
box gets a 3.5px `--pg-accent` stroke and a "SOURCE" tag, the target a 3.5px
`--pg-edge-precondition` stroke and a "TARGET" tag. With both set, the view
switches to Mode C.

**Other interactions.** Clicking a crate also fills the details panel with
its counts, the crates it calls into and is called by (by call count) and its
top 8 files. Hovering a crate dims unrelated crates, and all edges and edge
labels, to 0.25. Double-clicking a crate sets **Include Files** to the bare
`file_name` of every member and switches to the Call Graph; since the filter
matches by file name, same-named files in other crates match too.

## Mode B. Expanded edge

Clicking a crate edge $(c_s, c_t)$ expands it; clicking it again, pressing
Esc, or clicking the background returns to Mode A. If a later filter change
removes the edge, the view falls back to Mode A.

The function subgraph is $E_B = \text{calls}(c_s, c_t)$ and $V_B$ its
endpoints. dagre lays out a compound graph (`nodesep: 20`, `ranksep: 140`,
margins 50) with:

- clusters `crate:<c_s>` and `crate:<c_t>` holding the nodes of $V_B$, each
  function node $(\text{nw}(\text{name}) + 10) \times 36$;
- every other crate as a single $(\text{nw}(\text{name}) + 30) \times 44$ node;
- a zero-size proxy node inside each cluster. dagre crashes on edges attached
  to a compound parent ([dagre#236](https://github.com/dagrejs/dagre/issues/236)),
  so crate edges touching $c_s$ or $c_t$ attach to the proxy instead.

Crate edges involving the other crates only shape the layout, and the
reverse edge $(c_t, c_s)$ is left out; the only edges drawn are those of
$E_B$, as typed Béziers with $c = 0.35$. The two clusters are drawn with their palette fill and selected
stroke, other crates as faded (0.6 opacity) boxes, and function nodes as
white boxes with a grey border. Clicking a function opens its details.

## Mode C. Boundary

With source $c_s$ and target $c_t$ selected, the view collects both
directions,

$$
E_{\text{into}} = \text{calls}(c_t, c_s), \qquad E_{\text{from}} = \text{calls}(c_s, c_t)
$$

and lays out $E_{\text{into}} \cup E_{\text{from}}$ and their endpoints as a
compound graph with exactly two clusters (`nodesep: 20`, `ranksep: 160`,
margins 60) and no other crates. If both sets are empty it shows "No calls
between $c_s$ and $c_t$". Function edges use $c = 0.35$.

The source cluster has a `--pg-accent` border and the label
"$c_s$ (source — called)"; the target cluster has a `--pg-edge-precondition`
border and "$c_t$ (target — caller)". A summary line reads
"Boundary: $|E_{\text{into}}|$ calls from $c_t \to c_s$", followed by
", $|E_{\text{from}}|$ calls from $c_s \to c_t$" when that set is non-empty.
Esc or a background click clears both roles and returns to Mode A.

**View in Call Graph** sets an exact boundary intent
(`boundary-source=`$c_s$, `boundary-target=`$c_t$ in the URL) and switches to
the Call Graph. That query (`crateBoundary` in `query.ts`, exact crate names)
keeps the links whose caller is in $c_s$ and callee in $c_t$, i.e.
$E_{\text{from}}$, which is the opposite of the "called"/"caller" labels
([#60](https://github.com/Beneficial-AI-Foundation/probegraph/issues/60)).

## References

- Harary, *Graph Theory*, Addison-Wesley, 1969 — quotient graphs.
- Elmqvist & Fekete, "Hierarchical Aggregation for Information Visualization," *IEEE TVCG* 16(3), 2010 — aggregate overviews with drill-down.
- Sander, "Layout of Compound Directed Graphs," Universität des Saarlandes, 1996 — compound layout used in Modes B and C.
- Bederson & Hollan, "Pad++," *UIST* 1994 — semantic zoom.
