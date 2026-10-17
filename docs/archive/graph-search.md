# Viewer: search and reveal

Status (2026-10-17): done, archived. Phase 0 merged in #80. `revealNode` in
`src/main.ts` serves the editor and the search box.
Phase 1 is done, in three PRs: 1 the index and ranking (`src/search.ts`,
no UI, #89), 2 the search box and result list (`src/search-box.ts`,
which replaces the dev-only `window.__revealNode` hook in the e2e tests,
#91), 3 the source-set plus sink-set intent (`idPaths` in
`src/intent.ts`, #93). Phase 2 was pruned on 2026-10-16 to two PRs.
PR 1 (query words and `paths`, `src/query-words.ts`) merged in #97.
PR 2 (`top N by dependents`, the `is:` words, Show all and the Guide
query buttons) merged in #101. `by dependents` reuses the guide Phase 4
count (merged in #81). `is:frontier` moved to `trust-and-frontier.md`
Phase 2. The Later items below are issue #102.

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
  than in chunks at load. The name and path also keep their unsplit
  segments, so `keyhistory` finds `KeyHistory`. On a 13544-node graph this
  took the build from about 40 ms to about 80 ms, and queries stayed
  within about 10% because a query token no longer scans the path and
  statement tokens once the name matches. Recall did not change.
- **UI.** A search box in the toolbar; a result list with display name,
  kind, status and module; Enter reveals the top hit; each row has reveal,
  "as source" and "as sink". Reveal goes through Phase 0 and shows the
  reason and action when the hit is not visible. Keyboard access: a key
  in the search box moves the focus to the toast's first action, since
  the toast sits at the end of the page. Nothing shows an action toast
  before the search box (the editor reveal offers none), so Phase 0 has
  no such key.
  Decisions in PR 2 (2026-10-15): the box sits in the header and `/`
  focuses it from outside a text field, since a search box is the first
  thing a new user looks for. The index covers both layers, so a hit on
  the layer not shown switches layer through Phase 0. The toast key is
  Alt+Enter: Alt with a letter opens browser menus in Firefox on Linux
  and Windows, and Enter already reveals. The row shows the file path
  where this plan said module: IDs have no common module syntax across
  Rust, Lean and blueprint extracts, and the file path tells apart nodes
  with one display name (SPQR has a dozen `mvcgen_spec`). The list shows
  20 rows and says when there are more. Every row action reveals with
  the toast and with centring; the list closes and the focus returns to
  the box, so Alt+Enter reaches the toast.
- **Source and sink sets together.** In Phase 0, "as source" on top of a
  sink set (or the reverse) starts a new set, because `ExactIntent` holds
  one ID set and one direction. Add an intent with a source ID set and a
  sink ID set that compiles to the existing `paths` query with two
  `nodeIds` matchers. The AST already supports this, so it is no new
  query semantics. Decided 2026-10-13.
  Done in PR 3 as `IdPathsIntent` (kind `idPaths`). "as source" on a
  sink set, or "as sink" on a source set, starts it; later clicks add to
  the set of their role. In the URL it is repeated `source-id` and
  `sink-id` with `source-label` and `sink-label`, read after `id`. Both
  sets are anchors, so truncation keeps them first (`truncationSeeds`
  now seeds exact paths queries; text paths still have no seeds). A
  source or sink on no path gets a new reveal reason, `no-path`, with
  "Query this node instead"; before, it read "not drawn even with every
  node filter off", which was wrong. "Keep it in the query" is not
  offered for a paths intent, since the node's role is not known there.
- Tests: tokenizer cases (snake, camel, dotted, digits, Lean namespaces
  with `«»`), the query fixture, and a reveal of a filtered hit ending in
  the relax action.

## Phase 2: structural queries

Questions like "which unfinished lemma blocks the most work", "lemmas
nobody uses" and "paths from module X to module Y" have no input today.
jq can answer the first one but not the other two without recursive
scripts.

Pruned on 2026-10-16, after PR 1 (#97) and a measurement on real
extracts (below). The rule: add a query only when it answers a question
that the viewer cannot answer today, and prefer a filter word to a new
verb.

- **No external engine.** Cypher (Neo4j, or an embedded engine in WASM)
  reads well. But it does not know the kind, status, link-type and role
  rules that `src/query.ts` applies. Its answers then disagree with the
  view. Extend the existing `GraphQuery` AST instead.
- **One input.** The search box is the query box. A text that starts
  with a verb and parses gets a first row that runs it. The search
  results for the same text stay below it.
- **Two verbs.**
  - `paths from <words> to <words>`: done in PR 1. It runs as the text
    intent with Source and Sink.
  - `top N by dependents <words>`: the N declarations that pass the
    filter words, ranked by unique transitive dependents (the count of
    the Guide lists, `rankByTransitiveDependents`, one implementation).
    Ties break by ID. The result is a node list.
- **Filter words** (done in PR 1): `kind:`, `status:`, `module:`,
  `file:`, `level:`, `crate:`. A text of filter words alone lists the
  declarations that pass them, by ID. That is the `select` of the
  earlier plan, so `select` is not a verb.
- **`is:` words.** One new key that names a fixed set of predicates.
  Each name calls one function, so a query and the Guide cannot
  disagree:
  - `is:unfinished`: `isUnfinished` of the Guide (unverified or failed,
    not an axiom). A declaration without a status is not unfinished,
    while `status:unverified` counts it, as the sidebar does. The docs
    say so.
  - `is:assumption`: `isAssumption` of the Guide (an axiom, or trusted).
  - `is:unused`: no callers, not an entry point (`is_entry_point`), not
    generated and not hidden (`is_generated`, `is_hidden`).
  - `is:surface`: a public function without a contract. In Verus, a
    public (`is_public_api`) exec function with no `requires` or
    `ensures` edges. In Aeneas projects, a public Rust function with no
    Lean translation (`mapping_id` empty).
  - Later, `is:frontier`, once `trust-and-frontier.md` Phase 2 defines
    it. That plan now owns it.
- **Structure words ignore the sidebar filters.** `level:`, `is:unused`
  and `by dependents` use every node and every dependency of the layer,
  as the Guide counts and the Dependency levels strip do. A lemma whose
  only caller is a hidden spec function is not unused. This replaces
  rule 6 of the decisions below, which assumed that the Guide counts
  only the links the Edge Types boxes show. They do not.
- **Node-list results** use the Phase 1 result list with its reveal,
  "as source" and "as sink" buttons. They add one "Show all in the Call
  Graph" button, which sets an exact ID set without direction. That
  intent already keeps isolated anchors, so an `is:unused` list does not
  render empty.
- **Guide lists fill the search box.** Each Guide list gets its query:

  ```
  top 5 by dependents is:unfinished
  top 5 by dependents is:assumption
  top 5 by dependents kind:lemma
  ```

  On a graph without lemmas the last one is `top 5 by dependents`, as
  the Guide list already ranks every node there. The user can then edit
  the query, for example add `module:` or raise N.
- **Recipes, not presets.** "Blockers of X" (the unfinished nodes that X
  depends on) is X in Source with the Failed and Unverified status boxes.
  The viewer.md text gives this recipe instead of a new query.

Cut on 2026-10-16, with the reason:

- `top N by callers` and `by callees`. The direct callers rank much like
  the dependents (2 to 8 of the top 10 are the same on the extracts
  below), with basic types on top. The callees count is a rough measure
  of size.
- The module matrix (was PR 3). The Crate Map shows the same at crate
  level, and `paths from module:A to module:B` answers one cell.
- Goals for `unused`, and true singletons as a separate query.
- Lean defs without a spec theorem in `is:surface`. 45 to 50% of the
  Lean defs in every extract below have no spec theorem, mostly helpers,
  so the list says little.
- The "later presets" list (longest chain, SCCs, largest declarations,
  lemmas used once, near-duplicates, unused spec functions, statement
  against proof lemmas). Several repeat existing features: the levels
  strip and `level:`, and `similar_lemmas` in Node Details. A preset
  comes back only when a real question needs it.

Measurement (2026-10-16), on seven local extracts: Verus dalek (2220
nodes), Aeneas dalek (2292), Aeneas SPQR (3508), Lean SecureMessaging
(2313), its blueprint layer (151), Lean Cedar (5016) and Lean lean-zip
(831).

- `top by dependents` over every node lists basic types and helpers
  (`pow2`, `GF16`, `FieldElement51`, projections), so it says little
  without a filter word. With `kind:lemma` it lists the foundation
  lemmas, as the Guide keystones list does. With `is:unfinished` it is
  the most useful: Aeneas dalek has
  `complete_addition_denominators_ne_zero` with 81 dependents, SPQR has
  `PolyDecoder::decoded_message` with 35. In SecureMessaging, the
  unfinished top is Verso document helpers (`defTitle`, `leanPill`), so
  `module:` matters there.
- Uncalled lemmas: Verus dalek 34 of 865, a list worth reading. SPQR 472
  of 1102, but 384 of them are generated or hidden (mostly Aeneas
  `@[step]` lemmas, which a tactic uses by attribute), hence the
  exclusion in `is:unused`. Cedar 2959 of 2968, because that extract has
  empty proof dependencies for theorems. That is an extract problem, not
  a query problem. Lemmas used through `@[simp]` or `@[grind]` also look
  uncalled. The docs say so.
- `is_public_api` is set only in the two dalek extracts (157 and 146
  public functions). Verus dalek has 47 public exec functions without
  `requires` or `ensures` edges, Aeneas dalek 46 public Rust functions
  without a Lean translation. SPQR and the Lean extracts have no public
  API data, so `is:surface` lists nothing there, and the docs say so.

The `top` grammar (decided 2026-10-16): `top [N] by dependents [filter
words]`.

- N is optional, 10 by default (a query exists to show more than the
  five of a Guide list), a whole number from 1 to 200. 200 is the render
  limit, so "Show all in the Call Graph" draws all N without truncation.
  The list still shows 20 rows with its "First 20 matches" note. Another
  N gives "top takes a number from 1 to 200".
- `by dependents` is required, although it is the only ranking. Without
  it the query does not say what it ranks, and the count is transitive
  dependents, not direct callers. A later ranking needs no change of
  grammar. A text without it gives "Not a query yet: top [N] by
  dependents [filter words]", as `paths` does.
- Only filter words follow. Plain words would need a third matching
  rule (the search box ranks words, Source and Sink match a display-name
  substring), and `module:`, `file:` and `kind:` cover the practical
  cases. A plain word gives "top takes filter words only, for example
  module:field". No filter word ranks every node.
- Ties break by node ID, as in the Guide, so the cut at N is fixed.
- Above the size limit of `transitiveDependentCounts` the list says
  "Dependent counts are not available for this graph, because it is too
  large", with the numbers the Guide gives.
- `top` counts on the layer the viewer shows, as the Guide does, while
  the search box searches both layers. The docs say so.

Where queries show, and "Show all" (decided 2026-10-16):

- No new panel. Each Guide ranked list gets a "query" button next to its
  title that fills the search box with the list's query, focuses it and
  opens the result list. The rows keep their action (the callers of the
  node). The Guide suggestion chips get "Unused declarations (N)" and
  "Public functions without a contract (N)", each only when N is above
  zero, and a click fills the search box with `is:unused` or
  `is:surface`. The box placeholder becomes "Search or query ( / )".
- A Guide list names only the kinds the Declaration Kind boxes show,
  but the search box ignores the sidebar filters. So with the Verus
  defaults (Spec off) the filled query can list a spec function that
  the Guide list hides. The docs say so. The filled query gets no hidden
  `kind:` words, so the box rule stays simple.
- "Show all in the Call Graph" appears under a node-list result when the
  whole result, not only the 20 rows shown, has at most 200 nodes (the
  render limit, so truncation never picks an arbitrary subset). Above,
  the list says "N matches, more than the 200-node render limit. Add
  filter words to show them in the Call Graph." For `top` N is at most
  200, so the button is always there.
- A click sets an exact ID set without direction, labelled with the query
  text (`nodes top 10 by dependents is:unfinished`), switches to the Call
  Graph and adds one Back entry. The graph draws the links among the
  nodes and keeps the isolated ones. The sidebar filters still apply,
  and the toast reports the result with the Guide's result message (for
  example "37 nodes, 3 hidden by filters").
- A query of filter words alone can match nodes on both layers. Show all
  draws the matches on the layer the viewer shows, and its label gives
  that count ("Show all 37 in the Call Graph"). If every match is on the
  other layer, it switches layer, as a reveal does. `top` counts on the
  shown layer, so it has no such case.

PR 2 then holds all of Phase 2 that is left: `top N by dependents`, the
`is:` words, the node-list results with "Show all in the Call Graph",
the Guide query buttons and chips, and the new placeholder. Its viewer.md text gives each `is:` word
with its exact definition and what it leaves out, the `top` grammar,
how ties break, the size limit above which `by dependents` is not
available (`transitiveDependentCounts` returns null above its cap), the
"Blockers of X" recipe, how the Guide fills the search box (with the
Declaration Kind difference), and when "Show all" appears and what it
draws.

Tests: parser round trip for `top`. Each `is:` word on a small fixture,
including an entry point, a generated lemma and a lemma that only calls
others. A `top` result that matches the Guide list for the same graph.

### Decisions (2026-10-16)

These settled the points that the first version of this section left
open. Rules 2, 4, 5 and 6 are replaced by the pruned section above.

1. **One input.** The search box is the query box. If the first word is
   a verb and the rest parses, the first row of the result list runs the
   query. The lexical hits for the same words stay below it, so a
   declaration named `paths_from` stays findable.
2. Replaced: `unused` is now `is:unused`.
3. **`module:` is a path-segment match on the file path.** `/`, `.` and
   `::` are the same separator, and the extension is dropped. The query
   segments must appear in order as whole segments, anywhere in the path.
   A Lean file path is the module path: `SecureMessaging/AEAD/Defs.lean`
   is `SecureMessaging.AEAD.Defs`. A Rust file path names the module, as
   in `src/backend/serial/u64/field.rs`. A blueprint path names the
   chapter, as in `blueprint/Addition`. IDs have no common module syntax (see
   the PR 2 decisions of Phase 1), so the ID is not used. `file:` is a
   glob on the file name, as Include Files is today.
4. Replaced: the module matrix is cut.
5. Replaced: Phase 2 is two PRs, PR 1 (#97) and PR 2.
6. Replaced: see "Structure words ignore the sidebar filters".

The reasons stay in this plan, and the viewer.md text links here for
them.

Decisions in PR 1 (2026-10-16):

- `paths from A to B` runs as the text intent with Source A and Sink B.
  It needs no new intent kind, and the URL, history and sidebar already
  handle that intent. So Source and Sink read the filter words too, which
  is the "one parser" of the Syntax item. A side with filter words gets a
  `words` matcher in `src/query.ts`: the filter words, plus the plain
  words as the old display-name pattern. A text whose filter word does
  not parse stays the old pattern. One `crate:` word on each side stays
  the crate boundary query, as in the sidebar.
- PR 1 parses only `paths`. A text is a verb query only if it starts with
  `paths from`, so a search for a declaration named `paths` stays a
  search. `top` comes with its executor in PR 2.
- `kind:` matches the `kind` field as a glob, and `kind:lemma` means
  `proof` or `theorem`, so the examples above work in Verus and Lean.
- `status:` is the exact status, not the sidebar group, so that
  `status:verified` matches what the result row shows. A node without a
  status counts as `unverified`, as in the sidebar.
- `module:` segments must be consecutive (`serial.u64` matches,
  `serial.field` does not match `serial/u64/field.rs`), and case does not
  matter.
- Comma alternatives work for every key. A query of filter words only
  lists the matching nodes by ID. This is close to `select`, but without
  a predicate on the edges.
- `level:` uses `graphCondensation` and `dependencyLevels` on the whole
  layer, the same numbers as the Guide strip, cached per graph.

Decisions in PR 2 (2026-10-16):

- `is:surface` picks its rule per layer, not per node. probe-verus tags
  exec functions `rust`, the same as the Rust nodes of an Aeneas join.
  So a layer with `verus` nodes gets the `requires`/`ensures` rule, a
  layer with `rust` and `lean` nodes gets the translation rule, and any
  other layer lists nothing. A plain probe-rust graph would otherwise list
  every public function. Verus dalek gives 47, Aeneas dalek 46, as
  measured above.
- `is:unused` reads the node-level dependencies, the relation of the
  levels and the dependent counts. A call to itself does not count.
- A `top` text is a verb only if `top` is followed by a number, `by` or
  nothing, so `top_level` and `top level` stay searches.
- `top` has no query row. Its rows are the result, and a line above them
  says what was ranked ("Top 10 of 37 by unique transitive dependents").
  Enter clicks Show all, as Enter runs the `paths` row. For a filter-word
  list above 200 nodes, Enter shows the top result, as before.
- The keystones query uses `kind:blueprint-theorem` on the blueprint
  layer, because `kind:lemma` (proof or theorem) does not match it.
- The Show all toast is "N nodes: label (M hidden by filters)", the form
  of the Guide's toast.
- `isUnfinished` and `isAssumption` moved from the Guide to
  `query-words.ts`, so the two share one definition without an import
  cycle (`query.ts` imports `query-words.ts`).

## Later (not scheduled)

Tracked in issue #102.

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
