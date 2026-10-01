# Query pipeline

How the viewer turns filter state into the rendered subgraph. User-facing
behaviour (match syntax, URL parameters) is in
[docs/guides/viewer.md](../docs/guides/viewer.md); the design record for query
intent is [docs/archive/query-intent.md](../docs/archive/query-intent.md).

## 1. Overview

The pipeline follows a **compile → execute** pattern, separating *what* the
user asked from *how* it is evaluated:

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
  │  Executor  │  executeQuery(compiled, fullGraph) → D3Graph
  └──────┬─────┘
         │  7 pipeline steps (see §4)
         ▼
     D3Graph (filtered result)
```

### Source files

| File | Role |
|------|------|
| `src/query.ts` | Query AST, operators, resolver, compiler, executor |
| `src/intent.ts` | `QueryIntent`: what the query is about (text, exact IDs, focus set, boundary) |
| `src/url-state.ts` | URL codec (`writeURLState` / `readURLState`) and `defaultFilters()` |
| `src/status-filter.ts` | Verification status groups and the exact-status predicate |
| `src/types.ts` | `FilterOptions`, kind sets, `compileKindPredicate` / `compileKindFlag` |
| `src/filters.ts` | Public entry point (`applyFilters`), pattern utilities (`globToRegex`, `matchesQuery`) |

The public API is one function, which calls `compileQuery` then
`executeQuery`:

```typescript
function applyFilters(
  fullGraph: D3Graph,
  filters: FilterOptions,
  projectLanguage?: ProjectLanguage,
): D3Graph
```

`compileQuery` is pure: it takes `FilterOptions` and returns a
`CompiledQuery` without touching the graph.

## 2. Query AST

The compiler translates `FilterOptions` into a discriminated union,
`GraphQuery`, that encodes the traversal mode:

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

A `NodeMatcher` identifies the start nodes:

```typescript
type NodeMatcher =
  | { kind: 'pattern'; query: string }   // substring or glob against display_name
  | { kind: 'crate';   pattern: string } // crate: prefix query
  | { kind: 'nodeIds'; ids: Set<string> } // exact IDs (Guide, VS Code, cross-layer links)
```

### Dispatch rules

`compileQuery` switches on `filters.intent`:

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
| different | different | `paths` (DFS from every source to every sink) |

`crateBoundary` keeps the links whose caller is in the source crate and
callee in the target crate, plus their endpoints.

## 3. Filters

Defaults for every field are in `defaultFilters()` (`url-state.ts`); match
syntax for source/sink is in the viewer guide.

### 3.1 Include Files (`includeFiles`)

Comma-separated file patterns. Patterns without `/` match `file_name`;
patterns with `/` match `relative_path` (`**` crosses directories). Without a
source/sink query, only nodes in matching files pass the traversal predicate.
With a directional query the patterns instead run **after** traversal
(step 5b): the BFS uses the full graph, results are narrowed to the files, and
the source/sink seed nodes are kept so the connection stays visible.

### 3.2 Exclude patterns

`excludeNamePatterns` globs match `display_name`. `excludePathPatterns` globs
match the node's `id`, not its path
([#61](https://github.com/Beneficial-AI-Foundation/probegraph/issues/61)).

### 3.3 Kind filters

Seven buckets: exec (everything not in another bucket), proof, spec, axioms,
types (`structure`, `inductive`, `class`), projections and instances.
`compileKindFlag` maps a kind to its `show*` flag using
`getKindSetsForLanguage`; the proof bucket is `proof` for Verus, `theorem`
for Lean, both for mixed graphs, and `blueprint-theorem` on the blueprint
layer.

### 3.4 Link type filters

`LinkTypeFilter` has five type toggles: `showInnerCalls` (body calls),
`showPreconditionCalls` (`requires`), `showPostconditionCalls` (`ensures`),
`showMappingLinks` (Rust↔Lean) and `showSpecLinks` (Lean spec theorem →
definition). Requires/Ensures edges usually target spec functions, so they
show only with Spec functions on too.

Lean `inner` links carry a `role` when probe-lean emits the
`type-dependencies` / `term-dependencies` split: `type` (statement), `term`
(definition body or proof, plus names reached through auxiliary declarations,
including ones in the type) or `both`. Blueprint links use the same roles for
statement and proof uses. A `spec` link takes the role of the theorem's inner
link to the definition. `showStatementDeps` passes `type` and `both`;
`showBodyDeps` passes `term` and `both`.

The role toggles combine by AND with `showInnerCalls` for inner links and with
`showSpecLinks` for spec links; links without a role always pass them. Unlike
the type toggles, they restrict **traversal**: `selectNodes` drops the links
they reject (`TraversalPredicates.linkFilter`), and the seeded view expands
over `roleFilteredGraph`. With A -term→ B -type→ C and body/proof off, a query
from A does not reach C.

### 3.5 Display predicates

Applied after traversal, so they don't affect reachability:

- `showLibsignal` / `showNonLibsignal` on `is_libsignal`;
- the status toggles, or `exactStatuses` when a Guide action set one
  (`status-filter.ts`; toggling a box keeps the exact selection of the other
  groups);
- `showRustNodes` / `showLeanNodes` on `language`. Blueprint nodes ignore
  them.

### 3.6 Depth, selection, hidden nodes

`maxDepth` limits BFS depth for `callees`, `callers`, `neighborhood` and
`depthFromSelected`; `null` or `0` is unlimited. It does not limit path
finding. Clicked nodes (`selectedNodes`) drive `depthFromSelected` only with
no intent, no include files and a finite depth. `hiddenNodes`
(Shift+click) are removed in step 1 and again in step 5.

## 4. Pipeline steps

`executeQuery` runs seven steps, plus a 5b.

1. **Build the traversable subgraph.** `selectNodes(fullGraph,
   traversalPredicates)` keeps nodes that pass kind, exclude-name,
   exclude-path, include-file, hidden and build-artifact (`target/`,
   `build/`) predicates, and drops links rejected by the role toggles.
2. **Resolve matchers.** `resolveNodeMatcher` matches patterns against the
   **full** graph, then intersects with the traversable set, so a function
   that exists but is filtered out isn't confused with a missing one.
3. **Dispatch traversal** on `GraphQuery.type` (operators in §5):
   `callees` / `callers` run per-start-node BFS merged at minimum depth,
   `neighborhood` unions both, `paths` uses `findPaths`, `crateBoundary`
   scans edges, `depthFromSelected` uses undirected BFS, and `noTraversal`
   takes the focus set, exact set or whole traversable set. Each returns a
   `TraversalResult` with `nodeIds` and optional `calleeDepths`,
   `callerDepths` and `boundaryLinkPairs`.
4. **Assemble result nodes** from `fullGraph` by `nodeIds`.
5. **Display predicates** (§3.5), then re-apply the kind filter (except for
   `noTraversal`) and hidden nodes, since step 4 reads the full graph.
   - **5b.** With a directional query and include files, apply the file
     patterns here (§3.1).
6. **Filter links**: keep links with both endpoints in the result (only
   `boundaryLinkPairs` for `crateBoundary`); with a finite depth keep only
   BFS-tree edges (`depthFilterLinks`); then apply `filterLinksByType`.
7. **Cleanup**: remove isolated nodes, except focus-set and exact-intent
   anchors and blueprint entries; skipped for an exact status selection
   without a query so every matching node shows. Build `nodeDepths` for
   layout from the traversal depths (minimum when a node has both), and
   shallow-clone nodes and links so D3 can't mutate the source graph.

## 5. Operators

Nine pure functions in `query.ts`, none depending on global state:

| Operator | Signature | Algorithm |
|----------|-----------|-----------|
| `selectNodes` | `(graph, predicates) → D3Graph` | Linear scan, predicate conjunction |
| `traverseForward` | `(graph, startIds, maxDepth) → TraversalResult` | BFS on forward adjacency |
| `traverseBackward` | `(graph, startIds, maxDepth) → TraversalResult` | BFS on reverse adjacency |
| `traverseBidirectional` | `(graph, centerIds, maxDepth) → TraversalResult` | BFS on undirected adjacency |
| `findPaths` | `(graph, sourceIds, sinkIds) → TraversalResult` | DFS with backtracking |
| `crateBoundary` | `(graph, srcCrate, tgtCrate, exact) → TraversalResult` | Edge scan matching crate pairs |
| `filterLinksByType` | `(links, filter) → D3Link[]` | Type and role predicate |
| `depthFilterLinks` | `(links, calleeDepths?, callerDepths?) → D3Link[]` | BFS-tree edge predicate |
| `removeIsolated` | `(nodes, links, keepSet?) → D3Node[]` | Drop nodes without links |

## 6. Design decisions

**Focus sets are an intent.** A focus set cannot combine with a source/sink
query: any other intent replaces it. Its IDs restrict `noTraversal` and
survive isolated-node removal.

**Traversal vs display predicates.** Traversal predicates (kind, excludes,
include files, hidden, build artifacts, role toggles) apply before traversal
and decide what is reachable. Display predicates (source type, status,
language) apply after, so a path through a hidden-by-status or Lean node is
still found even if the node itself is not shown. Include files is the one
predicate that moves: with a directional query it becomes a result filter
(§3.1).

**Full-graph matcher resolution** (step 2) avoids "this function exists but
can't be found" when a predicate filtered it.

**Depths travel beside the nodes.** Traversal returns depth maps in
`TraversalResult` rather than writing them onto nodes; the executor uses them
for depth-based link filtering and the `nodeDepths` it attaches to the result.

The VS Code exact-node rule (how `selectedNodeId` picks a direction) is in
[vscode-extension.md](../docs/guides/vscode-extension.md#message-protocol).

## 7. URL state and history

`writeURLState` / `readURLState` (`url-state.ts`) are the only URL codec.
Reload and browser back both rebuild the state from `defaultFilters()` plus
the URL, and only non-default values are written. Every param the viewer owns
is listed in `OWNED_PARAMS` and deleted before writing; graph-source params
(`json` / `url`, `github`, `github_prefix` / `prefix`) are not owned, so they
survive into share links. The full parameter table is in the
[viewer guide](../docs/guides/viewer.md#sharing-copy-link-and-url-parameters).

Exactly one query intent is written: `source` / `sink` (text), `id` + `dir` +
`label` (exact IDs), `focus` (a focus-set URL, resolved after load) or
`boundary-source` / `boundary-target`. When a hand-edited URL has several,
the precedence is `id` > `focus` > `boundary-*` > `source`/`sink`.
`source-crate` / `target-crate` only set the crate dropdowns and Crate Map
highlight; they never run a query. Other non-filter state: `view`, `layer`
(only for graphs with a blueprint layer, and only when not the default
layer), `expanded` (Hierarchy groups) and `entrypoints`. The legacy `hidden`
(display names) is still read; the legacy `exclude` is owned, so it is
cleared on write, but never read. For Lean graphs `inner`, `pre` and `post`
are not written, since those boxes are hidden.

### History and async loads

Query changes go through `setIntent` in `main.ts`, which makes exactly one
history write per intent change; `urlWritesSuppressed` stops the render from
writing a second one. Layer switches and browser back restore state the same
way, with one write of their own. Guide actions, layer switches and
cross-layer navigation push an entry marked `{ pushed: true }` in
`history.state`. Typing in source/sink over a pushed
entry pushes once (`inputEditHistory`), and later typing replaces. Other
filter edits replace the current entry and keep its marker.

Async loads check a token before committing, so late responses are dropped:

- `intentGeneration` is bumped by every intent change. A `?focus=` load
  records it in `pendingFocus` and is dropped if it moved.
- `graphLoadGeneration` is bumped by every `loadGraph()`. `?entrypoints=`
  loads check it so a late payload can't apply to a different graph.
- `graphRequest` is bumped by every graph-source request (auto-load, file
  pick, deferred load), so a slow auto-load can't replace a file the user
  picked meanwhile.

## 8. Tests

`query.test.ts` covers operators, the compiler and the resolver on small
graphs; `query.integration.test.ts` runs real Verus and Lean graphs through
`applyFilters` as golden tests; `filters.test.ts`, `intent.test.ts` and
`status-filter.test.ts` cover the pattern utilities, intents and status
filter. Run them with `npm run test:run` (see [README.md](README.md)).
