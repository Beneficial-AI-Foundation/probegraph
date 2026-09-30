# Query Pipeline Architecture

This document describes the composable query pipeline that powers the probegraph interactive viewer's filtering and traversal system.

> **History.** The pipeline replaced a monolithic `applyFilters()` function (~983 lines in `filters.ts`). The pre-refactor design proposal and the original filter docs are archived in `docs/archive/QUERY_ARCHITECTURE_PROPOSAL.md` and `docs/archive/FILTERS_PRE_REFACTOR.md` respectively.

## 1. Overview

The pipeline follows a **compile → execute** pattern, separating *what* the user asked from *how* it is evaluated:

```
FilterOptions (UI state)
        │
        ▼
  ┌────────────┐
  │  Compiler  │  compileQuery(filters, lang) → CompiledQuery
  └──────┬─────┘
         │  CompiledQuery { query, traversalPredicates, displayPredicates, ... }
         ▼
  ┌────────────┐
  │  Executor  │  executeQuery(compiled, fullGraph, nodeOptions) → D3Graph
  └──────┬─────┘
         │  7 pipeline steps (see §4)
         ▼
     D3Graph (filtered result)
```

### Source files

| File | Role |
|------|------|
| `src/query.ts` | Query AST, 9 operators, resolver, compiler, executor |
| `src/intent.ts` | `QueryIntent`: what the query is about (text, exact IDs, focus set, boundary) |
| `src/url-state.ts` | URL codec: `writeURLState` / `readURLState`, filter defaults |
| `src/filters.ts` | Public entry point (`applyFilters`), pattern utilities (`globToRegex`, `matchesQuery`) |
| `src/graph-loader.ts` | JSON format normalization (atom dict, schema envelope, D3Graph, simplified) |

The public API is a single function:

```typescript
function applyFilters(
  fullGraph: D3Graph,
  filters: FilterOptions,
  projectLanguage?: ProjectLanguage,
): D3Graph
```

It calls `compileQuery` then `executeQuery` internally.

---

## 2. Query AST

The compiler translates `FilterOptions` into a discriminated union called `GraphQuery`, which encodes the traversal mode without performing any graph access:

```typescript
type GraphQuery =
  | { type: 'callees';          from: NodeMatcher; maxDepth: number | null }
  | { type: 'callers';          to: NodeMatcher;   maxDepth: number | null }
  | { type: 'neighborhood';     center: NodeMatcher; maxDepth: number | null }
  | { type: 'paths';            from: NodeMatcher; to: NodeMatcher }
  | { type: 'crateBoundary';    sourceCrate: string; targetCrate: string; exact: boolean }
  | { type: 'depthFromSelected'; selectedNodes: Set<string>; maxDepth: number }
  | { type: 'noTraversal' };
```

### Node matchers

A `NodeMatcher` identifies *which* nodes to start from:

```typescript
type NodeMatcher =
  | { kind: 'pattern'; query: string }   // substring or glob against display_name
  | { kind: 'crate';   pattern: string } // crate: prefix query
  | { kind: 'nodeIds'; ids: Set<string> } // exact IDs (Guide, VS Code)
```

### Dispatch rules

`compileQuery` switches on `filters.intent` (`src/intent.ts`, design in
`docs/plans/query-intent.md`):

| Intent | Compiled query type |
|--------|---------------------|
| `none` | `depthFromSelected` with clicked nodes, finite depth and no include files; else `noTraversal` |
| `text` | dispatch on the source/sink strings, below |
| `ids`, `dir: 'none'` (focus set or exact set) | `noTraversal` restricted to the IDs; an empty focus set shows nothing |
| `ids`, `callers` / `callees` / `both` | `callers` / `callees` / `neighborhood` with a `nodeIds` matcher |
| `boundary` | `crateBoundary` with `exact: true` (whole crate names) |

Text intents:

| Source | Sink | Compiled query type |
|-------------|-----------|---------------------|
| non-empty | empty | `callees` |
| empty | non-empty | `callers` |
| same string | same string | `neighborhood` |
| `crate:A` | `crate:B` | `crateBoundary` (`exact: false`, substring) |
| different | different | `paths` |

---

## 3. Filter Types

### 3.1 Source Query (text intent `source`)

Shows what functions are **called by** the matched nodes (callee direction). Traverses forward up to `maxDepth`.

**Matching syntax** (handled by `matchesQuery()` in `filters.ts`):

| Syntax | Example | Meaning |
|--------|---------|---------|
| Substring | `decompress` | Matches any `display_name` containing "decompress" |
| Glob wildcards | `lemma_*` | Anchored match (only names starting with `lemma_`) |
| Path-qualified | `edwards::decompress` | Matches `decompress` in files named `edwards.rs` or `edwards.lean` |
| Lean dotted path | `Scalar52.add_spec` | Matches nodes whose full ID contains `Scalar52.add_spec` |
| Crate-qualified | `crate:curve25519-dalek` | All functions in the named crate |

**Lean disambiguation:** When multiple Lean functions share the same `display_name` (e.g., several `add_spec` theorems), use a dotted module-path prefix from the node ID to narrow the match. For example, `Scalar52.add_spec` matches only `probe:...Scalar52.add_spec`, not the Edwards or Ristretto variants. The dotted-path match is a substring match against the full node ID and is only activated when the query contains a `.` character.

### 3.2 Sink Query (text intent `sink`)

Shows what functions **call** the matched nodes (caller direction). Same matching syntax as source.

### 3.3 Source + Sink Combined

| Combination | Behavior |
|-------------|----------|
| Same query (source = sink) | Full neighborhood (callers + callees) |
| Both `crate:` queries | **Crate boundary mode** — only direct cross-crate calls |
| Different queries | DFS path finding from all sources to all sinks |

### 3.4 Include Files (`includeFiles`)

Comma-separated file patterns. Without a source/sink query, only functions defined in matching files pass the traversal predicate. When a directional (source/sink) query is active, the file filter instead runs **post-traversal** as a result filter (step 5b): the BFS traverses the full graph, the displayed results are narrowed to the requested files, and the source/sink seed nodes are kept regardless so the connection context stays visible.

| Pattern | Matches |
|---------|---------|
| `edwards.rs` | All files named `edwards.rs` |
| `src/edwards.rs` | Only `*/src/edwards.rs` |
| `**/backend/**/edwards.rs` | Any `edwards.rs` under a `backend/` directory |
| `curve25519-dalek/**` | All files under `curve25519-dalek/` |

Filename patterns (no `/`) match against `file_name`; path patterns (with `/`) match against `relative_path`.

### 3.5 Exclude Name Patterns (`excludeNamePatterns`)

Comma-separated glob patterns matched against `display_name`. Example: `*_comm*, lemma_mul_*`.

### 3.6 Exclude Path Patterns (`excludePathPatterns`)

Comma-separated glob patterns matched against the node's full SCIP `id`. Example: `*/specs/*, */test/*`.

### 3.7 Function Kind Filters

Seven kind buckets, dispatched by `compileKindPredicate` (`types.ts`):

| Toggle | Default | Kinds (per `getKindSetsForLanguage`) |
|--------|---------|--------------------------------------|
| `showProofFunctions` | true | `proof` (Verus) / `theorem` (Lean) |
| `showSpecFunctions` | false | `spec` |
| `showAxioms` | true | `axiom` |
| `showTypes` | false | `structure`, `inductive`, `class` |
| `showProjections` | false | `projection` |
| `showInstances` | false | `instance` |
| `showExecFunctions` | true | everything else (the default bucket) |

Kind sets are language-aware: for `mixed` graphs the proof bucket covers both `proof` and `theorem`.

### 3.8 Call Type Filters (Link Types)

Five link types (`LinkTypeFilter` in `query.ts`):

| Toggle | Default | Edge type |
|--------|---------|-----------|
| `showInnerCalls` | true | Body calls (`inner` / `calls`) |
| `showPreconditionCalls` | false | `requires` clause calls |
| `showPostconditionCalls` | false | `ensures` clause calls |
| `showMappingLinks` | true | Cross-language Rust↔Lean mapping edges |
| `showSpecLinks` | true | Lean spec-theorem → definition edges |

Requires/Ensures edges typically target spec functions. Enable **both** the call-type toggle and "Show Spec Functions" to see them.

Lean `inner` links carry a `role` when probe-lean emits the `type-dependencies` / `term-dependencies` split: `type` (statement), `term` (definition body or proof, plus names probe-lean reaches through auxiliary declarations, including ones in the type) or `both`. A `spec` link takes the role of the theorem's inner link to the definition, usually `type` or `both`. Two more toggles select them:

| Toggle | Default | Passes roles |
|--------|---------|--------------|
| `showStatementDeps` | true | `type`, `both` |
| `showBodyDeps` | true | `term`, `both` |

They combine by AND with `showInnerCalls` for inner links and with `showSpecLinks` for spec links. Links without a role (`mapping`, graphs without split data) always pass them. Unlike the other link toggles, they restrict **traversal**: `selectNodes` drops the links they reject (`TraversalPredicates.linkFilter`), and the seeded view expands over `roleFilteredGraph`. With A -term→ B -type→ C and body/proof off, a query from A does not reach C. The checkboxes only appear when the graph has role data.

### 3.9 Display Predicates

Applied **after** traversal, so they don't affect reachability:

| Toggle | Default | Filters on |
|--------|---------|------------|
| `showLibsignal` / `showNonLibsignal` | true | `is_libsignal` |
| `showVerifiedNodes` | true | `verified`, `transitively-verified`, `trusted` |
| `showFailedNodes` | true | `failed` |
| `showUnverifiedNodes` | true | `unverified` or no status |
| `exactStatuses` | null | when set (by a Guide action), only these statuses pass; overrides the three toggles above. Toggling a box keeps the exact selection of the other groups (`src/status-filter.ts`) |
| `showRustNodes` / `showLeanNodes` | true | node `language` (post-traversal so BFS can pass through cross-language nodes) |

### 3.10 Max Depth (`maxDepth`)

Limits BFS traversal depth for `callees`, `callers`, and `neighborhood` queries. `null` or `0` means unlimited. Does **not** limit path finding.

### 3.11 Click-Based Selection (`selectedNodes`)

When no source/sink/include-files are active and `maxDepth` is set, clicking a node triggers `depthFromSelected` — bidirectional BFS from the clicked node.

### 3.12 Hidden Nodes (`hiddenNodes`)

Shift+click hides a node. Hidden nodes are excluded during the traversal-predicate phase (step 1), preventing them from appearing in any result.

---

## 4. Pipeline Steps

The `executeQuery` function runs 7 steps (plus a 5b):

### Step 1 — Build traversable subgraph

```
selectNodes(fullGraph, traversalPredicates) → traversableGraph
```

Keeps only nodes that pass **all** traversal predicates: kind filter, exclude-name, exclude-path, include-file, hidden-nodes, build-artifact exclusion. Links rejected by the statement / body-or-proof toggles are dropped here (§3.8).

### Step 2 — Resolve matchers

```
resolveNodeMatcher(matcher, fullGraph, traversableIds) → Set<string>
```

Patterns are matched against the **full** graph (so a user can find a node even if it shares a name with a filtered-out node), then the result is intersected with the traversable set.

### Step 3 — Dispatch traversal

Based on the `GraphQuery.type`, one of 6 traversal paths is taken:

| Query type | Operator(s) used |
|-----------|-----------------|
| `callees` | `traverseForward` (BFS, per start node, merged) |
| `callers` | `traverseBackward` (BFS, per start node, merged) |
| `neighborhood` | `traverseForward` + `traverseBackward`, union |
| `paths` | `findPaths` (DFS with backtracking) |
| `crateBoundary` | `crateBoundary` (edge scan) |
| `depthFromSelected` | `traverseBidirectional` (undirected BFS) |
| `noTraversal` | Focus set, exact ID set, or full traversable set |

Each traversal returns a `TraversalResult` carrying `nodeIds` plus optional side-channel data (`calleeDepths`, `callerDepths`, `boundaryLinkPairs`).

### Step 4 — Assemble result nodes

Filter `fullGraph.nodes` to only those whose `id` is in the traversal result's `nodeIds`.

### Step 5 — Apply display predicates

Post-traversal filtering: libsignal/non-libsignal toggle, verification-status filters, language filters (Rust/Lean), plus re-application of kind filter and hidden-node exclusion (since step 4 pulls from the full graph).

### Step 5b — Apply result file filter

When a directional query is combined with `includeFiles`, the file patterns are applied here instead of in `selectNodes` (see §3.4). Source/sink seed nodes are kept regardless of file.

### Step 6 — Filter links

Three passes over links:

1. **Endpoint filter** — keep only links where both source and target are in the result node set.
2. **Depth filter** — when a depth limit is active, keep only BFS-tree edges (no shortcut edges). Uses `calleeDepths` / `callerDepths` from the traversal result.
3. **Link type filter** — apply `showInnerCalls`, `showPreconditionCalls`, `showPostconditionCalls`, `showMappingLinks`, `showSpecLinks`, and for inner and spec links the role toggles.

For `crateBoundary` queries, only links whose `(source, target)` pair is in `boundaryLinkPairs` survive step 1.

### Step 7 — Cleanup and build metadata

1. **Remove isolated nodes** — nodes with no remaining edges, except focus-set and exact intent IDs (anchors). Skipped for an exact status selection without a query, so every matching node shows.
2. **Build `nodeDepths`** — a `Map<string, number>` attached to the result `D3Graph` for depth-based layout coloring. Merged from forward/backward traversal depths, taking the minimum when a node appears in both.
3. **Deep copy** — nodes and links are shallow-cloned to prevent D3's force simulation from mutating the original graph.

---

## 5. Operators

Nine pure functions in `query.ts`, each taking a graph (or its parts) and returning a new structure:

| Operator | Signature | Algorithm |
|----------|-----------|-----------|
| `selectNodes` | `(graph, predicates) → D3Graph` | Linear scan, predicate conjunction |
| `traverseForward` | `(graph, startIds, maxDepth) → TraversalResult` | BFS on forward adjacency |
| `traverseBackward` | `(graph, startIds, maxDepth) → TraversalResult` | BFS on reverse adjacency |
| `traverseBidirectional` | `(graph, centerIds, maxDepth) → TraversalResult` | BFS on undirected adjacency |
| `findPaths` | `(graph, sourceIds, sinkIds) → TraversalResult` | DFS with backtracking |
| `crateBoundary` | `(graph, srcCrate, tgtCrate) → TraversalResult` | Edge scan matching crate pairs |
| `filterLinksByType` | `(links, filter) → D3Link[]` | Type predicate |
| `depthFilterLinks` | `(links, calleeDepths?, callerDepths?) → D3Link[]` | BFS-tree edge predicate |
| `removeIsolated` | `(nodes, links, keepSet?) → D3Node[]` | Connected-component filter |

All operators are individually testable; none depend on global state.

---

## 6. Key Design Decisions

### 6.1 Dual-role focus nodes

A focus set is one kind of intent, so it cannot combine with a source/sink query: any other intent replaces it. Its IDs restrict `noTraversal` and survive isolated-node removal.

### 6.2 Traversal predicates vs. display predicates

**Traversal predicates** (kind, exclude-name, exclude-path, include-file, hidden, build-artifact) are applied *before* traversal in step 1. They determine the reachable subgraph. Exception: with a directional query, the include-file patterns move to step 5b (§3.4) so they narrow results without cutting the traversal.

**Display predicates** (libsignal/non-libsignal, verification status, language) are applied *after* traversal in step 5. They don't affect reachability: a path through a libsignal or Lean node is still found, but the node itself may be hidden from the result.

### 6.3 Full-graph matcher resolution

`resolveNodeMatcher` matches patterns against the **full** graph, not the traversable subgraph. This prevents confusing situations where a function "exists" but can't be found because some predicate filtered it out. The matched IDs are then intersected with the traversable set to ensure only valid start nodes are used.

### 6.4 VS Code exact node

When VS Code sends a `selectedNodeId` that exists in the graph, the viewer sets an exact `ids` intent; the direction follows which of `initialQuery.source` / `sink` is present (source only: callees, sink only: callers, both: neighborhood). If the ID is not in the graph (e.g., stale index), it falls back to a text intent from the query strings.

### 6.5 TraversalResult side-channel

Rather than encoding depth information in the node objects, traversal operators return a `TraversalResult` with optional `calleeDepths`, `callerDepths`, and `boundaryLinkPairs` maps. The executor uses these for depth-based link filtering (step 6) and for the `nodeDepths` metadata attached to the final graph (step 7).

### 6.6 Compiler purity

`compileQuery` is a pure function — it takes `FilterOptions` and returns a `CompiledQuery` with no graph access. This makes it trivially testable and allows potential future caching of compiled queries.

---

## 7. URL Parameters

Filter state is encoded in shareable URLs by `writeURLState` / `readURLState` (`src/url-state.ts`). Reload and browser back both rebuild the state from defaults plus the URL. Guide actions push a history entry. The first source/sink edit on a Guide entry also pushes; later typing replaces. Other filter edits replace the entry and keep its marker.

Query intent (exactly one is written):

| Parameter | Intent | Example |
|-----------|--------|---------|
| `source` / `sink` | `text` | `?source=decompress` |
| `id` (repeated) + `dir` + `label` | exact `ids` (`dir`: `none`, `callers`, `callees`, `both`) | `?id=probe:A&dir=callers&label=A` |
| `focus` | focus-set JSON URL, fetched after load → focus `ids` intent | `?focus=./focus.json` |
| `boundary-source` / `boundary-target` | `boundary` (exact group names) | `?boundary-source=a&boundary-target=b` |

When an old or hand-edited URL has several, the precedence is `id` > `focus` > `boundary-*` > `source`/`sink`.

Other state:

| Parameter | FilterOptions field / target | Example |
|-----------|------------------------------|---------|
| `sel` (repeated) | `selectedNodes` (click selection) | `?sel=probe:A` |
| `files` | `includeFiles` | `?files=edwards.rs,scalar.rs` |
| `depth` | `maxDepth` (0 = unlimited, omitted for the default 1) | `?depth=3` |
| `exec` / `proof` / `spec` | `showExecFunctions` / `showProofFunctions` / `showSpecFunctions` (0/1) | `?spec=1` |
| `axioms` / `types` / `proj` / `inst` | `showAxioms` / `showTypes` / `showProjections` / `showInstances` (0/1) | `?types=1` |
| `inner` / `pre` / `post` | `showInnerCalls` / `showPreconditionCalls` / `showPostconditionCalls` (0/1) | `?pre=1` |
| `mapping` / `speclinks` | `showMappingLinks` / `showSpecLinks` (0/1) | `?mapping=0` |
| `statement` / `body` | `showStatementDeps` / `showBodyDeps` (0/1) | `?body=0` |
| `libsignal` / `external` | `showLibsignal` / `showNonLibsignal` (0/1) | `?external=0` |
| `rust` / `lean` | `showRustNodes` / `showLeanNodes` (0/1) | `?lean=0` |
| `verified` / `failed` / `unverified` | `showVerifiedNodes` / `showFailedNodes` / `showUnverifiedNodes` (0/1) | `?unverified=0` |
| `status` | `exactStatuses` (comma-joined); the three toggles are derived from it | `?status=transitively-verified` |
| `excludeName` | `excludeNamePatterns` | `?excludeName=*_comm*` |
| `excludePath` | `excludePathPatterns` | `?excludePath=*/specs/*` |
| `hide` (repeated) | `hiddenNodes` (IDs) | `?hide=probe:A` |
| `hidden` | legacy, read only: comma-joined display names, each resolved to its first match | `?hidden=foo,bar` |
| `entrypoints` | entry-point JSON URL for the seeded view, fetched after load | `?entrypoints=./ep.json` |
| `view` | active view (module state) | `?view=crate-map` |
| `source-crate` / `target-crate` | crate dropdown / Crate Map highlight only, not a query | `?source-crate=libsignal-core` |

A link with only `source-crate` / `target-crate` no longer runs a boundary query; old links that also carry `crate:` source/sink load as a text intent.

Graph-source parameters (`json` / `url`, `github`, `github_prefix` / `prefix`) are handled separately in `autoLoadGraph()` and are preserved when the share link is generated.

When the project language is Lean, the generator omits `inner`, `pre` and `post`: those toggles are hidden and forced on for Lean graphs. `mapping`, `speclinks`, `statement` and `body` are written for every language.

---

## 8. Testing

Run everything with `npm run test:run` (vitest) and `npx playwright test` (e2e). The suites relevant to the pipeline:

- **Unit tests** (`query.test.ts`): individual operators, the compiler, and the resolver on small hand-crafted graphs — kind/exclude/hidden predicates, maxDepth, path finding, dispatch rules, exact-override fallback.
- **Golden tests** (`query.integration.test.ts`): real graph data (Verus SCIP graph, Verus atoms, Lean atoms) through `applyFilters`, asserting exact output counts and node presence as a regression baseline.
- **Backward-compatibility tests** (`filters.test.ts`): the pre-refactor suite for `applyFilters`, `matchesQuery`, `globToRegex`, `pathPatternToRegex`; passes unchanged.
- Adjacent suites: `graph-utils.test.ts` (seed tiers, budgeted expansion), `graph-loader.test.ts` (format normalization, entry-point derivation), `graph.test.ts` (fit transform, depth), and the Playwright specs in `e2e/`.

---

**Last updated:** September 2026
