# Hierarchy Algorithm

The Hierarchy view organizes the query result into a crate → directory → file
→ function tree and draws a *cut* through it: collapsed groups appear as boxes
with rollup stats, expanded groups as containers holding their children.
Expanding or collapsing a group moves the cut locally; the rest of the graph
stays on screen as aggregates. Implementation: `web/src/hierarchy.ts` (tree
and cut) and `web/src/hierarchy-map.ts` (layout and rendering).

## Input

The filtered graph $G = (V, E)$ from the query pipeline, so every filter and
query composes with the view. Like the Crate Map it is an aggregated view:
the large-graph gate and the 200-node result limit don't apply. Grouping uses
`crate_name` (see [CRATE_MAP_ALGORITHM.md](CRATE_MAP_ALGORITHM.md#input)) and
`relative_path` (else `file_name`).

## Step 1. Tree

`buildHierarchyTree` rebuilds the tree on every update:

1. The top level is one group per `crate_name`.
2. The path is split on `/`. If it starts with the crate name's own segments
   (Rust workspaces, Lean two-segment names, `blueprint/<chapter>`), that
   prefix is stripped so the crate is not repeated as directories. The last
   remaining segment is the file group, the others are directory groups.
   With no segments left, the function attaches directly to the crate group.
3. Group ids are the crate name plus the uncompressed path segments,
   `/`-joined.
4. A directory with no functions of its own and exactly one child directory is
   merged into that child, repeatedly. The label joins the names
   (`src/backend`) and the group keeps the **deepest** id, so URLs stay valid
   when the chain changes.
5. Rollups over each subtree: function count, file count, and verified count,
   where a function counts as verified if its status is verified,
   transitively-verified or trusted. Siblings are sorted by label.

## Step 2. Cut

The expanded set $X$ comes from `?expanded=` or user clicks. Ids that no
longer exist in the tree (stale URL state) are dropped (`pruneExpanded`).
`computeCut` then walks from the roots:

- a group in $X$ that has children or functions becomes a **container**; its
  own functions become function members and its children are visited;
- any other group becomes a single **group member** standing for its whole
  subtree.

Only children of expanded groups are visited, so an id in $X$ whose ancestor
is collapsed has no effect. Every function is therefore assigned to exactly
one member: itself if its group is expanded, otherwise its nearest collapsed
ancestor.

**Edge aggregation.** Each link $(u, v, t)$ maps to the members $(m(u), m(v))$
it is assigned to; links inside one member are dropped. Links with the same
member pair form one cut edge carrying the call count and the underlying
calls.

## Step 3. Layout

dagre lays out a compound graph with `rankdir: 'LR'`, `nodesep: 24`,
`ranksep: 100`, margins 50. Containers are compound nodes nested under their
own expanded parent; members are leaves inside their nearest container. Edges
only connect leaves (group boxes and function boxes), never containers, so
unlike the Crate Map no proxy nodes are needed.

With $\text{tw}(s) = \max(100,\; 6.5\,|s| + 20)$, group boxes are
$(\max(\text{tw}(\text{label}), \text{tw}(\text{stats})) + 30) \times 56$ and
function boxes $\text{tw}(\text{name}) \times 28$, each given to dagre 8px
taller. The SVG `viewBox` is fitted to the layout plus 100.

## Step 4. Visual encoding

- **Colour**: crates are ranked by function count, descending, and each
  group or container takes its root crate's hue from the shared group palette
  (0.12 alpha fill, 0.50 alpha stroke).
- **Group box**: label, stats line ("$n$ fn, $f$ files", files omitted for a
  file group) and a verified-fraction bar, verified count over function
  count, in `--pg-status-verified`.
- **Container**: labelled "label — verified/total ✓".
- **Function box**: white with a border in `--pg-status-verified` for any
  verified-like status, `--pg-status-failed`, `--pg-status-unverified`, or
  `--pg-status-unknown` when there is no status.
- **Edges**: right-to-left-side Béziers with $c = 0.4$ (see
  [README.md](README.md#shared-edge-geometry)). A cut edge carrying a single
  call keeps that call's typed colour and dashes; an aggregate is grey with a
  "$n$ calls" label. Width is $1.5 + 3.5 \cdot n / n_{\max}$ for all edges.

## Expansion state

Clicking a group box expands it; clicking a container's border collapses it
and every group below it; Esc collapses everything. Each change is written to
`?expanded=` as a comma-separated id list (only while the Hierarchy view is
active) and restored from it on load. The user-facing description is in the
[viewer guide](../../../docs/guides/viewer.md#views).

Reference: Elmqvist & Fekete, "Hierarchical Aggregation for Information
Visualization," *IEEE TVCG* 16(3), 2010 — cuts through an aggregation tree.
