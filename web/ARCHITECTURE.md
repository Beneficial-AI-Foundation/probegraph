# Web viewer architecture

## System overview

The viewer consumes JSON produced by **language-specific probes**, standalone
tools that extract dependency graphs and verification metadata:
[probe-verus](https://github.com/Beneficial-AI-Foundation/probe-verus),
[probe-rust](https://github.com/Beneficial-AI-Foundation/probe-rust),
[probe-lean](https://github.com/Beneficial-AI-Foundation/probe-lean) and
[probe-aeneas](https://github.com/Beneficial-AI-Foundation/probe-aeneas)
(Rust → Lean translation).

Single-probe output is an **atom dict** (see Input formats). `probe merge`
combines outputs from several probes into one mixed-language graph; the loader
resolves cross-project dependencies and synthesizes Rust↔Lean mapping edges
from the Aeneas translation metadata. A probe-leanblueprint extract adds a
second graph, the blueprint layer (below).

```
  probe-verus / probe-rust        probe-lean          probe-aeneas
  (SCIP index → atoms)        (Lean env → atoms)   (translation map)
          └──────────────┬──────────┴──────────────────┘
                         ▼
              atom dict JSON, usually wrapped
              in a schema envelope with provenance
                         │  graph.json
                         ▼
              ┌─────────────────────┐
              │     Graph Loader    │  normalize to D3Graph
              └──────────┬──────────┘
                         ▼
              ┌─────────────────────┐   ┌──────────────┐
              │    Query Pipeline   │◄──│ UI Controls  │
              └──────────┬──────────┘   └──────────────┘
                         ▼
              ┌─────────────────────┐
              │      View Layer     │  Call Graph / File Map / Hierarchy /
              └──────────┬──────────┘  Crate Map (Lean: Namespace Map)
                         ▼
                    SVG canvas         + Guide panel, VS Code webview
```

The Rust side of the Verus/Rust path (SCIP index → atoms) lives in
`crates/scip-core`; see
[docs/technical/scip-core-architecture.md](../docs/technical/scip-core-architecture.md).
`probe-lean extract` writes the atom dict directly.

## Input formats

The loader (`parseAndNormalizeGraph` in `src/graph-loader.ts`) auto-detects
four formats.

**1. Probe atom dict (primary).** A flat object keyed by atom ID:

```json
{
  "probe:fn_name": {
    "display-name": "fn_name",
    "dependencies": ["probe:other_fn"],
    "code-path": "src/lib.rs",
    "code-text": { "lines-start": 10, "lines-end": 25 },
    "kind": "exec",
    "verification-status": "verified",
    "language": "rust",
    "dependencies-with-locations": [
      { "code-name": "probe:other_fn", "location": "inner", "line": 15 }
    ]
  }
}
```

The full field list is the `ProbeAtom` interface in `src/types.ts`.

**2. Schema envelope.** Wraps an atom dict with provenance. The loader accepts
any `schema-version` that has a `data` payload (`isSchema2Envelope` in
`types.ts`). Merged graphs carry an `inputs[]` array with one `source` per
probe run instead of a single `source`:

```json
{
  "schema": "probe-lean/extract",
  "schema-version": "3.0",
  "tool": { "name": "probe-lean", "version": "0.14.0", "command": "extract" },
  "source": { "repo": "...", "commit": "...", "language": "lean", "package": "Spqr" },
  "data": { /* atom dict */ }
}
```

From `source` / `inputs[]` the loader derives per-language GitHub source
configs (repo, commit as ref, package directory as path prefix), so nodes
link to source across a multi-repo merge (`pickSourceConfig`). The prefix
comes from the optional `source.package-path` (the package's directory in
the repo); without it a Rust package is assumed to sit in a workspace
member named after itself, which is wrong for crates at the repo root
(`sourcePathPrefix`).

**3. D3Graph.** `{ nodes, links, metadata }`, the viewer's internal format,
accepted directly (emitted by the Rust pipeline's `atoms_to_d3_graph` and
`export_call_graph_d3`).

**4. Simplified (legacy).** An array of nodes with `identifier` / `deps`
fields (`convertSimplifiedToD3Graph`).

## Graph loader

`convertAtomDictToD3Graph()` does more than field mapping:

- **Entry points** (`is_entry_point`): set for atoms marked `is-public-api`,
  for their Lean translation targets (these have in-project callers, so
  degree-based seeding would hide them), and for Lean atoms with the
  `blueprint` attribute. They are the preferred seed tier for large graphs.
- **Link synthesis**: `dependencies-with-locations` become typed edges
  (`inner` / `precondition` / `postcondition`); edges between atoms of
  different languages become `mapping` edges; `translation-name` adds a
  Rust→Lean `mapping` edge; `specs` entries add spec-theorem → definition
  `spec` edges. Lean `inner` links get a `role` from the
  `type-dependencies` / `term-dependencies` split.
- **Merge resolution**: `*-dependencies-external` names that resolve in the
  loaded atom set become ordinary edges.

`crate_name` is backfilled by `main.ts` when a layer becomes active, using
`extractCrateName()` (`types.ts`): first segment of the ID for Rust, first
two segments of `relative_path` for Lean, `blueprint/<chapter>` for blueprint
entries. The Crate Map and Hierarchy group on this value.

## Blueprint layer

Atoms with `language: "blueprint"` (probe-leanblueprint entries) never mix
with the code graph: the loader builds them into a separate graph returned as
`graph.blueprintLayer`. Its links come from `blueprint-statement-uses` and
`blueprint-proof-uses` and are `inner` links with role `type` (statement),
`term` (proof) or `both`, so the role toggles work on both layers. An entry's
`dependencies` are its bound Lean declarations; they are kept in
`blueprint.bindings` on the node, not turned into edges.

`main.ts` keeps both layers (`codeLayer`, `blueprintLayer`) and points
`state.fullGraph` at the active one; each layer has its own filters. On the
blueprint layer the project language is `blueprint`, so the third view is the
Chapter Map and the proof bucket is `blueprint-theorem`. Cross-layer links in
node details (`blueprint-details.ts`) and double-click on an entry open the
target on the other layer. User-facing behaviour is in
[viewer.md](../docs/guides/viewer.md#blueprint-and-code-layers).

## Modules

| Module | Role |
|--------|------|
| `src/types.ts` | Shared types (`D3Node`, `FilterOptions`, `ProbeAtom`, …), kind sets, `extractCrateName`. Authoritative; not duplicated here. |
| `src/graph-loader.ts` | Format detection and normalization (above) |
| `src/query.ts`, `src/filters.ts` | Compile → execute query pipeline; see [QUERY_PIPELINE.md](QUERY_PIPELINE.md) |
| `src/intent.ts` | `QueryIntent`: what the query is about (text, exact IDs, focus set, boundary) |
| `src/url-state.ts` | URL codec (`writeURLState` / `readURLState`), `defaultFilters()`, `ActiveView`, `Layer` |
| `src/status-filter.ts` | Verification status groups and the exact-status filter |
| `src/status.ts` | File Map border status (own readiness) and fill status (subtree completeness) |
| `src/graph.ts` | Call Graph view (layered force layout, auto-fit camera) |
| `src/file-map.ts` | File Map view (dagre compound layout, border/fill colouring) |
| `src/crate-map.ts` | Crate / Namespace / Chapter Map (quotient graph, drill-down and boundary modes) |
| `src/hierarchy.ts`, `src/hierarchy-map.ts` | Hierarchy view: tree, cut computation, rendering |
| `src/graph-utils.ts` | Seed tiers and budgeted expansion for the seeded view, transitive reduction |
| `src/blueprint-details.ts` | Node-details section for blueprint entries and cross-layer links |
| `src/theme.ts` | Colour tokens read from CSS, group palette |
| `src/html.ts` | `escapeHtml` for graph-provided values in HTML |
| `src/guide/` | Static-analysis Guide panel (graph summary, suggested queries; no LLM) |
| `src/main.ts` | State, layers, graph loading, view dispatch, URL and history, VS Code messaging |

Per-view layout and encoding algorithms are specified in
[docs/technical/](docs/technical/README.md).

## Theming

`style.css` defines the palette as `--pg-*` custom properties on `:root`
(statuses `--pg-status-*`, edge types `--pg-edge-*`, accent, text, selection).
`theme.ts` reads them once at load with `getComputedStyle` and falls back to
built-in values where no stylesheet is computed (jsdom in tests). A host page
such as verilib can override the variables to retheme the viewer, the SVG
views included, as long as the overrides are in place before the script
runs. Categorical group colours (File Map, Crate Map, Hierarchy) come from
`groupColors()` in `theme.ts`, not from CSS.

## Performance

All constants are in `main.ts` unless noted.

- **Deferred loading**: fetched files over `LARGE_FILE_SIZE_THRESHOLD`
  (10 MiB) wait for a query before parsing.
- **Large-graph gate**: graphs over `LARGE_GRAPH_NODE_THRESHOLD` nodes or
  `LARGE_GRAPH_LINK_THRESHOLD` links get a seeded Call Graph view
  (`computeSeedTiers` / `expandFromSeeds` in `graph-utils.ts`) with those
  thresholds as the render budget, or the "use filters" view if no tier fits.
  Aggregated views (`isAggregatedView`: Crate Map, Hierarchy) are exempt.
- **Result limiting**: query results are truncated to `MAX_RENDERED_NODES`,
  keeping anchors first, then the best-connected nodes. Seeded views bypass
  this cap; they are bounded by the seed budget instead.
- **Debounced input**: on large graphs only, typing in the query, exclude and
  include fields applies after `SEARCH_DEBOUNCE_MS`.
- Nodes and links are cloned before D3 mutates them.

Seeding details worth knowing before changing it:

- Seed tiers and expansion build adjacency from the normalized link set, not
  the per-node `dependencies` arrays, which omit mapping and spec links.
- Expansion runs over the role-filtered graph, so the Statement / Body-or-proof
  toggles constrain it like a query.
- Seeded views pass their BFS depths to the renderer as `nodeDepths`. Without
  them the Call Graph falls back to `computeTopologicalDepth`, whose layering
  around cycles is arbitrary (depths are capped at the node count).

## URL parameters and VS Code

URL parameters: [viewer.md](../docs/guides/viewer.md#sharing-copy-link-and-url-parameters)
(codec in [QUERY_PIPELINE.md](QUERY_PIPELINE.md#7-url-state-and-history)).
Webview protocol: [vscode-extension.md](../docs/guides/vscode-extension.md).

## Extension points

### Adding a filter

1. Add the property to `FilterOptions` (`types.ts`) and its default to
   `defaultFilters()` (`url-state.ts`).
2. Add the predicate to `TraversalPredicates` or `DisplayPredicates`
   (`query.ts`), build it in `compileQuery()` and apply it in
   `executeQuery()`.
3. Add the UI control (`index.html`) and handler (`main.ts`).
4. Add the param to `OWNED_PARAMS`, write it in `writeURLState` (omitting the
   default) and read it in `readURLState`.

### Adding node metadata or a new probe

A new probe emits an atom dict, or a schema envelope wrapping one. For each
new field, add it to `ProbeAtom` and `D3Node` in `types.ts` (and, for the Rust
pipeline, to `D3Node` in `crates/scip-core/src/types.rs`), map it in
`convertAtomDictToD3Graph()`, and use it in a view or the details panel. CI
workflows that generate graphs follow
`.github/workflows/generate-lean-callgraph.yml`.

### Adding a view

The four view classes share `update(graph)`, `resize(width, height)` and
`clear()`. File Map, Crate Map and Hierarchy also have `destroy()`;
`createVisualization()` in `main.ts` calls it when present and otherwise
clears the Call Graph and removes its SVG. Only the Call Graph has
`resetView()`. To add a view: write the class, add a button in `index.html`
and a case in `createVisualization()`, add the name to `ActiveView` and to the
`view` parsing in `readURLState` and in `init()` (`main.ts`), and decide
whether it belongs in `isAggregatedView`.
