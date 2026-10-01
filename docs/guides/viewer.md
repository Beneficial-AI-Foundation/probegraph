# Web viewer guide

The web viewer is an interactive D3 visualization for probe graphs: Rust/Verus
call graphs (from SCIP), Lean atom graphs (from probe-lean), and merged
cross-language graphs with Rust↔Lean mapping links.

- Live demo: https://beneficial-ai-foundation.github.io/probegraph/
- Local: `cd web && npm install && npm run dev`, then open
  http://localhost:3000/probegraph/

## Loading a graph

The viewer tries these sources in order:

1. `?json=<url>` (alias `?url=`) — fetch a graph from a URL.
2. `VITE_GRAPH_JSON_URL` — build-time default URL (used by the Pages deploy).
3. `./graph.json` — the file in `web/public/`, auto-loaded on startup. The
   committed one is the demo graph shown on GitHub Pages.
4. The **Load Graph JSON** button — pick a local file.

Fetched files larger than 10 MiB are not parsed immediately (a `HEAD`
request checks the size first): the viewer shows a "Large Graph Detected"
prompt and loads only when you set a Source, Sink, or Include Files filter
and press **Load & Search**. The exception is the local `./graph.json` when
`?view=` is `crate-map` or `hierarchy`: it loads anyway, since those views
aggregate the graph. This gate is about `JSON.parse` freezing the browser;
rendering is bounded separately by the seeded view (below).

The viewer accepts probe atom dicts, schema envelopes and its own D3 format;
see [web/ARCHITECTURE.md](../../web/ARCHITECTURE.md#input-formats).

## Views

- **Call Graph** — force-directed layout with callers on the left and callees
  on the right (topological bias).
- **File Map** — nodes grouped by file, laid out with dagre after transitive
  reduction. Shapes encode kind (rounded rectangle = definition/exec,
  ellipse = theorem/proof, diamond = spec/axiom); the border color encodes the
  node's own verification readiness and the fill encodes subtree completeness.
- **Crate Map** — one node per crate, edges weighted by call count. For Lean
  graphs the button is relabeled **Namespace Map** and grouping uses the first
  two path segments (e.g. `ArkLib/Data`); on the blueprint layer it is the
  **Chapter Map**. Click one crate then another to show
  the calls between them inside the Crate Map; its **View in Call Graph**
  button then sets a boundary query, which keeps the calls whose caller is in
  the source crate (the UI labels say the opposite, see
  [#60](https://github.com/Beneficial-AI-Foundation/probegraph/issues/60)).
  Double-click a crate to open its files in the Call Graph.
- **Hierarchy (testing)** — one box per crate to start. Click a collapsed
  group to expand it in place (crate → directory → file → function), click
  an expanded group's background to collapse it, and press Esc to collapse
  everything. Click a function for its details. Group boxes show rollup
  counts and a verified-fraction bar, and edges are aggregated between the
  visible boxes. The expanded groups are kept in `?expanded=`.

Crate Map and Hierarchy aggregate the whole graph, so the large-graph limits
below don't apply to them. The algorithms are specified in
[web/docs/technical/](../../web/docs/technical/README.md).

Below the filters, **Reset Filters** restores the defaults, **Clear
Selection** drops clicked nodes, and **Copy Link** copies a shareable URL
(see Sharing). **Reset View** works in the Call Graph only: it fits the graph
to the window, or, when the graph can't fit at the minimum zoom, centres on
the selected node or the query's node. The Call Graph does this on its own
whenever the set of rendered nodes changes.

## Blueprint and Code layers

A probe-leanblueprint extract holds two graphs: the blueprint entries
(`language: "blueprint"` atoms, one per theorem or definition in the
blueprint) and the Lean declarations. The viewer shows one at a time, with a
**Blueprint** / **Code** switch in the header. The switch appears only when
the graph has blueprint entries, and the viewer then opens on Blueprint.

- Blueprint edges are the entries' statement and proof uses, so the
  Statement / Body-or-proof boxes (see Edge Types) apply to both layers and
  carry over when you switch.
- Each layer keeps its own query and filters. Kind and language filters of
  the code layer don't apply to blueprint entries.
- On the blueprint layer, entries with no edges (planned-only or with a
  missing declaration) are always shown, and the Crate Map is the
  **Chapter Map**, grouped by blueprint chapter.
- An entry's bound Lean declarations are not edges; they are listed in node
  details and reached by double-click (see Node details).
- Browser back undoes a layer switch.

## Large graphs and the seeded view

Graphs over 2 000 nodes or 10 000 links don't render whole. In the Call Graph
view the viewer instead seeds an initial view from the best available tier:

1. blueprint atoms named by a `?entrypoints=` payload,
2. entry points (`is_entry_point`: public-API Rust/Verus atoms, their Lean
   translation targets, and `@[blueprint]`-attributed Lean atoms),
3. nodes with no callers,
4. failing that, definition-kind nodes with no callers.

Seeds are expanded to the deepest depth that fits the render budget and a
banner reports "Showing N of M nodes (entry points, depth d)". The Depth
slider re-expands from the seeds. `?focus=` takes precedence over
`?entrypoints=`; clearing the focus set resumes the entrypoints seeding.

Only the Call Graph seeds. The File Map on a large graph with no query shows
a "use filters" message instead, and Crate Map and Hierarchy render the whole
graph. Filtered results in the Call Graph and File Map are truncated to 200
rendered nodes; the seeded view is not.

## Sidebar filters

**Source → Sink** is the main query. Source alone shows what a function calls,
sink alone shows who calls it, both together show the paths between them.
Matching rules:

- plain text is a case-insensitive substring match on the display name
  (`decompress` matches `decompress_step_1`);
- `*` and `?` make an anchored glob (`p_*` matches names starting with `p_`);
- `path::name` matches the file name (without extension) or parent folder
  against `path`, then the function name (`edwards::decompress`);
- queries containing `.` also match against full node IDs, so Lean dotted
  names like `Scalar52.add_spec` resolve;
- `crate:name` matches by crate.

**Depth** limits hops from the source/sink; 0 means unlimited.

**Declaration Kind** adapts to the graph's language. Verus graphs get
Exec / Proof / Spec, with Spec **off by default**. Lean graphs get
Definitions / Theorems, plus checkboxes that appear only when the graph
contains them: Axioms (on by default — they are the trusted base),
Types (`structure`/`inductive`/`class`), Projections, and Instances (all off
by default). Mixed graphs additionally get the Verus Spec toggle.

**Edge Types** adapts to the graph. Verus and mixed graphs always get Body
Calls (on) and Requires and Ensures clause edges (off), whether or not the
graph has edges of each kind.
Lean graphs from probe-lean with the type/term split get **Statement deps**
(dependencies used in a declaration's type) and **Body/proof deps**
(used in its definition body or proof), both on; on the blueprint layer
they are the entries' statement and proof uses. These two boxes restrict
traversal, not only display: with Body/proof off, a query does not reach a
node through a body/proof edge. An edge in both roles shows while either box
is on. Mapping (cross-language Rust↔Lean) and Specifications (Lean def →
spec theorem) edges, both on, appear only when the graph has them. Mapping
edges follow only their own box; Specifications edges that carry a role also
follow the role boxes. Graphs with none of these hide the section.

**Verification Status** has three toggles: verified-like (verified,
transitively verified, trusted), failed, and unverified/unknown. A Guide
suggestion can select an exact status (e.g. transitively verified only); the
Verified box then shows as partly checked.

**Language** appears only for mixed graphs: show/hide Rust (or Verus) and
Lean nodes. The filter applies after traversal, so paths crossing the hidden
language still resolve.

**Source Type** (Libsignal / External) filters on the `is_libsignal` flag and
appears only when a graph mixes both values. Probe atom output never sets the
flag, so in practice it shows only for older D3-format graphs
([#61](https://github.com/Beneficial-AI-Foundation/probegraph/issues/61)).

**Exclude by Name** and **Exclude by Path** take comma-separated globs
(`*_comm*`, `*/specs/*`). Exclude by Path is matched against the node ID, not
the file path, so its presets only work where IDs contain the path; probe and
Lean IDs don't
([#61](https://github.com/Beneficial-AI-Foundation/probegraph/issues/61)).
**Include Files**
restricts to matching files (`edwards.rs`, `decompress*.rs`), with a
disambiguation dropdown when a bare filename is ambiguous; when combined with
a source/sink query it filters the results after traversal instead of blocking
paths. **Shift+click** hides a node; hidden nodes are listed in the sidebar
and restorable.

## Verification colors

In the Call Graph, node colour is the verification status: green for
verified, dark green for transitively verified, purple for trusted, red for
failed, grey for unverified, and blue for unknown (no status in the graph).
The sidebar's Verification Legend shows them, and the File Map, Crate Map
and Hierarchy draw their own legends. The exact colours are the
`--pg-status-*` tokens in `web/style.css`.

## Clicking nodes

- **Click** a node to show it in node details. The click also adds it to a
  selection: with no query, no Include Files and a finite Depth, the graph narrows
  to the selected nodes and their neighbours up to that depth. Click again
  to remove it.
- **Shift+click** hides a node.
- **Double-click** a blueprint entry to open its bound Lean declarations on
  the code layer, with their immediate neighbours (depth 1). A toast gives
  the number of declarations; an entry with none shows "no bound
  declarations" and stays on the blueprint layer. Browser back returns to
  the blueprint layer. Double-clicking any other node zooms in, like
  double-clicking the background.

## Node details

Click a node (or hover) to see its kind, verification status, location,
callers and callees (clickable), and similar lemmas with scores when the graph
was enriched with them. If a source link can be built, the panel shows
**View on GitHub** (or **Open in Editor** inside VS Code).

A blueprint entry shows its title, chapter and group, statement and proof
status (marked "declared" when the blueprint asserts them rather than
deriving them from the code, since those can overclaim), node class, status
mismatch, statement text (as plain text), a GitHub issue link when the
source repository is on GitHub, and its bound, missing and upstream
declarations. Its callers and callees are labeled Used by and Uses.

Cross-layer links in the panel:

- each bound declaration of a blueprint entry links to that declaration on
  the code layer;
- a Lean declaration that belongs to the blueprint links back to every entry
  that binds it or whose label its `blueprint-label` names. Under label
  collisions these can differ, so a listed entry may own the label without
  binding the declaration.

Following a link or double-clicking opens the target with its immediate
neighbours, turns its Declaration Kind box back on if it was off, and unhides
it if it was Shift+click hidden. Other filters (exclude patterns, status or
source boxes) can still leave it out; a toast then names the targets not shown.
Each is one browser-history step.

### GitHub source links

Links are built per node from `relative_path` plus line numbers. The
configuration is resolved in this order:

1. per-language `source_configs` derived from a merged envelope's `inputs`
   (repo, ref, and path prefix per input);
2. a global base URL: the `?github=` URL parameter, else the
   `VITE_GITHUB_URL` build variable, else the graph metadata's `github_url`
   (the build variable winning is tracked in
   [#61](https://github.com/Beneficial-AI-Foundation/probegraph/issues/61));
3. branch from `VITE_GITHUB_BRANCH` (default `main`) and an optional path
   prefix from `?prefix=` / `?github_prefix=` or `VITE_GITHUB_PATH_PREFIX`.

The prefix is skipped when a node's path already starts with it, so mixed
layouts (some paths repo-relative, some crate-relative) work.

## Sharing: Copy Link and URL parameters

**Copy Link** produces a URL that reproduces the current view. Only
non-default values are included. All parameters:

| Parameter | Meaning |
|---|---|
| `json` / `url` | graph URL to load |
| `github` | GitHub base URL for source links |
| `prefix` / `github_prefix` | path prefix for source links |
| `layer` | `code` or `blueprint`; default is the blueprint layer when the graph has one |
| `view` | `file-map`, `crate-map` or `hierarchy`; default is Call Graph. The old `view=blueprint` opens the File Map |
| `source`, `sink` | the Source → Sink query |
| `id` (repeated), `dir`, `label` | an exact node set from a Guide suggestion, drill-down or cross-layer link; `dir` is `none`, `callers`, `callees` or `both`, `label` the text shown in the inputs |
| `boundary-source`, `boundary-target` | a crate boundary query (from the Guide or the Crate Map) |
| `sel` (repeated) | IDs of clicked (selected) nodes |
| `files` | Include Files patterns |
| `depth` | depth limit (0 = all) |
| `excludeName`, `excludePath` | exclusion globs |
| `hide` (repeated) | IDs of hidden nodes. The older `hidden` (comma-separated display names) is still read |
| `focus` | URL of a focus-set JSON (`{"focus_nodes": [...]}`) restricting the initial view |
| `entrypoints` | URL of a probe-leanblueprint JSON whose blueprint atoms seed the initial view |
| `source-crate`, `target-crate` | crate dropdown selection |
| `expanded` | expanded groups in the Hierarchy view, comma-separated |
| `exec`, `proof`, `spec`, `axioms`, `types`, `proj`, `inst` | kind toggles (`1`/`0`) |
| `inner`, `pre`, `post`, `mapping`, `speclinks` | edge-type toggles (`1`/`0`) |
| `statement`, `body` | Statement deps and Body/proof deps toggles (`1`/`0`) |
| `verified`, `failed`, `unverified` | verification-status toggles (`1`/`0`) |
| `status` | exact status set, comma-separated (e.g. `transitively-verified`) |
| `rust`, `lean` | language toggles for mixed graphs (`1`/`0`) |
| `libsignal`, `external` | source-type toggles (`1`/`0`) |

Precedence when several query parameters are present: `id`, then `focus`,
then `boundary-*`, then `source`/`sink`. Only the active layer's state is in
the URL.

Copy Link omits `inner`, `pre` and `post` for Lean graphs, which have no such
boxes.

## Guide tab

The right sidebar has a **Guide (testing)** tab with a statically computed
graph overview and suggested queries. No LLM is involved.

- Counts use the whole graph, with transitively verified, verified (locally
  only) and trusted reported separately.
- Suggestions only name nodes and edges the current kind and edge-type
  filters show, and update when those filters change.
- The boundary suggestion is the pair of crates or namespaces with the most
  edges in that direction.
- "Show only transitively verified" selects that status alone (graphs without
  it get "Show only verified").
- Clicking a suggestion keeps the Guide open; a toast reports the result, e.g.
  "180 nodes: callers of GF16", and notes truncation. Browser back undoes it.

## VS Code

The viewer also runs inside a VS Code webview with a message-based API; see
[vscode-extension.md](vscode-extension.md).
