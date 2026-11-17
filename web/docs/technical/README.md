# View Algorithms

Specifications of the five views: what each computes from the query result
and the constants it uses. User-facing behaviour is in the
[viewer guide](../../../docs/guides/viewer.md); system context is in
[`ARCHITECTURE.md`](../../ARCHITECTURE.md).

| Document | View | Core technique |
|----------|------|----------------|
| [CALL_GRAPH_ALGORITHM.md](CALL_GRAPH_ALGORITHM.md) | Call Graph | Longest-path layering and barycenter ordering as the initial layout, refined by a constrained D3 force simulation; auto-fit camera |
| [FILE_MAP_ALGORITHM.md](FILE_MAP_ALGORITHM.md) | File Map | Transitive reduction, dagre compound layout grouped by file, border/fill encoding of derived readiness |
| [CRATE_MAP_ALGORITHM.md](CRATE_MAP_ALGORITHM.md) | Crate Map (Lean: Namespace Map; blueprint layer: Chapter Map) | Quotient graph by crate with three modes: collapsed, expanded edge, crate boundary |
| [hierarchy-algorithm.md](hierarchy-algorithm.md) | Hierarchy | Cut through the crate → directory → file → function tree, edges aggregated between cut members, dagre compound layout |
| [packed-map-algorithm.md](packed-map-algorithm.md) | Packed Map | Circle packing (`d3.pack`) of the same tree over `exec` functions, sized by connectivity; zoomable camera, edges of one function |

## Comparison

| | Call Graph | File Map | Crate Map | Hierarchy | Packed Map |
|---|---|---|---|---|---|
| Layout | layered start + d3-force, keeps moving | dagre, static | dagre, static | dagre compound, static | d3.pack, static |
| Unit drawn | function circle, radius by degree | function, shape by kind | crate box; functions on drill-down | cut member: group box or function | every `exec` function, area by 1 + distinct neighbors |
| Grouping | none | file | crate | nested expanded groups | all groups, nested circles |
| Edges | every link | transitive reduction | aggregated, width by count | aggregated, width by count | hovered or selected function only |
| Colour | node status | border = readiness, fill = completeness | crate palette | crate palette; function border = status | function fill = status; group arc = verified share |
| Camera | auto-fit when the node set changes | viewBox fitted to layout | viewBox fitted to layout | viewBox fitted to layout | d3.zoom; click fits a group, `?packed=` |
| Large-graph limits | apply | apply | exempt | exempt | exempt |

## Shared edge geometry

Every view except the Packed Map draws an edge from $P_0$ to $P_3$ as a cubic Bézier with
horizontal control points, $\delta = x_3 - x_0$:

$$
P_1 = (x_0 + c\,\delta,\; y_0), \qquad P_2 = (x_3 - c\,\delta,\; y_3)
$$

with $c = 0.4$, except $c = 0.35$ for function edges in the Crate Map's
expanded and boundary modes. The Call Graph connects node centres; the dagre
views connect the source's right side to the target's left side. A single
typed link is coloured with its `--pg-edge-<type>` token (`web/style.css`,
`web/src/theme.ts`) and dashed `precondition`/`postcondition` 5,3 in the Call
Graph and 6,3 elsewhere, `mapping` 2,4, `spec` 3,3; `inner` links and
aggregated edges are solid neutral grey.

The Packed Map draws a quadratic Bézier between two circle centers, bent to
one side and cut at the circle boundaries. See
[packed-map-algorithm.md](packed-map-algorithm.md#edges).

Implementation: `web/src/graph.ts`, `file-map.ts`, `crate-map.ts`,
`hierarchy.ts`, `hierarchy-map.ts`, `packed-map.ts`; derived statuses in `status.ts`, colour
tokens in `theme.ts`.
