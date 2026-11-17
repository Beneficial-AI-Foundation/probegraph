# Viewer: Packed Map

Status (2026-11-16): Phase 1 in progress on branch `web/packed-map`.
The open questions are answered, see "Decisions". Revised the same day
after a Codex review.

Phase 1 measurement (2026-11-16): on `graph_libsignaL_8_01.json` (9,737
nodes, 5,454 drawn after the default filters, 648 groups), the load and
first draw took 210 ms. A click selection took about 7 ms without a new
layout, and a wheel zoom step about 5 ms. The view is therefore in
`isAggregatedView`, and Phase 3 is not needed for graphs of this size.
The normal path would cut the view to 200 nodes (`MAX_RENDERED_NODES`).
The measured graph has fewer than the 10,000 functions that "Size of the
graph" asks for. Measure again when a larger probe-verus graph exists.

Goal: add a bird's-eye view of a whole project, named "Packed Map".
Each crate, directory and file is a circle. Its children are packed inside it, and the smallest
circles are functions. The idea comes from the project pages of &Atlas
(https://atlas.andtruth.com). &Atlas is not open source: its code is a
custom 2D canvas renderer with no published license. We build the view
ourselves with d3.

## What exists

- `src/hierarchy.ts`: `buildHierarchyTree` builds the crate, directory,
  file and function tree. It also compresses single-child directory
  chains and keeps rollups per group (`fnCount`, `fileCount`,
  `verifiedCount`). The Packed Map reuses this tree unchanged.
- `d3.pack` (circle packing: nested circles sized by a value) ships with
  d3 7, which the viewer already uses. No new dependency.
- `src/hierarchy-map.ts` shows how a view class plugs into `main.ts`:
  `update`, `destroy`, `resize`, `clear`, a legend, and a
  `hierarchy-expanded-changed` event for URL state.
- The Call Graph sizes nodes by degree (`src/graph.ts:532`, square root of
  callers plus callees, clamped to 5 to 15 px).
- `statusColor` in `src/theme.ts` gives the verification colors.

## Design

Scope. The view draws only Rust code: `exec` atoms. The kind filters
already use this rule (`renderKindFilters` in `src/main.ts`): if
`(node.kind || 'exec') === 'exec'`, the node is `exec`. Older graphs such as
`graph_fixed.json` have no `kind` field, so this rule keeps their nodes.
One exported helper, `isPackedMapNode`, holds the rule. The button and
the filter step both call it. If the loaded graph has no `exec` node (a
pure Lean graph, or the blueprint layer), the button is hidden. If the
active view is Packed Map and the user loads such a graph, the viewer
switches to the Call Graph.

Where the rule applies. Apply it in the filter step, not in the
renderer. When the active view is Packed Map, `applyFiltersAndUpdate`
drops the nodes that are not `exec`, and the links that touch them. The
stats, the node details and the reveal logic then count the same nodes
that the view draws. If the filters leave no node (for example, Exec
unchecked), the view shows "No Rust functions match the filters". The
button stays.

Layout. Turn the `HierarchyTree` into a `d3.hierarchy`. Every group
gives its child groups and its own `nodeIds` as children, because
`buildHierarchyTree` attaches functions with no path directly to the
crate. One synthetic root, not drawn, holds the crates. Pack ids get a
prefix (`g:` for groups, `f:` for functions), so a group id and a
function id cannot collide. Only leaves have a value. Groups get their
value from `hierarchy.sum`, never from the `fnCount` rollups. Run
`d3.pack` with a small padding.

Size. The value of a function is 1 plus its number of distinct
neighbors among the links of the filtered graph. A function that is both
caller and callee of another counts it once. Self-calls do not count.
The count comes from the filtered links, not from the `dependencies` and
`dependents` arrays, so it agrees with the edge filters. In `d3.pack`
the area of a leaf follows its value. A group circle encloses its
children, so its size grows with the summed connectivity of its
functions, not exactly in proportion. The legend says "size: summed
connectivity of the functions inside".

Color. A function circle is filled with `statusColor` of its
`verification_status`. A group circle has a neutral fill that darkens a
little per depth level. Its outline shows the verified fraction as an
arc. The fraction counts `trusted` as verified, like the Hierarchy bar
(`isVerifiedStatus`), and covers the functions on screen. The legend says
so.

Camera. One `d3.zoom` transform is the only camera. A click on a group
animates that transform to fit the group (`zoom.transform` in a
transition). Wheel and drag change the same transform, so no jump
happens after a click zoom. A new click, a filter change, a resize or
`destroy` interrupts a running transition. Esc and a background click
zoom out to the parent of the focused group.

URL. The focused group is kept in `?packed=<group id>`, written with
`replaceState`, so Back does not step through zooms. Free pan and zoom
are not kept. A load or a filter change can remove the group, for
example when directory compression changes its id. If the group is gone,
the view shows the whole project. The view name uses the same parse and write paths as
the other views. These are `readURLState`, `writeURLState`, and the view
switch at load in `src/main.ts`.

Labels. Group labels only at first: if a group circle is larger than
about 60 px on screen, it gets its label. If a group shows a label, its
parent label is hidden, so labels do not stack. If a function circle
is larger than about 40 px, it gets its label. A long name is cut
to fit its circle and ends with an ellipsis. Labels update on every zoom event.

Edges. Draw no edges by default. For the hovered function, or else the
selected one, draw its calls to other drawn functions as curves with the
edge type colors. The edge layer does not take pointer events. A call to
a function outside the view is clipped at the view edge. The node
details list every caller and callee, so the view has no special stubs.

Selection. A click on a function selects it and opens its details. A
selection change redraws only the highlight and the edges. It does not
rebuild the tree or run `d3.pack` again. The layout is cached. If
`filteredGraph` changes, the layout is built again.

Open in the Call Graph. A double-click on a function, or Shift+Enter on
the function in the focus ring, opens it in the Call Graph. It calls
`revealNode` with the `replace` policy, the same as a row of the search
box: a query that reaches the function stays, and otherwise the query
becomes the function with its callers and callees. With no query, the
render cap can leave the function out of the Call Graph. The search box
then offers its query in a toast, but the double-click sets it at once
(`always` on the policy), because the capped overview is no query to
keep. Back returns to the Packed Map. The double-click on a function does not zoom. Phase 2 can
give the double-click on a group circle a meaning of its own.

Size of the graph. The view draws one circle per function, so it is not
an aggregated view like Hierarchy. Phase 1 keeps the large-graph guards.
Phase 1 also measures the first draw and a zoom on a current probe-verus
graph with more than 10,000 functions. If both are fast enough, add the
view to `isAggregatedView`. If not, Phase 3 comes first.

## Phases

### Phase 1: static view

1. Add `'packed-map'` to `ActiveView`, a "Packed Map (testing)" button,
   the URL parse and write paths, and a branch in `createVisualization`.
2. `isPackedMapNode` and the `exec` step in `applyFiltersAndUpdate`.
3. New `src/packed-map.ts`: `buildPackData` (tree to pack data, with
   values) as a pure function, and a `PackedMapVisualization` class that
   draws SVG circles with status colors.
4. Click a function for details, wheel and drag zoom, the empty state.
5. Unit tests for `buildPackData`: values, distinct neighbors, self-calls,
   functions with no path under a crate, empty input, legacy nodes with
   no `kind`.
6. The measurement described in "Size of the graph".
7. `docs/guides/viewer.md`: an entry under Views, and the legend captions.

### Phase 2: navigation

1. Click zoom on the shared camera, Esc and background click, `?packed=`
   with the fallback for a missing group.
2. Labels as described above.
3. Edges of the hovered or selected function.
4. Playwright tests:
   - switch to the view and select a function,
   - click zoom then wheel zoom, with no jump,
   - reload with `?packed=`, and a stale `?packed=` id,
   - Exec unchecked gives the empty state,
   - a graph with no `exec` function hides the button and falls back to
     the Call Graph, on load and on Back.

### Phase 3: speed (only if Phase 1 measures it slow)

Draw the function circles on a canvas under the SVG. Keep SVG for group
circles, labels and edges. Hit tests use the pack coordinates
(`d3.quadtree`).

### Later: lines of code

A switch to size functions by source lines. Only probe atoms give real
spans: `code-text` has `lines-start` and `lines-end` for the whole
function (1,775 of 1,775 valid in `atoms.json`). Graphs exported from
SCIP do not. A SCIP definition range covers only the name of the
function, so `export_d3.rs` writes `start_line == end_line`
(9,737 of 9,737 in `graph_libsignaL_8_01.json`). The old local file
`graph_fixed.json` is worse: an older exporter wrote the end column of
the name as `end_line`, so 8,197 of its 8,378 ranges are reversed. The
switch is therefore useful only on probe graphs. If more than half of
the drawn functions have a span of one line or less, the switch is
hidden.

## Decisions

Answered by the user on 2026-11-16:

- The default size is connectivity. Lines of code moves to "Later",
  because only probe graphs have usable line ranges.
- The button and the view are named "Packed Map".
- The view shows Rust code (`exec` atoms) only. Proofs, specs and
  theorems get no shape or ring, because they are not drawn.
- Hierarchy stays. If the Packed Map makes it redundant, remove it in a
  later change.
