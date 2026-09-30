# Interactive Graph Viewer - Architecture

## System Overview

The viewer consumes JSON produced by **language-specific probes** — standalone
tools that extract dependency graphs and verification metadata from formally
verified codebases:

| Probe | Language | Repository |
|-------|----------|------------|
| **probe-verus** | Verus / Rust | [Beneficial-AI-Foundation/probe-verus](https://github.com/Beneficial-AI-Foundation/probe-verus) |
| **probe-rust** | Rust | [Beneficial-AI-Foundation/probe-rust](https://github.com/Beneficial-AI-Foundation/probe-rust) |
| **probe-lean** | Lean 4 | [Beneficial-AI-Foundation/probe-lean](https://github.com/Beneficial-AI-Foundation/probe-lean) |
| **probe-aeneas** | Rust → Lean translation | [Beneficial-AI-Foundation/probe-aeneas](https://github.com/Beneficial-AI-Foundation/probe-aeneas) |

Single-probe output is an **atom dict** (see Input Formats). `probe merge`
combines outputs from several probes into one mixed-language graph; the loader
resolves cross-project dependencies and synthesizes Rust↔Lean mapping edges
from the Aeneas translation metadata.

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

## Data Flow

**Verus / Rust path**: `verus-analyzer scip` (or `rust-analyzer scip`) →
`index.scip` → `scip print --json` → probe pipeline (parse, build call graph,
convert to atoms) → atom dict or D3 JSON. The Rust side of this pipeline lives
in `crates/scip-core`; see `docs/technical/scip-core-architecture.md`.

**Lean path**: `probe-lean extract` reads the Lean environment and writes the
atom dict directly. No Rust processing.

**Merged path**: `probe merge` joins several probe outputs; atoms keep
`*-dependencies-external` entries that the loader resolves against the merged
atom set, plus `translation-*` fields from Aeneas that become mapping edges.

In the browser:

```
Load JSON → Normalize (graph-loader) → Full graph + crate_name backfill
          → User interaction → Query pipeline (compile → execute)
          → View dispatch → Render
```

## Input Formats

The loader (`parseAndNormalizeGraph` in `src/graph-loader.ts`) auto-detects
four formats:

### 1. Probe atom dict (primary)

A flat object keyed by atom ID:

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

Atoms may also carry `is-public-api`, `attributes`, `specs`,
`translation-name` / `translation-path` / `translation-text`, `rust-source`,
and `type-/term-dependencies-external`. The full field list is the
`ProbeAtom` interface in `src/types.ts`.

### 2. Schema envelope

Wraps an atom dict with provenance. Current probe output is
`"schema-version": "3.0"`; the loader accepts any version that has
`schema-version` and a `data` payload (`isSchema2Envelope` in `types.ts`).
Merged graphs carry an `inputs[]` array with one `source` per probe run
instead of a single `source`:

```json
{
  "schema": "probe-lean/extract",
  "schema-version": "3.0",
  "tool": { "name": "probe-lean", "version": "0.14.0", "command": "extract" },
  "source": { "repo": "...", "commit": "...", "language": "lean", "package": "Spqr" },
  "data": { /* atom dict */ }
}
```

The loader extracts per-language GitHub source configs from `source` /
`inputs[]` (repo, commit as git ref, package as path prefix for Rust
workspace crates) so the viewer can link nodes to source across a
multi-repo merge (`pickSourceConfig`).

### 3. D3Graph

`{ nodes, links, metadata }` — the viewer's internal format, accepted
directly (emitted by the Rust pipeline's `atoms_to_d3_graph` and by
`export_call_graph_d3`).

### 4. Simplified format

An array of nodes with `identifier` / `deps` fields
(`convertSimplifiedToD3Graph`). Legacy.

## Graph Loader

`convertAtomDictToD3Graph()` does more than field mapping:

- **Entry points** (`is_entry_point`): set for atoms marked `is-public-api`,
  for their Lean translation targets (the Aeneas mapping join — these have
  in-project callers, so degree-based seeding would hide them), and for Lean
  atoms with the `blueprint` attribute. Used as the preferred seed tier for
  the seeded initial view on large graphs.
- **Link synthesis**: `dependencies-with-locations` become typed edges
  (`inner` / `precondition` / `postcondition`); edges between atoms of
  different languages become `mapping` edges; `translation-name` adds an
  explicit Rust→Lean `mapping` edge; `specs` entries add spec-theorem →
  definition `spec` edges.
- **Merge resolution**: `*-dependencies-external` names that resolve in the
  loaded atom set (after `probe merge`) become ordinary edges.
- **`crate_name` backfill** happens at load time via `extractCrateName()`
  (`types.ts`): first path segment of the SCIP/probe ID for Rust, first two
  path segments of `relative_path` for Lean, per-node in mixed graphs. The
  Crate Map partitions on this value.

## TypeScript Components

| Module | Role |
|--------|------|
| `src/types.ts` | All shared types (`D3Node`, `FilterOptions`, `GraphState`, kind sets, verification statuses). The type definitions there are authoritative; they are not duplicated here. |
| `src/graph-loader.ts` | Format detection and normalization (above) |
| `src/query.ts`, `src/filters.ts` | Compile → execute query pipeline. See `QUERY_PIPELINE.md`. |
| `src/graph.ts` | Call Graph view (layered force layout, auto-fit camera) |
| `src/file-map.ts` | File Map view (dagre compound layout, dual-channel coloring) |
| `src/crate-map.ts` | Crate Map / Namespace Map view (quotient graph, 3 drill-down modes) |
| `src/hierarchy.ts`, `src/hierarchy-map.ts` | Hierarchy view: cut through the crate → directory → file → function tree, expand/collapse in place, aggregated edges |
| `src/graph-utils.ts` | Seed tiers and budgeted expansion for the seeded initial view, transitive reduction |
| `src/guide/` | Static-analysis Guide panel (graph summary, suggested queries — no LLM) |
| `src/main.ts` | State, URL handling, view dispatch, VS Code messaging |

Per-view layout and encoding algorithms are specified in
[`docs/technical/`](docs/technical/README.md).

The third view is labeled **Crate Map** for Rust graphs and **Namespace Map**
for Lean graphs (`main.ts`, `crate-map.ts`); the partitioning is the
`extractCrateName` value either way.

The **Hierarchy** view renders a *cut* through the crate → directory → file →
function tree: every function belongs to exactly one visible member (itself
when its file is expanded, otherwise its nearest collapsed ancestor group),
and edges are aggregated between members with call counts. Collapsed groups
show rollup stats and a verified-fraction bar; expansion state round-trips
through `?view=hierarchy&expanded=...`. Like the Crate Map, it aggregates the
whole graph, so it bypasses the large-graph gate and result limiting.

## URL Integration

Graph sources: `?json=` (alias `?url=`) loads from a URL, `?github=` sets the
source-link base, `?github_prefix=` / `?prefix=` set the path prefix;
`VITE_GRAPH_JSON_URL`, `VITE_GITHUB_URL`, `VITE_GITHUB_BRANCH`,
`VITE_GITHUB_PATH_PREFIX` are the build-time equivalents. Filter state,
view selection, crate boundary, `?focus=` and `?entrypoints=` payload URLs
are all shareable; the full parameter table is in `QUERY_PIPELINE.md` §7.

## Performance

- **Deferred loading**: files over 10 MiB (`LARGE_FILE_SIZE_THRESHOLD`)
  prompt before loading.
- **Large-graph gate**: graphs over 2 000 nodes or 10 000 links
  (`LARGE_GRAPH_*_THRESHOLD`) don't render fully. Instead the viewer
  auto-seeds an initial view from entry points (`computeSeedTiers` /
  `expandFromSeeds` in `graph-utils.ts`) within a render budget, with a
  banner showing what is displayed. Only if no seed tier fits does it fall
  back to the empty "use filters" view.
- **Result limiting**: at most 200 rendered nodes (`MAX_RENDERED_NODES`).
- **Debounced search**: 300 ms.
- Pre-computed `dependencies` / `dependents` arrays; nodes and links are
  cloned before D3 mutates them.

## VS Code Integration

The viewer runs as a webview (`vite.config.vscode.js` builds it with relative
paths). Messaging:

```typescript
// Extension → webview
webview.postMessage({
  type: 'loadGraph',
  graph: graphData,
  selectedNodeId: 'scip:...#function()',   // exact-match node selection
  initialQuery: { source: 'function_name', depth: 2 }
});

// Webview → extension
vscode.postMessage({
  type: 'navigate',
  relativePath: 'src/lib.rs', startLine: 42, endLine: 50
});
```

Exact node IDs bypass pattern matching (see `QUERY_PIPELINE.md` §6.4). In
webview mode the file-upload UI is hidden and auto-load is skipped. Full
protocol: `docs/guides/vscode-extension.md`.

## Extension Points

### Adding a new filter
1. Add the property to `FilterOptions` (`types.ts`)
2. Add the predicate to `TraversalPredicates` or `DisplayPredicates` (`query.ts`)
3. Wire it in `compileQuery()` and apply it in `executeQuery()`
4. Add the UI control (`index.html`) and handler (`main.ts`)
5. Update URL generation/parsing for shareable links

### Adding new node metadata
1. Add the field to `ProbeAtom` in `types.ts` (and, for the Rust pipeline,
   to `D3Node` in `crates/scip-core/src/types.rs`)
2. Map it in `convertAtomDictToD3Graph()` (`graph-loader.ts`)
3. Add the field to the TypeScript `D3Node` interface
4. Use it in the visualization (details panel, coloring, …)

### Supporting a new probe
1. Emit atom dict JSON (or a schema envelope wrapping one)
2. Add any new fields to `ProbeAtom` in `types.ts`
3. Map them in `convertAtomDictToD3Graph()`
4. Add a CI workflow (see `.github/workflows/generate-lean-callgraph.yml`)

### Custom visualizations
Each view implements `update()`, `destroy()`, `resize()`, `clear()`, and
`highlightNodes()`. To add one: create a class with that interface, add a
button in `index.html` and a case in `createVisualization()` (`main.ts`),
and register the name in the `ActiveView` type and URL handling.
