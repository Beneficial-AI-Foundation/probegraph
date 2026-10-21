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
while you type. It can change the query only when you pick a result. The
search box also reads filter words, such as `kind:theorem` and
`is:unused`, and the `paths` and `top` queries. See [Query words](#query-words).

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
[graph-search.md](../archive/graph-search.md) has the test queries for this
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
- **as source** adds the node to the current source set. A source set
  alone shows what the sources call.
- **as sink** adds the node to the current sink set. A sink set alone
  shows what calls the sinks.

A source set and a sink set together show the paths from the sources to
the sinks. For example, click **as source** on `encode` and then **as
sink** on `decode`. The graph then shows every declaration on a call path
from `encode` to `decode`, and the query label says `paths encode →
decode`. Further clicks add to either set. If the current query is not a
set of sources, sinks or both, **as source** or **as sink** starts a new
set. A source or sink that is on no path is not drawn, and the action
toast says so. Source → Sink in the sidebar shows the two sets by their
labels. If you type in one of the two inputs, the other one is cleared
and the query becomes a text query.

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
| Enter | Run the `paths` query of the first row, or click **Show all in the Call Graph**, or show the top result |
| ArrowDown | Move to the result list |
| Escape | Close the result list |
| Alt+Enter | Move to the first button of the action toast |

In the result list, ArrowUp and ArrowDown move to the same button in the
previous or next row. Tab moves between the buttons of a row. ArrowUp
from the first row and Escape go back to the search box.

Limits. The search box finds declarations by their words and by the
filter words below. It does not search docstrings, because no extract
has them. On a large graph that is not
loaded yet (the "Large Graph Detected" prompt), the search box says to
load the graph first. The viewer builds the search index the first time
the search box gets the focus, and again after each new graph. On a graph
with 22 000 nodes this takes about 65 ms.

### Query words

A query word narrows the search or runs a query. You can type query
words in the search box and in the Source and Sink inputs.

Filter words. A filter word has the form `key:value`. For example,
`lagrange kind:theorem` finds the theorems with `lagrange` in their name.
A value can list alternatives with commas: `status:failed,unverified`
matches either status. The viewer ignores an empty alternative, so
`crate:dalek,` is the same as `crate:dalek`. A declaration must pass every filter word of the
query. The keys and the case of the values do not matter.

| Word | Matches | Example |
|---|---|---|
| `kind:` | The declaration kind, as the result row shows it. `kind:lemma` matches `proof` and `theorem` | `kind:def` |
| `status:` | The exact verification status: `verified`, `transitively-verified`, `trusted`, `failed` or `unverified`. A declaration without a status counts as `unverified` | `status:failed` |
| `module:` | Whole segments of the file path, in order (see below) | `module:serial.u64` |
| `file:` | A glob on the file name, as Include Files reads it. With a `/`, a glob on the file path | `file:edwards.rs`, `file:*.lean` |
| `level:` | The dependency level, as the [Dependency levels](#dependency-levels) strip counts it | `level:0` |
| `crate:` | A substring of the crate name | `crate:dalek` |
| `is:` | A fixed property: `unfinished`, `assumption`, `unused` or `surface` (see below) | `is:unused` |

The `module:` rule. The viewer splits the value and the file path into
segments at `/`, `.` and `::`, and drops the file extension. The segments of the value must
appear one after the other as whole segments, anywhere in the path. The
case does not matter. Examples:

- Lean: the file path is the module path. `module:SecureMessaging.AEAD`
  and `module:AEAD.Defs` match `SecureMessaging/AEAD/Defs.lean`.
- Rust: the file path names the module. `module:serial::u64::field`
  matches `src/backend/serial/u64/field.rs`. `module:serial.field` does
  not match it, because `u64` is between the two segments.
- Blueprint: the file path names the chapter. `module:Addition` matches
  `blueprint/Addition`.

`module:` does not read the node ID, because IDs have no common module
syntax across Rust, Lean and blueprint extracts. The plan
[graph-search.md](../archive/graph-search.md) gives the reasons.

`level:` uses every node and every dependency of the layer, as the strip
does. The kind and edge-type filters do not change the levels.

The `is:` words. Each name is one fixed rule. The Guide uses the same
rules, so a query and a Guide list cannot disagree.

| Word | Matches | Leaves out |
|---|---|---|
| `is:unfinished` | A declaration with the status unverified or failed, as the Guide's Unfinished work list | Axioms. A declaration without a status, although `status:unverified` counts it |
| `is:assumption` | An axiom, or a declaration with the status trusted, as the Guide's Assumptions list | |
| `is:unused` | A declaration that no other declaration of the layer depends on | Entry points, generated declarations (`@[step]` lemmas of Aeneas, Lean auxiliaries) and hidden declarations. A call to itself does not count |
| `is:surface` | A public function without a contract (see below) | Graphs without public API data |

`is:surface` depends on the extract. In a Verus extract, it matches a
public exec function with no `requires` and no `ensures` dependency. In
an Aeneas extract (Rust and Lean in one graph), it matches a public Rust
function with no Lean translation. Only probe-rust and probe-verus mark
the public API, so other graphs list nothing.

`is:unused` reads every dependency of the layer. The sidebar filters do not
change it. For example, a lemma that only a hidden spec function uses is
not unused. A Lean lemma that the extract shows without callers can still
be in use, through `@[simp]` or `@[grind]`, because the extract does not
record uses by attribute. A lemma that calls others but has no callers is
unused.

In the search box, the filter words narrow the result list. The sidebar
filters still do not. If the query has filter words only, the list shows
every declaration that passes them, ordered by node ID. For example,
`kind:axiom` lists the axioms. Such a list is a node list, see
[Show all](#show-all-in-the-call-graph). In Source and Sink, a text with filter words
selects the declarations that pass them. The other words of the text
match the display name, as before. For example, `decompress module:edwards`
in Source shows what the `decompress` functions in `edwards.rs` call.

The `paths` query. Type `paths from <words> to <words>` in the search
box, for example `paths from module:edwards to module:field`. The first
row of the list then shows the query with a `query` tag. Enter, or a
click on the row, runs it. The viewer puts the words after `from` into
Source and the words after `to` into Sink, as if you typed them there,
and switches to the Call Graph. The graph shows every declaration on a
call path from the first set to the second. One Back undoes the query.

The search box treats a text as a query only if it starts with `paths
from`. Below the query row, the list still shows the search results for
the same text, so a declaration named `paths_from` stays easy to find.
If the text has no search results, the list shows only the query row,
and a screen reader announces "Query ready. Press Enter to run it". If
each side is one `crate:` word, for example `paths from crate:a to
crate:b`, the query shows the calls that cross from crate `a` to crate
`b`, as Source and Sink do for two crates.

The `top` query. Type `top [N] by dependents [filter words]` in the
search box, for example `top 10 by dependents is:unfinished`. The list
shows the N declarations that pass the filter words and have the most
unique transitive dependents. A unique transitive dependent of a node is
a declaration that reaches the node through dependencies, counted once.
This is the count of the Guide's ranked lists. Ties break by node ID, as
in the Guide. Each row gives the count, for example `81 dependents`. A
line above the rows says how many declarations passed the filter words,
for example "Top 10 of 37 by unique transitive dependents".

- N is optional. It is 10 if you leave it out, and it must be a whole
  number from 1 to 200. The list shows the first 20 rows. **Show all in
  the Call Graph** draws all N.
- `by dependents` is required. It is the only ranking.
- Only filter words can follow, for example `module:field` or
  `kind:lemma`. Without filter words, `top` ranks every declaration. That
  list usually starts with basic types and helpers, so add a filter word.
- `top` counts every node and dependency of the layer that the viewer
  shows, as the Guide does. The sidebar filters do not change the counts
  or the rows. The search box finds declarations on both layers, but `top`
  ranks only the shown layer. On a graph with two layers, the line above
  the rows names the layer.
- The search box treats a text as a `top` query only if `top` is followed
  by a number, by `by`, or by nothing. So `top_level` and `top level` stay
  searches.
- On a graph that is too large for the dependent counts, the list says
  "Dependent counts are not available for this graph, because it is too
  large", with the size. The limit is the same as for the Guide lists, see
  [Guide tab](#guide-tab).

A recipe for "the blockers of X", the unfinished declarations that X
depends on: put X in Source, and in the status filter keep only Failed
and Unverified.

#### Show all in the Call Graph

A `top` query and a text of filter words alone give a node list. Under a
node list, a **Show all N in the Call Graph** row draws the whole list.
Enter in the search box does the same. The viewer then sets a query of
exactly these nodes, with the query text as its label, for example `query:
nodes top 10 by dependents is:unfinished`. It switches to the Call Graph
and adds one Back entry. The graph draws the links among the listed nodes,
and it also draws the nodes without links among them. The sidebar filters
still apply. The toast gives the result, for example "8 nodes: is:unused
(2 hidden by filters)".

The row appears only if the whole list has at most 200 nodes, the render
limit. Then the render limit never drops a node. For a larger list, the
last line says "N matches, more than the 200-node render limit. Add
filter words to show them in the Call Graph.", and Enter shows the top
result. For `top`, N is at most 200, so the row is there whenever the list has a row.

A list of filter words can match declarations on both layers. Show all
draws the matches on the layer that the viewer shows, and its count is
the count on that layer. If every match is on the other layer, Show all
switches to it, as a reveal does. One Back then restores the layer too.

Errors. If a query cannot run, the list says why above the results, and a
screen reader announces it:

| Message | Cause |
|---|---|
| Not a query yet: paths from \<words\> to \<words\> | The text starts with `paths from`, but has no `to` or an empty side |
| Not a query yet: top [N] by dependents [filter words] | The text starts with `top`, but `by dependents` is missing |
| top takes a number from 1 to 200 | N is 0 or above 200 |
| top takes filter words only, for example module:field | A plain word after `by dependents` |
| is:*value* is not known. Use unfinished, assumption, unused, surface | An unknown `is:` name |
| *key*: needs a value, for example *word* | A filter word without a value, such as `kind:` |
| status:*value* is not a status. Use verified, transitively-verified, trusted, failed or unverified | An unknown status |
| level:*value* is not a level. Use a whole number, for example level:0 | A level that is not a whole number |

In Source and Sink, a text whose filter word has one of these errors is
read as plain text, which usually matches nothing.

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
| *name* is on no path between the sources and the sinks | The node is a source or a sink, but no call path connects it to the other set | **Query this node instead** |

For the render limit, **Keep it in the query** adds the node to the
current set of query nodes, which truncation always keeps. If the query
has no such set, or has a source set and a sink set, the viewer does not
offer it. **Query this node instead**
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
- `crate:name` matches by crate;
- filter words such as `kind:theorem` and `module:edwards` select by kind,
  status, module, file and level (see [Query words](#query-words)).

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

### Trust base

A code declaration in a graph with verification data shows a **Trust
base** line, for example "Rests on 9 assumptions and 2 unfinished
declarations". It counts what the declaration depends on, directly or
through other declarations:

- **Assumptions** are `trusted` declarations: axioms, external code,
  `admit`, and the other trusted reasons. Each shows its reason in
  parentheses.
- **Unfinished** are `unverified` and `failed` declarations: the
  declaration itself still has a gap such as a `sorry`, or Verus failed
  on it.
- **Untracked** are Verus declarations marked `untracked`. They have no
  status, so what they rest on is unknown. The section then adds
  "External closure unavailable".

A declaration that is itself trusted or unfinished is in its own list,
marked "(this declaration)". Click the line to expand the lists. They stay
expanded or collapsed when you select other nodes.

Under each entry, a grey line shows one shortest chain of dependencies
that leads to it, for example "via decode_state → BytesBufBuf_implBuf".
"direct dependency" means that the declaration uses the entry itself. A
chain with more than six declarations in between is shortened in the
middle. Hover the line to see the full chain. Each entry is a link that
shows its details in this panel, and the graph does not change. A list shows
50 entries at most, then "and N more".

The **show path** button next to an entry draws the grey chain in the
Call Graph: the selected declaration, the entry, and the declarations
between them, with no other nodes. The query bar shows it as `nodes
shortest chain A → B`. Node details stay on the selected declaration, so
you can try the entries one after another. One click is one
browser-history step. The click also unhides the declarations of the chain
that you hid with Shift+click. The other display filters still apply. If
they or the node cap leave out a declaration of the chain, a toast says
which one and why.

Example on the SPQR demo graph. `ConcreteErasureCode_correct` is marked
verified, so the colour does not say what is still open. Its trust base
shows 22 assumptions and 1 unfinished declaration, `collect_default_bridge`.
The unfinished declaration is 9 steps away, through `encode_toModel`,
`chunk_at_spec_points` and several `loop_spec` and `body_spec` lemmas. The
graph around the theorem does not show it. **show path** draws the 10
declarations of the chain. The drawing is a long line that the view fits
small, so zoom in to read the labels
([#113](https://github.com/Beneficial-AI-Foundation/probegraph/issues/113)).

The rules behind the counts:

- The walk stops at a trusted declaration. Unfinished code below an
  `external_body` function does not count for its callers, because the
  extractor already trusts that function.
- A declaration with no status adds nothing, but the walk goes through it
  to what it uses.
- The counts use the whole graph of the current layer. Filters, hidden
  nodes and the node cap do not change them.
- **Missing targets** are dependencies that the extract names but does
  not contain, such as Lean constructors. They are listed for information
  and do not count as assumptions or as unfinished work.

The section is left out for blueprint entries and for graphs without any
verification status. It says "not computed, the graph is too large" when
the trust bases do not fit in the memory limit.

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
| `source-id`, `sink-id` (both repeated), `source-label`, `sink-label` | the paths from a source set to a sink set, from the search box |
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

Precedence when several query parameters are present: `id`, then
`source-id`/`sink-id`, then `focus`,
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
- **Shared trust bases** groups the theorems (Lean theorems, Verus proof
  functions) that rest on exactly the same assumptions and unfinished
  declarations. See [Trust base](#trust-base) for what a declaration rests
  on. It lists the five largest groups, ties by the IDs of their base. A row shows
  the counts, for example "4 assumptions, 1 unfinished", the first two
  names (unfinished first), and the number of theorems on the right. Hover
  the row to see every name. A theorem that rests on nothing is in no
  group. See [Shared trust bases](#shared-trust-bases).
- The **Dependency levels** strip shows how verification is spread over
  the dependency stack. See [Dependency levels](#dependency-levels).
- Lists and suggestions only name nodes and edges the current kind and
  edge-type filters show, and update when those filters change. The counts
  always use every node and every dependency.
- The boundary suggestion is the pair of crates or namespaces with the most
  edges in that direction.
- "Show only transitively verified" selects that status alone (graphs without
  it get "Show only verified").
- Each ranked list has a **query** button next to its title. It puts the
  list's query into the search box and opens the result list there:
  `top 5 by dependents is:unfinished`, `top 5 by dependents is:assumption`
  and `top 5 by dependents kind:lemma`. On a graph without lemmas the last
  one is `top 5 by dependents`, and on the blueprint layer it uses
  `kind:blueprint-theorem`. Edit the query to see more, for example raise
  N or add `module:`. See [Query words](#query-words).
- The Guide list names only the declaration kinds that the Declaration
  Kind boxes show, but the search box ignores the sidebar filters. So the
  query can list a declaration that the Guide list hides. For example, in
  Verus with Spec off, the query can list a spec function.
- Two suggestions fill the search box: **Unused declarations (N)** with
  `is:unused`, and **Public functions without a contract (N)** with
  `is:surface`. Each one shows only if N is above zero. N counts every
  declaration of the layer. These two suggestions and the **query**
  buttons only fill the search box. They show no toast and add no Back
  entry.
- Clicking a row or another suggestion keeps the Guide open; a toast reports the
  result, e.g. "180 nodes: callers of GF16". When the render cap applies, it
  gives the number of nodes not shown, and when display filters (origin,
  status, language, files) removed nodes, it says how many. Browser back
  undoes it.

### Shared trust bases

Click a row to draw the group in the Call Graph. The drawing holds three
parts, and the node cap keeps them in this order:

1. The shared base: the assumptions and unfinished declarations.
2. The theorems.
3. The declarations on the shortest chain from each theorem to each base
   member, as the grey chains in node details show them.

So when a group is larger than the 200-node cap, the base and the
theorems stay and some chain nodes are left out. The toast gives the
counts, for example "45 nodes: 30 theorems, the 6 declarations they rest
on and the chains between". If the cap cut the chains, it says "some of
the chains between". If the base and the theorems alone pass the cap, it
also says how many nodes the cap left out. The query bar shows
`nodes 30 theorems on a shared trust base`. The click switches to the
Call Graph and is one browser-history step.

A group with many theorems and few assumptions is a dependency that much
of the project shares. For example, on the SPQR demo graph the largest
group holds 30 theorems that rest on the same 6 trusted `core` slice
functions, such as `get` and `get_mut`. A group with an unfinished member
shows the theorems that a single missing proof holds back.

The groups use the whole graph, like the trust base. The Declaration Kind
boxes decide which groups show: a group shows when at least one of its
theorems is of a shown kind. The theorem count always counts the whole
group. The section is left out on the blueprint layer, on graphs without
verification data, and when the trust bases do not fit in the memory
limit.

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
