# Viewer: search and reveal

Status (2026-10-15): Phase 0 merged in #80. `revealNode` in
`src/main.ts` serves the editor; the search half has no UI caller yet and
is reached in e2e tests through the dev-only `window.__revealNode` hook.
Phase 1 is in progress as three PRs (decided 2026-10-15): 1 the index and
ranking (`src/search.ts`, no UI), 2 the search box and result list, 3 the
source-set plus sink-set intent. Phase 2 needs Phase 1. Its `rank by dependents` verb
reuses the guide Phase 4 count (merged in #81). Its frontier and
"assumptions under X" presets need `trust-and-frontier.md` Phases 2 and 1.

Goal: find a declaration by words rather than regex, and make the hit
usable when the viewer is not showing it. Then ask structural questions
of the graph (most connected, no callers, paths between modules) with a
short text query instead of jq.

Background: browser find is no help in the viewer. Labels are abbreviated
(`display_name`), a filtered-out node has no element, and the Call Graph is
a camera over an SVG, so a match can exist and sit off-screen. The editor
already has a reveal path: `applyEditorSelection` in `src/main.ts`
switches to the code layer and Call Graph, unhides the node, sets an
exact-ID intent at the requested depth and reports `shown` or `filtered`
with the keys from `filtersHiding` (`src/editor-selection.ts`); the
extension answers `filtered` with a `relaxFilters` message that applies
`relaxations`. Search needs the same path plus centring, and must not
duplicate it.

## Phase 0: one reveal path

Extract `revealNode(id, options)` from `applyEditorSelection` and route
both callers through it.

- **Reasons a node is not visible**, reported as distinct values with one
  action each:
  - `missing`: not in `state.fullGraph`. No action.
  - `other-layer`: in the blueprint layer, or the code layer while blueprint
    is active. Action: switch layer.
  - `filtered`: a node filter hides it; which ones from `filtersHiding`.
    Action: relax exactly those keys (the `relaxations` path).
  - `outside-intent`: passes the filters but the current intent's traversal
    does not reach it. Action: replace the intent (below) or add it as an
    anchor.
  - `truncated`: dropped by the 200-node cap. Action: make it an anchor so
    BFS truncation keeps it (guide plan, Phase 4), query the node instead,
    or raise the cap.
  - `shown`: nothing to do except centre.
  The classification runs on `state.fullGraph`, never on the DOM, and node
  details open for any node the graph has, element or not.
- **Intent policy.** Editor: unchanged (exact-ID intent at the given depth,
  history `replace`). Search, default: replace the intent with an exact-ID
  intent on the hit at the current depth, one history entry, only when the
  current query does not reach the hit. A query that reaches it stays, so
  a hit that the view already draws keeps the user's context. A truncated
  hit offers "Query this node instead", which always draws it (truncation
  never cuts a lone anchor). Decided 2026-10-14. Search, "as source" /
  "as sink": extend the current intent's anchor set instead. No new query
  semantics: a source hit and a sink hit are the existing source/sink
  query.
- **Relaxing filters is explicit.** The viewer never relaxes on its own; it
  offers the action and the user clicks. The relaxation is one history
  entry so Back restores the filters. When the relaxed filters let the
  search policy replace the intent, the relaxation and the new intent
  share that one entry.
- **Stale results.** A reveal counter: each `revealNode` increments it and
  the asynchronous steps (layout settle, camera transition end, the toast)
  check it and drop out when a later reveal has started. Graph reload
  increments it too. Codex's case: search picks A, the editor selects B
  while A's layout settles, A's callback centres A over B's selection. A
  newer reveal also stops the reveal's own camera move in progress. A
  toast action records the URL state it was computed for. A click when
  the URL state differs only says that the view changed. A reveal first
  runs a debounced filter apply that is still waiting (source/sink typing
  on a large graph), so it never classifies against an old render.
- **Centre on node.** `fitToView` in `src/graph.ts` is private and fits the
  whole result (or centres on the focus node when the result is too big).
  Add a public `centerOn(id)` that pans and zooms to one node at a readable
  scale with the same 400 ms transition; `revealNode` calls it once the
  force layout settles, or after 1.5 s at most, and once more when the
  layout stops (8 s at most), since the node can drift after the first
  move. Any other camera move in the meantime (the user, Reset View, a
  query's fit) or a change of the URL state cancels the centring. The
  camera move itself checks the URL state on every frame, because a query
  that draws the same nodes starts no fit that would stop it.
- **History.** A search reveal on the other layer pushes one entry for the
  switch. A new intent replaces that entry, so one Back restores the
  layer and its query.
- **Toasts.** `#toast-container` is a polite live region, so screen
  readers announce why a hit is not drawn and the action labels. A toast
  with actions stays while it has the pointer or the keyboard focus.
- Tests: reason classification on `probe-lean-extract-cut.json` for each
  of the six values; two reveals in a row where the first one's completion
  is a no-op; the editor integration tests in `vscode/` keep passing.
  `web/e2e/reveal.spec.ts` drives the toast actions, their history
  entries, the raised cap and centring through a dev-only
  `window.__revealNode` hook until the search box calls `revealNode`.

## Phase 1: lexical search

- **Index**, built in the browser from `state.fullGraph` on load: full ID,
  `display_name`, identifier tokens (`mul_by_pow_2` → mul, by, pow, 2;
  camel case and dots split too), module path segments, statement names
  (`type-dependencies` and `-external`; Verus `requires-dependencies` and
  `ensures-dependencies`), docstrings when the extract carries them (none
  does today). Built in chunks or an idle callback so a 10k-node graph does
  not block load; size and build time measured on the largest graph we
  have.
- **Ranking.** Start with exact ID, then prefix and substring on tokens,
  ordered by match position and ID. Before adding BM25, write about twenty
  queries for SPQR with the expected hit (a test fixture, kept) and score
  recall@5 for substring against BM25. Add BM25 only if it wins on that
  set. Codex's point: the ranking is the least certain part and the
  cheapest to measure.
  Result (2026-10-15): 22 queries in `src/test-data/spqr-search-queries.json`,
  written before the ranking, on the full SPQR extract (3508 atoms) cut
  to names, kinds and paths (`spqr-aeneas-search-cut.json`, 0.7 MB).
  Lexical: recall@5 22/22, recall@1 21/22. BM25 (name tokens weighted 3,
  path tokens 1): recall@5 22/22, recall@1 22/22. BM25 does not win on
  recall@5, so lexical stays. The order: whole query equal to the ID, then
  equal to the display name, then the sum of the token costs (name before
  module path before statement names; exact token before prefix before
  substring), then position in the name, name length and ID. An exact ID
  ranks above an exact display name because a display name can name
  several nodes.
- **Build time.** On the largest local graph (22109 nodes, 48923 links)
  the index builds in about 65 ms in Node and holds about 400k tokens. A
  query takes 7 to 28 ms. The build is short enough to run in one piece,
  so PR 2 builds the index on the first focus of the search box rather
  than in chunks at load.
- **UI.** A search box in the toolbar; a result list with display name,
  kind, status and module; Enter reveals the top hit; each row has reveal,
  "as source" and "as sink". Reveal goes through Phase 0 and shows the
  reason and action when the hit is not visible. Keyboard access: a key
  in the search box moves the focus to the toast's first action, since
  the toast sits at the end of the page. Nothing shows an action toast
  before the search box (the editor reveal offers none), so Phase 0 has
  no such key.
- **Source and sink sets together.** In Phase 0, "as source" on top of a
  sink set (or the reverse) starts a new set, because `ExactIntent` holds
  one ID set and one direction. Add an intent with a source ID set and a
  sink ID set that compiles to the existing `paths` query with two
  `nodeIds` matchers. The AST already supports this, so it is no new
  query semantics. Decided 2026-10-13.
- Tests: tokenizer cases (snake, camel, dotted, digits, Lean namespaces
  with `«»`), the query fixture, and a reveal of a filtered hit ending in
  the relax action.

## Phase 2: structural queries

Questions like "the ten most connected declarations", "lemmas nobody
uses" and "paths from module X to module Y" have no input today. jq can
answer the first one but not the other two without recursive scripts.

- **No external engine.** Cypher (Neo4j, or an embedded engine in WASM)
  reads well. But it does not know the kind, status, link-type and role
  rules that `src/query.ts` applies. Its answers then disagree with the
  view. Extend the existing `GraphQuery` AST instead.
- **Two result shapes.** A ranking or a selection returns a node list,
  shown in the Phase 1 result list with the same reveal, "as source" and
  "as sink" actions. A traversal returns a subgraph through the existing
  executor. New query types:
  - `rank`: top N by direct callers, direct callees, or unique transitive
    dependents (the Phase 4 count in `viewer-filters-and-guide.md`, one
    implementation). Ties break by ID.
  - `select`: nodes matching a predicate, ordered by ID. First predicate:
    `noCallers` (in-degree 0 in the visible relation).
  - `paths` between two node sets already exists (`findPaths`). Add a
    `module` matcher next to `crate` so the sets can be module paths.
- **Syntax.** One verb, then the filter words the viewer already has.
  The grammar maps one to one onto the AST and stays small enough that a
  later LLM layer can produce it from English:

  ```
  top 10 by dependents kind:lemma
  unused kind:proof module:field
  paths from module:edwards to module:field
  ```

  Only `crate:` exists as a prefix today (`matchesQuery` in
  `src/filters.ts`). Add `kind:`, `status:`, `module:` and `file:` there,
  so the search box and the query box share one parser.
- **"Unused" is not "isolated".** An unused lemma calls other lemmas, so
  its degree is above zero. `unused` is `noCallers` minus entry points
  (`is_entry_point`) and minus top-level theorems the user marks as
  goals. True singletons (degree 0) are a separate, rarer `select`.
- **Isolated results must stay visible.** `removeIsolated` drops nodes
  with no visible links, so a subgraph of `unused` nodes renders empty.
  Node-list results bypass it. Subgraph results keep the anchors (the
  fix already planned in guide Phase 4).
- **Guide presets.** The Guide lists (`topConnected`,
  `unverifiedHotspots`, `failedNodes`) become saved queries in this
  syntax, and clicking one fills the query box. The user can then edit
  it, for example add `module:`.
- **First presets.** Chosen for an engineer who explores a new project:
  each answers a question the Guide cannot answer today, and each needs
  at most one new predicate.
  - Surface: public API (`is_public_api`) without a contract. In Verus,
    exec functions with no `requires` or `ensures` edges. In Aeneas
    projects, Rust functions with no Lean translation (`mapping_id`
    empty) and Lean defs with no spec theorem (`specs` empty).
  - Frontier: unfinished nodes whose dependencies are all done. The
    definition and counts come from `trust-and-frontier.md` Phase 2.
  - Blockers of X: the unfinished nodes in the dependency cone of one
    target.
  - Module matrix: edge counts from module to module, the crate
    boundary at module level. A table, not a node list.
  - Unused: as defined above.
- **Level filter.** `level:N` selects the nodes at dependency level N
  (level 0 has no dependencies, as in the Guide Dependency levels strip).
  It combines with the other filters, for example `level:0 kind:lemma
  status:unverified`. This replaces a click on a level in the strip,
  which stays display-only, because one level can exceed the render cap.
  Decided 2026-10-13.
- **Later presets.** Dependency levels and the longest chain from an entry point.
  Mutual-recursion groups (SCCs of size two or more). Assumptions under
  X (axioms, trusted, `external_body`, from `trust-and-frontier.md`
  Phase 1). Largest declarations by line count and highest fan-out.
  Lemmas used exactly once. Near-duplicates from `similar_lemmas`. Spec
  functions that no contract uses. In Lean, lemmas that appear in
  statements against lemmas that appear only in proofs (guide Phase 2
  edge roles).
- Tests: parser round trip (text → AST → text) for each verb. `unused` on
  a fixture with an entry point and a lemma that only calls others.
  `paths` between two modules on `probe-lean-extract-cut.json`. A rank
  that matches the Guide count for the same graph.

## Later (not scheduled)

- **Embeddings**, only if lexical misses too much in practice.
  `verus_lemma_finder` already indexes vstd and curve25519-dalek and
  documents adding a project, so the indexing side exists for Verus. The
  cost is not the vectors (384-dimensional int8, about 4 MB for 10k nodes)
  but the query side: model and tokenizer assets, runtime memory and
  first-query latency in the browser, or precomputed vectors for suggested
  queries only, which does not answer arbitrary queries. Document and query
  must use the same model revision and preprocessing.
- **Snapshots.** When the viewer loads a sequence of extracts
  (the planned concept-discovery document, Later), "not in this snapshot" is one
  more reveal reason, answered by moving to the first snapshot that has it.
