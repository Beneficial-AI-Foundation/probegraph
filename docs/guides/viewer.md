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
  the source crate (the captions inside the Crate Map say the opposite, see
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
the selected node or, for an exact-node or focus query, the query's node. The Call Graph does this on its own
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

Seeds are expanded to the Depth slider's value (default 1, at most 10), or
less if that exceeds the render budget, and a banner reports "Showing N of M nodes (entry points, depth d)". The Depth
slider re-expands from the seeds. `?focus=` takes precedence over
`?entrypoints=`; clearing the focus set resumes the entrypoints seeding.

Only the Call Graph seeds. The File Map on a large graph with no query shows
a "use filters" message instead, and Crate Map and Hierarchy render the whole
graph. Filtered results in the Call Graph and File Map are truncated to 200
rendered nodes; the seeded view is not. Truncation keeps the target and then
the nodes nearest to it, ties broken by ID. The distance is the number of
steps from the target in the query direction, counted before the display
filters run. Queries without a target (paths, boundaries, no query) keep the
most connected nodes.

The display filters (origin, status, language, result files, edge types)
can remove the nodes between a shown node and the target. The shown node
then has no visible edge to the target, but it is still one of the nearest.
For example, "callers of t" with verified nodes hidden can show callers of a
hidden verified function, with no edge from them to t.

## Search box

The search box in the header finds a declaration by name and shows it in
the Call Graph. Press `/` anywhere outside a text field to move the focus
to it. Unlike Source and Sink, the search box does not change the query
while you type. It can change the query only when you pick a result.

What it searches. The search box looks at every declaration of the graph.
If the graph has a blueprint layer, it looks at both layers. The sidebar filters
do not limit the results, so the search box also finds hidden nodes. It
searches three fields of each declaration:

1. The display name.
2. The module path: the node ID and the file path.
3. The statement names: the names of the declarations that the statement
   uses. In Lean these are the type dependencies. In Verus these are the
   `requires` and `ensures` dependencies.

How it matches. The search box splits names into words at `_`, `.`, `::`,
`/`, digits and camel-case boundaries. For example, `mul_by_pow_2` gives
mul, by, pow and 2, and `lagrangeBasisPoly` gives lagrange, basis and poly.
Every word of the query must match a word of some field. A word matches
exactly, as a prefix, or as a substring. A whole camel-case name also
matches in lowercase, so `keyhistory` finds `KeyHistory`.

How it ranks. A query that is a whole node ID comes first, then a query
that is a whole display name. Next, a match in the name ranks above a
match in the module path. A match in the module path ranks above a match
in a statement name. In each field, an exact word ranks above a prefix, and a
prefix ranks above a substring. Ties go to the earlier word in the name,
then to the shorter name, then to the ID. The plan
[graph-search.md](../plans/graph-search.md) has the test queries for this
order.

The result list. Each row shows the display name, the declaration kind,
the verification status and the file path. The status has a dot in the
colour that the Call Graph uses. If the file path is empty, the row shows the
node ID. On a graph with two layers, a `blueprint` tag marks the blueprint
entries. The list shows the first 20 results. If there are more, the last
line says so. Add words to the query to narrow it. A screen reader
announces the number of matches, or that nothing matches, while the focus
stays in the search box.

Each row has three buttons:

- The row itself (or Enter in the search box, for the top row) shows the
  node. If the current query already reaches the node, the query stays.
  If not, the viewer queries the node, its callers and its callees at the
  current depth.
- **as source** adds the node to the current source set, which shows what
  the sources call. If the current query is not a set of sources, the
  node starts a new one.
- **as sink** adds the node to the current sink set, which shows what
  calls the sinks. If the current query is not a set of sinks, the node
  starts a new one. A source set and a sink set together, with the paths
  between them, are not available yet.

After any of the three, the viewer opens the node in Node Details. If
necessary, it switches to the layer of the node and to the Call Graph
view. If you hid the node with Shift+click, it shows the node again. When the
layout settles, the camera centres on the node. The other filters stay as
they are, so the node can still be hidden. In that case the action toast
below says why. One Back undoes the whole change: the layer, the view, the
hidden node and the query.

The result list closes after any of the three, and the focus goes back to
the search box with your query still in it. Press Alt+Enter to reach the
action toast, or ArrowDown to open the list again. The list also closes
when the focus leaves the search box.

Keys in the search box:

| Key | Action |
|---|---|
| Enter | Show the top result |
| ArrowDown | Move to the result list |
| Escape | Close the result list |
| Alt+Enter | Move to the first button of the action toast |

In the result list, ArrowUp and ArrowDown move to the same button in the
previous or next row. Tab moves between the buttons of a row. ArrowUp
from the first row and Escape go back to the search box.

Limits. The search box finds declarations only by their words. It does not
read filter words such as `kind:lemma` yet, and it does not search
docstrings, because no extract has them. On a large graph that is not
loaded yet (the "Large Graph Detected" prompt), the search box says to
load the graph first. The viewer builds the search index the first time
the search box gets the focus, and again after each new graph. On a graph
with 22 000 nodes this takes about 65 ms.

### Action toast

If the node that you picked is not drawn, a toast at the top of the page
says why. If buttons can draw the node, the toast offers them. Nothing
changes until you click one. The toast stays for 8 seconds, and
longer while the pointer is on it or one of its buttons has the keyboard
focus. Alt+Enter in the search box moves the focus to its first button.

| Message | Cause | Buttons |
|---|---|---|
| *name* is hidden by the *X* filter | A sidebar node filter hides the node, for example Spec is off | **Show it** turns those filters off |
| *name* is not drawn even with every node filter off | No node filter explains it | None |
| *name* is beyond the 200-node render limit | The query reaches the node, but the render limit cut it | **Keep it in the query**, **Query this node instead**, **Draw all N nodes** |

For the render limit, **Keep it in the query** adds the node to the
current set of query nodes, which truncation always keeps. If the query
has no such set, the viewer does not offer it. **Query this node instead**
replaces the query with the node and its neighbours. **Draw all N nodes**
draws the whole result for this query only. The viewer offers it only up
to 500 nodes, because a larger layout blocks the browser for many seconds.
**Show it** adds one Back entry that restores the filters and the query
together.

A toast button acts on the view in which the toast appeared. A new query,
a filter or Back changes the view. After such a change, a click only shows
"The view changed, so this action no longer applies".

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

**Declaration Kind** and **Edge Types** adapt to the graph's language. A
graph is Verus when a node has `language: "verus"`, Lean when one has
`language: "lean"`, and mixed when both do; only a graph with no `language`
fields at all is classified by its `kind` values. Graphs whose code nodes are
tagged `language: "rust"` are therefore neither: on their own they get the
Lean-style Definitions / Theorems boxes and no Requires / Ensures, and merged
with Lean they count as Lean
([#68](https://github.com/Beneficial-AI-Foundation/probegraph/issues/68)).

Verus graphs get
Exec / Proof / Spec, with Spec **off by default**. Lean graphs get
Definitions / Theorems, plus checkboxes that appear only when the graph
contains them: Axioms (on by default — they are the trusted base),
Types (`structure`/`inductive`/`class`), Projections, and Instances (all off
by default). Mixed graphs with spec functions additionally get the Verus
Spec toggle.

**Edge Types**: Verus and mixed graphs always get Body
Calls (on) and Requires and Ensures clause edges (off), whether or not the
graph has edges of each kind.
Lean graphs from probe-lean with the type/term split get **Statement deps**
(dependencies used in a declaration's type) and **Body/proof deps**
(used in its definition body or proof), both on; on the blueprint layer
they are the entries' statement and proof uses. These two boxes restrict
traversal, not only display: with Body/proof off, a query does not reach a
node through a body/proof edge. An edge in both roles shows while either box
is on. Mapping (cross-language Rust↔Lean) and Specifications (Lean spec
theorem → definition) edges, both on, appear only when the graph has them. Mapping
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
graph overview, ranked lists, a dependency levels strip and suggested queries. No LLM is
involved.

- Counts use the whole graph, with transitively verified, verified (locally
  only) and trusted reported separately.
- Three ranked lists: **Unfinished work** (unverified or failed declarations;
  axioms are not listed here), **Assumptions** (axioms and trusted
  declarations) and **Keystone lemmas** (theorems or proof functions;
  "Most depended on" with every node on graphs without them). Each ranks by
  unique transitive dependents: the number of declarations that reach the
  row's node, each counted once. Members of a cycle share one count. Ties
  break by ID. A row opens the callers of its node.
- The lists need about C²/8 bytes for C groups of declarations (a cycle
  is one group), and time that grows with C and the links between groups.
  Above 20,000 groups, or with too many links for that number of groups,
  the Guide does not compute them and says so. This limits the memory and
  the time the page is blocked. The Dependency levels strip still shows.
- The **Dependency levels** strip shows how verification is spread over
  the dependency stack. See [Dependency levels](#dependency-levels).
- Lists and suggestions only name nodes and edges the current kind and
  edge-type filters show, and update when those filters change. The counts
  always use every node and every dependency.
- The boundary suggestion is the pair of crates or namespaces with the most
  edges in that direction.
- "Show only transitively verified" selects that status alone (graphs without
  it get "Show only verified").
- Clicking a row or a suggestion keeps the Guide open; a toast reports the
  result, e.g. "180 nodes: callers of GF16". When the render cap applies, it
  gives the number of nodes not shown, and when display filters (origin,
  status, language, files) removed nodes, it says how many. Browser back
  undoes it.

### Dependency levels

The strip sorts the declarations by how deep they sit in the dependency
graph. A declaration with no dependencies in the graph is at level 0.
Every other declaration is one level above its highest dependency, so its
level is the length of the longest dependency chain below it. A cycle
(declarations that all depend on each other) counts as one declaration,
and its members share one level. Dependencies outside the graph, for
example the standard library, are not counted.

Each row has four parts:

- The level, for example `L3`.
- The number of declarations at that level.
- A bar with the transitively verified, verified and trusted shares, in
  the colors of [Verification colors](#verification-colors). The empty
  part of the bar is unverified, failed or unknown.
- The same shares as text, also in the tooltip.

Example: for `a -> b -> c` and `a -> c`, `c` is at level 0, `b` at
level 1 and `a` at level 2. The edge `a -> c` does not lower the level
of `a`, because `a` also depends on `b`.

Read the strip from the bottom up. Low levels hold the basic definitions
and lemmas that the rest of the project builds on. If those levels have
a low verified share, much of the project rests on unproven ground, even
when the top levels look verified. A high unverified share near the top
is less serious, because little depends on it.

The strip always uses every node and every dependency of the graph. It
does not change with the kind or edge-type filters. It shows at most 60
rows. In a deeper graph, the last row (for example `L59+`) combines the
remaining levels, and its tooltip gives the level range. The rows are
not clickable.

The strip is on trial. If it does not help to read real graphs, it will
be removed.

## VS Code

The viewer also runs inside a VS Code webview with a message-based API; see
[vscode-extension.md](vscode-extension.md).
