# Web viewer guide

The web viewer is an interactive D3 visualization for probe graphs: Rust/Verus
call graphs (from SCIP), Lean atom graphs (from probe-lean), and merged
cross-language graphs with Rust↔Lean mapping links.

- Live demo: https://beneficial-ai-foundation.github.io/probegraph/
- Local: `cd web && npm install && npm run dev`, then open http://localhost:3000

## Loading a graph

The viewer tries these sources in order:

1. `?json=<url>` (alias `?url=`) — fetch a graph from a URL.
2. `VITE_GRAPH_JSON_URL` — build-time default URL (used by the Pages deploy).
3. `./graph.json` — the file in `web/public/`, auto-loaded on startup. The
   committed one is the demo graph shown on GitHub Pages.
4. The **Load Graph JSON** button — pick a local file.

Files larger than 10 MiB are not parsed immediately (a `HEAD` request checks
the size first): the viewer shows a "Large Graph Detected" prompt and loads
only when you set a Source, Sink, or Include Files filter and press
**Load & Search**. This gate is about `JSON.parse` freezing the browser;
rendering is bounded separately by the seeded view (below).

Four input formats are accepted: probe atom dicts (`atoms.json` from
probe-verus / probe-lean), schema envelopes wrapping such a dict (the
`schema-version` + `data` form, including multi-input merged envelopes),
the viewer's native `{nodes, links, metadata}` D3 format, and a legacy
flat array format. See `web/ARCHITECTURE.md` for the schemas.

## Views

- **Call Graph** — force-directed layout with callers on the left and callees
  on the right (topological bias).
- **File Map** — nodes grouped by file, laid out with dagre after transitive
  reduction. Shapes encode kind (rounded rectangle = definition/exec,
  ellipse = theorem/proof, diamond = spec/axiom); the border color encodes the
  node's own verification readiness and the fill encodes subtree completeness.
- **Crate Map** — one node per crate, edges weighted by call count. For Lean
  graphs the button is relabeled **Namespace Map** and grouping uses the first
  two path segments (e.g. `ArkLib/Data`). Click one crate then another to set
  a boundary query (functions in the source crate that call the target crate);
  double-click a crate to open it in the Call Graph.

The algorithms are specified in `web/docs/technical/`.

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
The Crate Map is exempt (it aggregates the full graph). Filtered results in
other situations are truncated to 200 rendered nodes.

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

**Edge Types** appears for Verus and mixed graphs: Body Calls (on),
Requires and Ensures clause edges (off), and — when the graph has them —
Mapping (cross-language Rust↔Lean) and Specifications (Lean def → spec
theorem) edges, both on. Lean-only graphs hide this section.

**Verification Status** has three toggles: verified-like (verified,
transitively verified, trusted), failed, and unverified/unknown. A Guide
suggestion can select an exact status (e.g. transitively verified only); the
Verified box then shows as partly checked.

**Language** appears only for mixed graphs: show/hide Rust (or Verus) and
Lean nodes. The filter applies after traversal, so paths crossing the hidden
language still resolve.

**Source Type** (Libsignal / External) reflects the `is_libsignal` flag on
nodes; it is only meaningful for graphs generated with that classification.

**Exclude by Name** and **Exclude by Path** take comma-separated globs
(`*_comm*`, `*/specs/*`); the path field has presets. **Include Files**
restricts to matching files (`edwards.rs`, `decompress*.rs`), with a
disambiguation dropdown when a bare filename is ambiguous; when combined with
a source/sink query it filters the results after traversal instead of blocking
paths. **Shift+click** hides a node; hidden nodes are listed in the sidebar
and restorable.

## Verification colors

| Color | Status |
|---|---|
| green `#4ade80` | verified |
| dark green `#15803d` | transitively verified |
| purple `#a855f7` | trusted |
| red `#ef4444` | failed |
| grey `#9ca3af` | unverified |
| blue `#3b82f6` | unknown (no status in the graph) |

## Node details

Click a node (or hover) to see its kind, verification status, location,
callers and callees (clickable), and similar lemmas with scores when the graph
was enriched with them. If a source link can be built, the panel shows
**View on GitHub** (or **Open in Editor** inside VS Code).

### GitHub source links

Links are built per node from `relative_path` plus line numbers. The
configuration is resolved in this order:

1. per-language `source_configs` derived from a merged envelope's `inputs`
   (repo, ref, and path prefix per input);
2. a global base URL: the `?github=` URL parameter, else the graph metadata's
   `github_url`, else the `VITE_GITHUB_URL` build variable;
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
| `view` | `blueprint` (File Map) or `crate-map`; default is Call Graph |
| `source`, `sink` | the Source → Sink query |
| `files` | Include Files patterns |
| `depth` | depth limit (0 = all) |
| `excludeName`, `excludePath` | exclusion globs |
| `hidden` | comma-separated display names of hidden nodes |
| `focus` | URL of a focus-set JSON (`{"focus_nodes": [...]}`) restricting the initial view |
| `entrypoints` | URL of a probe-leanblueprint JSON whose blueprint atoms seed the initial view |
| `source-crate`, `target-crate` | crate boundary selection |
| `exec`, `proof`, `spec`, `axioms`, `types`, `proj`, `inst` | kind toggles (`1`/`0`) |
| `inner`, `pre`, `post`, `mapping`, `speclinks` | edge-type toggles (`1`/`0`) |
| `verified`, `failed`, `unverified` | verification-status toggles (`1`/`0`) |
| `status` | exact status set, comma-separated (e.g. `transitively-verified`) |
| `libsignal`, `external` | source-type toggles (`1`/`0`) |

Copy Link omits the edge-type parameters for Lean graphs, where that filter
section doesn't exist.

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
