# Viewer: Packed Map

Status (2026-11-16): Phase 1 in progress on branch `web/packed-map`
(#128, PR #129). Phase 2 in progress on a branch stacked on it (#130).
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
becomes the function with its callers and callees. The new query keeps
the depth the user set, although the seeded view of a large graph can
draw a lower one. The render cap can leave the function out of the Call
Graph. The search box then offers the function's query in a toast. The
double-click sets it at once (`always` on the policy) when there is no
query and no clicked Call Graph node (`selectedNodes`), because the
capped overview is no query to keep. Back returns to the Packed Map.
The map has no double-click zoom, so a double-click on a group circle
acts as two clicks.

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

Notes from the implementation (#130):

- A click zooms to the clicked group, as the Design says, not one level
  below the focused group. A click deep inside a crate can therefore skip
  levels. Esc still goes up one level at a time.
- Keyboard zoom: the map stays one tab stop (a listbox of functions), so
  group circles do not take the keyboard focus. Plus zooms in one level
  toward the function in the ring (`zoomInTarget`), and Minus or Esc
  zooms out one level. A hidden live region says which group is zoomed.
- Edges and labels are drawn in screen coordinates and redrawn on every
  zoom event, so their stroke, arrowheads and font keep one size. Edges
  have an arrowhead at the callee, because color alone does not show the
  direction.
  Each curve starts and ends on the circle boundaries. Calls of several
  types between the same two functions get growing bends, so each type
  stays visible.
- The legend lists three edge colors: body, requires and ensures calls.
  Mapping links go to Lean and spec links start at a theorem, so neither
  joins two drawn functions. Any other type is drawn gray, like a body
  call.
- On a new layout (a filter change), the camera goes back to the focused
  group, or to the whole project if there is none.
  If the filters leave no function, the focused group is dropped from
  the URL, so turning Exec back on shows the whole project. After Back to
  a stale `?packed=`, the address bar is fixed with replaceState.

### Phase 3: speed (only if Phase 1 measures it slow)

Draw the function circles on a canvas under the SVG. Keep SVG for group
circles, labels and edges. Hit tests use the pack coordinates
(`d3.quadtree`).

### Phase 4: pure Lean projects

Status (2026-11-17): proposed, not started. Revised the same day after
two Codex review rounds.

Goal: show the Packed Map for a pure Lean graph as an inventory: every
eligible declaration gets a circle, also one with no links. Today the
button is hidden there, because a Lean graph has no `exec` node.

Test data. `SparsePostQuantumRatchet-verify/.verilib/probes/lean_extract.json`
(probe-lean 0.19.0, Oct 20) has 2,830 declarations in 286 files. The
file stays outside the repo (7.7 MB). It has no `sorry`, so it cannot
test the status rules. Unit tests use a new small synthetic fixture
(Changes, item 6). `probe-lean-extract-cut.json` has no theorems, no
axioms and no `sorry`, so it is not enough.

Grouping. `buildHierarchyTree` groups by `crate_name`. For Lean,
`extractCrateName` takes the first two segments of the file path, not
the Lean namespace. A file two levels deep is therefore a top-level
circle of its own, and its declarations sit directly inside it, with no
file circle. In spqr the top-level circles are `SrcTranslated/Funs.lean`
(847 drawn declarations), `Spqr/Specs` (737),
`SrcTranslated/FunsExternal.lean` (174), `Spqr/Math` (138),
`SrcTranslated/Types.lean` (53) and five smaller ones. Phase 4 keeps
this grouping, and the viewer guide describes it.

Which nodes can be drawn. One helper, `isPackedMapCandidate(node,
language)`, holds the rule. It does not look at the filters:

- `verus`, `unknown` and `mixed`: `exec` only, as today. A mixed graph
  keeps its Lean side out of the view (see "Later: mixed projects").
- `lean`: every declaration without `is_hidden`. A hidden declaration
  with the status `unverified` (it contains a `sorry`) is a candidate
  too, so a `sorry` is never hidden.
- `blueprint`: none, so the button stays hidden on the blueprint layer.

The button and the Back fallback use the same test: the graph has at
least one candidate. The filters do not change the test. A Lean graph
with only structures is an example. With the Types filter off, no
candidate is left. In that case the view shows the empty state, and the
button stays.

In spqr all 659 hidden nodes are generated (389 Aeneas theorems, 244
projections, 26 instances), and none of them reaches a `sorry`.

Where the rule applies. In the filter step. The order depends on the
query:

- Without a query, the Declaration Kind filters apply first, then
  `isPackedMapCandidate` removes the other nodes and their links. The
  cleanup removes isolated nodes (`removeIsolated` in `src/query.ts`).
  It does not run for the Packed Map here. Every remaining node is
  drawn, also one with no links. This makes the map an
  inventory.
- With a query, the order stays as today: first the cleanup, then the
  restriction. If the restriction comes first, a text query can lose a
  match. An example is an `exec` function whose only link goes to a
  proof: the restriction removes the link, and the cleanup then removes
  the function. Text matches are not anchors (`anchorIds` in
  `src/intent.ts` keeps only exact ids), so nothing protects them.

This also changes the Rust Packed Map. Today it loses the `exec`
functions that have no links after the filters. After Phase 4 it draws
them. This is a fix: the map is meant to show the whole project.

Color. probe-lean sets the status in `taintVerdict` (probe-lean
`Transitive.lean`). A declaration that contains a `sorry` is
`unverified`. A declaration that reaches a `sorry` is `verified`. A
member of the trust set is `trusted`, unless its statement reaches a
`sorry`. All other declarations are `transitively-verified`. The fill
of a function circle shows these values, as today.

The group arc must not count a Lean `verified` declaration as done,
because it can rest on a `sorry`. Today the arc uses `isVerifiedStatus`,
which counts `verified`. For a Lean graph the arc counts only
`transitively-verified` and `trusted`. For Verus the arc stays as it
is. The legend says which statuses the arc counts, and that in Lean
`verified` means "not known to be free of `sorry`". This wording covers
two cases. With enrichment, `verified` means the declaration reaches a
`sorry`, and probe-lean adds `"status-origin": "kernel-taint"`. With
`--skip-enrich`, `applyTaintStatus` writes `verified` also for a clean
declaration (`upgrade := false` in probe-lean `Extract.lean`). The
loader drops `status-origin` today, so the viewer cannot tell the two
cases apart. To keep it is a later change. The spqr graph has 2,699
`transitively-verified` and 131 `trusted` declarations, so its map is
mostly one color, and the trusted declarations stand out.

Size. The size is the number of distinct neighbors over the links that
are left after the filters, as for Rust. For Lean these are dependency
links: statement dependencies, body or proof dependencies, or both. The
loader marks a dependency of both kinds as `both`. The legend says
"size: dependency links after the filters". The numbers come from the
loaded and filtered graph, not from the raw JSON file. Codex measured
6,790 links, a median of 4 and a maximum of 205 on spqr.

Text. The legend and the aria label are built once, in the constructor,
and a new graph only calls `clear()`. If the language changes while the
view is open, the view must build the legend and the aria label again,
as the File Map does. For Lean, the text says "declarations" and
"Lean declarations without hidden ones, as the Declaration Kind filters
show". The edge legend shows one entry, "Dependency".

Changes:

1. `isPackedMapCandidate(node, language)` replaces `isPackedMapNode`.
   `hasPackedMapNodes` and `restrictToPackedNodes` take the language.
2. The restriction moves into the filter step, in the order given in
   "Where the rule applies". A filter option skips the cleanup for the
   Packed Map without a query. The current call in
   `applyFiltersAndUpdate` goes away.
3. A Lean arc that counts only `transitively-verified` and `trusted`.
4. If the language changes, the view updates the legend, the aria
   label, the empty state, the tooltips and the live region.
5. The edge legend for Lean.
6. A synthetic Lean fixture. It has a hidden theorem, a hidden theorem
   that contains a `sorry`, and a visible theorem that reaches it. It
   also has a trusted definition and a trust-set member whose
   statement reaches a `sorry`, so it is not `trusted`. It has a clean
   `verified` theorem as `--skip-enrich` writes it. It has an axiom, a
   structure and an isolated definition. Its files are two levels deep and deeper. A
   Rust case has an `exec` function whose only link goes to a proof,
   found by a text query.
7. Unit tests on the fixture. They name the exact nodes that are drawn
   with the default filters, with Definitions off, with Theorems off,
   and with Types on. They test the arc counts, the grouping of both
   file depths, and that the Verus rule is unchanged except for
   isolated `exec` functions.
8. Playwright: a Lean graph shows the button and draws the expected
   circles. A Lean graph with only structures shows the button and the
   empty state. Verus, then Lean, then Verus with the view open gives
   the right legend each time. Reload and Back keep the view. The
   blueprint layer hides the button.
9. Measure on spqr: first draw, a click selection, a wheel zoom step, a
   filter change and a resize. Write down the browser and the machine.
   The limits are 1 s for the first draw and 50 ms for a selection, a
   zoom step or a resize. If a step goes over its limit, Phase 3
   (canvas) comes next.
10. `docs/guides/viewer.md`: what a Lean graph shows, the grouping by
    file path, the arc rule, and the legend captions.

### Later: mixed projects

A mixed graph can get one top-level circle per language, like the
Rust world and Lean world boxes in the File Map (#142). This is not
part of Phase 4.

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
  theorems get no shape or ring, because they are not drawn. On
  2026-11-17 the user asked for pure Lean projects too, see Phase 4.
- Hierarchy stays. If the Packed Map makes it redundant, remove it in a
  later change.

Answered by the user on 2026-11-17:

- The Lean view draws theorems by default, through the Theorem filter.
  Codex counted 810 theorems in the 1,959 nodes that the filters leave
  in spqr today. In Lean a `sorry` sits almost always in a theorem, so
  the theorems carry the verification status. The user can turn them
  off with the Theorem filter.
- On an Aeneas project, the plain grouping is enough for Phase 4. Each
  `SrcTranslated` file, such as `SrcTranslated/Funs.lean`, holds
  translated Rust code. `Spqr/Specs` holds the proofs. These are
  already separate top-level circles with their own labels (see
  "Grouping" in Phase 4). A different look per side belongs to "Later: mixed
  projects".
