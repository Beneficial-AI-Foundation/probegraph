# Viewer: statement/proof, private and blueprint filters, guide fixes

Status (2026-10-01): Phases 0 to 2, 5a and 5c merged (#42, #43, #46, #48,
#49, #51, #56, #57). Open: 5b (blueprint-layer filters and the code-layer
"Blueprint-bound only" filter; `FilterOptions` has none of those fields),
Phase 3 (blocked on probe-lean #114, still open) and Phase 4 except for two
items: `removeIsolated` already keeps the intent's anchor IDs
(`src/query.ts`, `keepSet`; #46), and the Guide re-renders when kind or edge
filters change (#48). The ranked lists, SCC-based dependent counts, layers
strip and BFS truncation are not started; `src/guide/` still has its
conditional suggestion chips (up to six) and `main.ts` truncates by connectivity, keeping anchors first (#48).
Planned 2026-09-29 and revised after two Codex reviews that day; see "Review
decisions" at the end.

Where the merged work departs from the text below:

- `spec` links take the role of the theorem's link to the definition and
  obey the role boxes (#51), instead of getting no role (Phase 2).
- The "verified" chip selects `transitively-verified`, or `verified` on
  graphs without it (#48), instead of `verified` only (Phase 1.6).
- Phase 5 describes the code before 5a: the File Map rename to `file-map`
  (`src/file-map.ts`) and the blueprint layer both shipped in #56.

Goal: make large graphs navigable without drawing them whole. Two new
filters shrink the graph; the Guide tab becomes a set of ranked answers
that open small subgraphs.

Background: LAX (https://laxarchive.org, e.g. `lax-689614`) draws small
concept graphs because authors split each submission into a reviewable
surface (concept files, claims stated as `axiom`) and evidence (a separate
proofs package that is never drawn at declaration level). The graphs are
generated automatically; the abstraction comes from the authoring format.
We cannot require that format. The closest substitute we have is the
probe-leanblueprint layer (Phase 5). The edge filter (Phase 2) is a
relation filter, not a concept surface: statement edges alone still touch
2,730 of 2,907 atoms.

## Order of work

1. Phase 0. Self-contained, can start now.
2. Before coding Phase 1, write a short design note for the query intent
   (Phase 1.1): the type, which functions read it (`compileQuery`,
   `hasSearchFilters`, URL codec, toast, history), and its URL mapping.
   Get it reviewed on its own; Phases 4 and 5 build on it. Then Phase 1.
3. Phase 2.
4. Before starting Phase 4 or 5, re-check that phase's code references
   against the code as it stands then; Phases 0 to 2 will have moved them.
5. Phase 3 when probe-lean #114 lands.

No further review of the whole plan: remaining issues are expected to be
code-level and caught by the listed tests and per-PR review.

## Phase 0: escape graph strings in node details

Existing bug, and a prerequisite for Phase 5 (loading third-party
extracts). `updateNodeInfo` in `src/main.ts` builds `innerHTML` and
interpolates graph-provided strings unescaped: `node.display_name`
(~line 2765), file names, paths, caller/callee names (~lines 2661, 2776).
Only a few fields go through `escapeHtml`. Fix: escape every graph-provided
string in the details panel (or build those nodes with `textContent`).
Test: a node whose `display-name` and `code-path` contain markup renders
as text.

## Phase 1: fix the Guide tab

Reproduced with the default `web/public/graph.json` (probe-lean, 2,907
atoms) by clicking every chip in Playwright. Chips do fire their actions
(`src/guide/guide-panel.ts`, `executeAction`); the problems are:

1. **Chip state accumulates.** Each chip only sets its own fields. After the
   crate-boundary chip (0 nodes), "Show only verified" and "View namespace
   map" inherit its source/sink and also show an empty graph. Fix: a chip
   action is one state transition over an explicit **query intent**, not a
   list of fields to reset.
   - Query intent is one of: none, text selectors (source/sink strings),
     ID selectors (exact node IDs, see item 4), boundary (source/target
     crate). Today the intent is spread across `sourceQuery`/`sinkQuery`,
     `focusNodeIds`, `selectedNodes` (which becomes a `depthFromSelected`
     query when depth is finite, `src/query.ts` ~line 593), the external
     `selectedNodeId` override, and the `source-crate`/`target-crate` URL
     params (which rebuild source/sink on reload, `src/main.ts` ~line
     2262). `compileQuery`, `hasSearchFilters` (`src/main.ts` ~line 1492,
     decides seeding for large graphs), the URL codec and the toast all
     read the intent.
   - A chip replaces the intent and the status filter, and keeps user
     preferences (kind, language, include/exclude patterns, hidden nodes,
     depth). If a preference hides the chip's target, the toast says so
     instead of showing an empty graph.
   - History: `updateURLWithFilters` only calls `replaceState` and there
     is no `popstate` handler, so browser back does nothing today. Guide
     actions call `pushState` once; a `popstate` handler restores state
     from defaults plus the URL (not merged into current state) without
     pushing again. Ordinary filter edits keep `replaceState`.
   - URL codec fixes needed for the round trip: `verified`, `failed`,
     `unverified`, `excludeName`, `excludePath` are never deleted before
     being conditionally set (`src/main.ts` ~line 352), so a filter reset
     to default keeps its stale value; `hidden` is serialized by display
     name and resolved to the first match (~lines 406, 489), serialize IDs
     instead; add a param for ID-selector intents.
   - `loadFocusSet` (`src/main.ts` ~line 1681) assigns `focusNodeIds` when
     its fetch resolves, so a slow `?focus=` load overwrites a chip clicked
     meanwhile. Add a generation token, as the entrypoint loader already
     does (~line 1798), bumped whenever the intent changes.
2. **Crate boundary chip returns 0 nodes.** Root cause: the chip takes the
   two largest groups in size order (`static-analysis.ts:186`) and the
   boundary query is directed. On the Lean graph
   `SrcTranslated/Funs.lean → Spqr/Specs` has 0 edges, the reverse has
   1,019 dependency entries. Fix: rank non-empty directed group pairs by
   edge count and label the direction, or make the chip bidirectional.
   Match groups exactly, not by substring.
3. **Most connected ignores kind filters.** It picks `GF16`, a `structure`,
   while Types are hidden by default, so the sink itself is not shown.
   `computeTopConnected` in `src/guide/static-analysis.ts` ranks all nodes.
   Fix: rank only nodes visible under the current kind filters.
4. **Chips query by display name.** Substring match (`GF16` also matches
   `GF16…`) and names are not unique (hotspots list `ProstMessageMessage`
   five times, five distinct atoms). Fix: act on exact node IDs through the
   ID-set `NodeMatcher` variant (`src/query.ts` ~line 470), not the text
   path, which lowercases. Dedupe only repeated IDs; rows sharing a display
   name show module/path context. Known upstream limit: probe-lean #88,
   private declarations can collapse into one ID before the viewer sees
   them.
5. **Clicking switches to Node Details**, hiding the guide, and the toast
   only repeats the label. Fix: stay on the Guide tab; toast reports the
   result, e.g. "180 nodes: callers of GF16", plus "(truncated from N)"
   when the render cap applies.
6. **"2849 verified out of 2907"** counts transitively verified and trusted
   as verified (`computeVerification`). Fix: report verified,
   transitively-verified and trusted as separate numbers, using the
   probe-lean definitions (`probe-lean/docs/SCHEMA.md` ~line 187). Counts
   come from the full graph, never from a filtered view. The selection must
   match the numbers: both status predicates (`src/query.ts` ~lines 544,
   790) group verified, transitively-verified and trusted under
   `showVerifiedNodes`, so "Show only verified" returns all three. Make the
   chip select `verified` only (exact status set in the predicate), or
   label it "verified, transitive or trusted". Do not change
   `isVerifiedStatus()` (`src/types.ts` ~line 169); readiness and subtree
   code depend on its grouping.
7. **Test.** `e2e/guide.spec.ts` only writes a report (pinned to
   `public/graph_backup_dalek.json`). Turn it into assertions on node IDs,
   not counts, and add a Lean-graph case covering items 1 to 4, including a
   chip clicked after a non-default state (focus set, a stale
   `selectedNodeId`, a selected node with finite depth), browser back
   after a chip, and a delayed `?focus=` response arriving after a chip.

## Phase 2: statement / body-or-proof edge filter

Data: probe-lean emits internal `type-dependencies` (statement) and
`term-dependencies` (definition body or proof). In `public/graph.json`
their union equals `dependencies` exactly. Of 13,724 edges: 6,916 in both,
6,125 term only, 683 type only. `term-dependencies` include definition
bodies and recovered auxiliaries, so the second category is not "proofs"
only (`probe-lean/docs/SCHEMA.md` ~lines 153, 234).

Currently `src/graph-loader.ts` reads only the `*-external` variants
(`resolvedExternalDeps`, ~line 78) and emits every Lean dependency as a
link of type `inner`.

Semantics: the boxes restrict **traversal**, not only display. With
A -term→ B -type→ C and "Body/proof deps" off, a query from A must not
reach C. Today link-type filtering runs after traversal (`src/query.ts`
step 6, ~line 841) and seed expansion does the same (`src/main.ts`
~lines 1583, 1605); both paths must filter before traversing.

Plan:

- Loader: tag each Lean link with a role `type` | `term` | `both`. Keep
  `type: 'inner'` so existing views are unaffected; add a `role` field on
  `D3Link` (`src/types.ts`).
  - Duplicate endpoint pairs merge roles (`type` + `term` = `both`). Link
    identity is (source, target, type): only `inner` links merge roles.
  - `spec` links (theorem → definition, `src/graph-loader.ts` ~line 214;
    3,104 of 15,972 loaded links, overlapping dependency endpoints) and
    `mapping` links get no role. They are governed by their own call-type
    toggles, not by the role boxes, so with "Body/proof deps" off a `spec`
    link can still connect two nodes. That is intended: it is a different
    relation, shown only when its own toggle is on. (Superseded in #51:
    `spec` links take the role of the theorem's link to the definition, so
    the boxes cannot be bypassed through them.)
  - Resolved external dependencies: classify from the `*-external`
    type/term variants when present; otherwise no role.
  - Absent type/term arrays mean "no split data" (no role); present but
    empty arrays mean "no edges of that role".
  - Links with no role are always shown, and the checkboxes are hidden when
    the graph has no role data at all.
- Carry `role` through every link copy: the executor's result
  reconstruction (`src/query.ts` ~line 887) currently keeps only
  `source/target/type`.
- Filters: two checkboxes, "Statement deps" and "Body/proof deps", default
  on. A `both` link passes if either box is on. The boxes combine with
  `showInnerCalls` by AND: `showInnerCalls` off hides all inner links
  regardless of role. Wire through `FilterOptions` (`src/types.ts`), URL
  params and checkbox sync in `src/main.ts` (see how `showInnerCalls` is
  handled at lines 288, 387, 472, 501, 727, 2127), and
  `guideActions.setFilters`.
- Guide rankings read node-level `dependencies`/`dependents`
  (`static-analysis.ts` ~line 99). They stay on the full relation; say so
  in the Guide header when a box is off.
- Verus already has the equivalent (precondition/postcondition vs inner).
  Consider sharing the labels; don't merge the flags in this change.
- Tests: `src/graph-loader.test.ts` (role merge, externals, absent vs
  empty arrays), `src/filters.test.ts` (all four checkbox combinations,
  the A→B→C bridge case for both query and seed paths, role preserved in
  results, parallel `inner` and `spec` links between the same pair kept
  separate).

## Phase 3: private filter

Blocked on probe-lean for Lean. probe-lean demangles `_private.<mod>.0.<name>`
with `privateToUserName` (`ProbeLean/Types.lean:125`) and records no
visibility. Requested in
https://github.com/Beneficial-AI-Foundation/probe-lean/issues/114
(`is-private`, optionally `is-protected`). Add a comment there asking for a
capability marker (schema version or envelope flag): if false values are
omitted, an old extractor and an all-public dataset look the same.

Plan once available:

- Loader reads visibility into `D3Node` as `public` | `private` |
  `unknown`. `unknown` when the graph lacks the capability marker.
- Checkbox "Private" under Declaration Kind, default on (shown). Unchecking
  hides `private` only; `unknown` is always shown. This is a display
  filter, not a confidentiality control.
- Hide the checkbox for graphs with no visibility data.
- Rust/Verus: not in this phase. `is-public-api` is false for every
  `spec fn` and `proof fn` (`probe-verus/docs/SCHEMA.md` ~lines 118, 146),
  so `!is-public-api` does not mean private. Revisit if probe-verus emits
  real visibility.

Related, not planned yet: unused atom flags `is-hidden` (607 atoms, set from
a user-supplied list, `ProbeLean/Atomize.lean:47`), `is-lean-generated`
(281), `is-aeneas-generated` (342) could become filters too.

## Phase 4: guide as answers

Replace the five chips with short ranked lists. Each row opens a focused
subgraph by exact ID. Builds on Phase 1's action plumbing.

- **Unfinished work:** `sorry` nodes and unverified nodes, ranked by
  unique transitive dependents. Separate from:
- **Assumptions:** axioms and trusted nodes, with their dependent counts.
  An axiom is an accepted assumption, not a blocker; don't list it as
  unfinished.
- **Keystone lemmas:** ranked by unique transitive dependents, not direct
  callers.
- **Layers strip:** condense SCCs, assign topological levels, show count and
  percentages per level: verified, transitively-verified, trusted shown
  separately (same definitions as Phase 1.6).

Ranking semantics: links point caller → dependency, so a node's dependents
are the nodes that reach it (reverse reachability). For A → B → C the
counts are A 0, B 1, C 2. Compute on the SCC-condensed DAG in topological
order (callers first), each component's dependent set being the union of
its direct callers' components and their sets (bitsets, no double counting
through diamonds). The count is the sum of member sizes of those
components: a reachable SCC of five declarations counts five. Members of
one SCC share a count and do not count each other. Ties break by ID. Kind
filters restrict the ranked candidates only (same rule as Phase 1.3);
counts use all nodes. Cost is bitset unions over the condensed DAG, not a
linear pass; fine at ~3k nodes. `refreshGuidePanel()` (`src/main.ts` ~line
645) runs only on graph load; rerun it when kind filters change.

Subgraph size: directional chip actions currently request unlimited depth
(`guide-panel.ts` ~line 53) and the 200-node render cap (`main.ts` ~line
2483) keeps the most connected nodes, which can drop the target. Two
fixes:

- `removeIsolated` (`src/query.ts` ~line 866) keeps only focus IDs, so an
  exact-ID query for a node with no visible links returns nothing. Keep the
  intent's anchor IDs too.
- Truncation selects by BFS from the anchors in query direction, ties
  broken by ID, until the budget is reached, so every kept node has a kept
  path to an anchor. Adding shortest paths after selecting the top nodes
  can exceed the cap. With more anchors than the budget, keep the first N
  anchors by rank and say so. The toast reports the omitted count. Display
  filters (language, status, files) still apply after traversal and may cut
  a path; the toast says when they removed nodes.

## Phase 5: probe-leanblueprint layer

This is the closest thing to a LAX concept map that we can get without
inference. Could be scheduled before Phase 4: the ranked answers are more
useful on blueprint nodes than on raw atoms.

What probe-leanblueprint emits (`probe-leanblueprint/extract`, normative spec
in `probe-leanblueprint/docs/SCHEMA.md`, checked at `e1e5871`):

- **Node atoms:** one per blueprint entry, `language: "blueprint"`, keyed
  `probe:blueprint:<label>`, `kind` `blueprint-theorem` / `blueprint-definition`.
  Edges: `blueprint-statement-uses` and `blueprint-proof-uses`, resolved
  node-to-node, forming a closed graph that matches the blueprint. A bound
  node atom's `dependencies` list the Lean decls it binds.
- **Enriched Lean atoms:** `blueprint-label` (owning node), plus the same
  `blueprint-*` fields. Their uses fields resolve to code atoms, not nodes.
- **Per-node fields:** `blueprint-chapter`, `blueprint-group`,
  `blueprint-title` ("Theorem 1.3"), `blueprint-statement-status`
  (`none` < `blocked` < `ready` < `formalized`), `blueprint-proof-status`
  (`none` < `ready` < `proved` < `fully-proved`), `blueprint-status-source`
  (`code-derived` Verso / `declared` Massot), `blueprint-node-class`
  (`bound` / `planned-only` / `decl-missing`), `blueprint-status-mismatch`,
  `blueprint-missing-decls`, `blueprint-upstream-decls`,
  `blueprint-github-issue`, `blueprint-statement-text`.
- **Summary sidecar** (`probe-leanblueprint/summary`): headline and
  per-chapter counts.

Scale: the current secure-messaging extract
(`secure-messaging/.verilib/probes/leanblueprint_SecureMessaging_d5dbd6e.json`,
probe-leanblueprint 0.9.0) has 151 node atoms (76 bound, 72 planned-only,
3 decl-missing) and 1,953 Lean atoms, 288 statement-uses and no proof-uses
edges, 123 issue numbers, 147 statement texts. KVAC's extract has 18
proof-uses edges (0.3.0, no node classes). Small fixture:
`probe-leanblueprint/examples/verso-blueprint-project-template/extract.json`
(9 node atoms, 9 Lean atoms, all three node classes, two isolated nodes:
`addition_runtime_note`, `multiplication_assoc`).

Code references re-checked on 2026-09-30 against `main` at `65087b4`
(after Phase 2); line numbers below are from that check.

Current viewer use: only `?entrypoints=` seeding (`src/main.ts` ~line 1781),
which reads `blueprint-label` from Lean atoms and skips node atoms. Loading a
probe-leanblueprint extract directly as the graph has not been checked; node
atoms would likely show as unknown-kind nodes mixed with code.

Plan:

- **Layer switch.** Loader recognizes `language: "blueprint"` atoms. A
  "Blueprint layer" / "Code layer" toggle. Layers are split before
  traversal, stats, seed selection and Guide analysis, not only at render.
  The spec warns that summing statuses across layers double counts (a bound
  node atom mirrors its decls). A node atom's `dependencies` (its bound
  decls) are bindings, not graph edges: they never enter traversal, SCCs or
  rankings.
- **Layer-local filters.** Existing code-layer filters misclassify
  blueprint atoms today: `detectProjectLanguage` returns `unknown` for a
  blueprint-only graph (`src/types.ts` ~line 80), both blueprint kinds fall
  into the Definitions bucket of `compileKindPredicate` (~line 143), so
  unchecking Definitions hides blueprint theorems, and the language
  predicate treats every non-Lean node as Rust (`src/query.ts` ~line 877).
  Add `blueprint` as a language with its own kind bucket. Code-layer kind
  and language filters do not apply on the blueprint layer and vice versa;
  each layer keeps its own filter state and query intent (Phase 1.1).
  Switching layers invalidates layer-dependent caches (`seedTiersCache`,
  derived statuses, Guide analysis).
- **Blueprint graph.** Render node atoms with statement-uses and proof-uses
  edges. Reuse the Phase 2 checkboxes for these edges so the concept is one
  switch across layers. Blueprint nodes are exempt from isolated-node
  removal (`removeIsolated`, `src/query.ts` ~line 491, called ~line 941): planned-only and decl-missing entries
  are often isolated and are the point of the layer.
- **Filters on the blueprint layer:** chapter and group (multi-select),
  statement status, proof status, node class (hide planned-only to see only
  what exists in code), mismatch only.
- **Filter on the code layer:** "Blueprint-bound only" (atoms with
  `blueprint-label`). Contraction is deferred (see Later).
- **Drill-down.** Double-click a blueprint node to open its bound decls in
  the code layer (node atom `dependencies`). Zero bindings: toast "no bound
  declarations" and stay. Missing decls (`blueprint-missing-decls`): list
  them in node details. Drill-down sets an ID-selector intent on the code
  layer (one history entry). Node details for a Lean atom link back to its node
  via `blueprint-label`. The two maps are not inverses under label
  collisions (spec, "Which layer to read"); when a decl is bound by several
  nodes, list all of them. As built: bound declarations and entries are
  also links in node details, opening one node; both paths query with
  direction `both`, depth 1, and turn on the targets' Declaration Kind
  boxes.
- **Node details:** title, both statuses, status source, statement text,
  GitHub issue link. Statement text is untrusted markup (spec): render it
  as plain text, like every other graph string after Phase 0. Build the issue link only when `source.repo` parses as a
  `github.com/<owner>/<repo>` URL and the issue is a positive integer.
- **Guide (Phase 4):** headline and chapter table are computed from the
  loaded node atoms. The summary sidecar is not required. Show
  `declared` statuses labeled as declared, since the spec says they can
  overclaim. "Ready to prove" (statement `formalized`, proof `ready`) and
  "Blocked" lists are the blueprint version of unfinished work; list
  mismatches.
- **Naming clash.** The File Map's internal view id is `'blueprint'`
  (`ActiveView`, `src/url-state.ts` ~line 16, parsed ~line 270; `src/main.ts`
  ~lines 730, 785, 834; button `view-blueprint` in `index.html`) and its class
  is `BlueprintVisualization` in `src/blueprint.ts`. Rename both to file-map
  before adding anything called Blueprint, and map old `view=blueprint` URLs
  to the new id.
- **Layer mechanism.** The loader returns the code graph plus, when node
  atoms exist, a separate blueprint graph (node atoms only, links from the
  uses fields: statement-uses role `type`, proof-uses role `term`, both
  `both`, all type `inner`). Switching layers makes the other graph
  `state.fullGraph` and runs the same reset as a graph load (caches, seed
  tiers, derived statuses, Guide, file list), so every consumer sees one
  layer without per-call filtering. Each layer keeps its own
  `FilterOptions` in memory; the URL carries `layer=code|blueprint` and the
  active layer's state only. Default layer when node atoms exist:
  blueprint. `?entrypoints=` seeding applies to the code layer only. Both
  load paths set the graph: `loadGraph` (`src/main.ts` ~line 2134) and the
  deferred large-graph load (~line 1342).
- **PRs.** 5a: rename, loader split, layer toggle and URL param,
  blueprint language and kind handling, blueprint edges, isolated nodes
  kept, node details. 5b: blueprint-layer filters and the code-layer
  "Blueprint-bound only" filter. 5c: drill-down and back-links. The Guide
  part goes with Phase 4.
- Tests: loader tests on the project-template fixture (copy into
  `web/src/` test data or `web/public/`): layer split, isolated nodes kept,
  bindings absent from links, statement text escaped, invalid issue links
  not rendered, legacy `view=blueprint` URL, blueprint theorems visible
  with code-layer Definitions unchecked.

## Later: structural abstraction (not scheduled)

- **Surface contraction:** on the code layer, keep only blueprint-bound (or
  `@[blueprint]`-tagged / entry-point) atoms and draw A → B when A reaches
  B through unkept atoms only, in the existing caller → dependency
  direction. Before scheduling, specify: edge budget (contraction can turn
  one hidden hub into a dense bipartite graph), cycles, a witness path per
  contracted edge, and role mixing (a path through a body/proof edge is not
  a statement edge). Draw contracted edges as indirect.
- **Dominator fold:** a structural grouping heuristic, not semantic
  ownership: a node dominated by a single owner (from a stated root set,
  in the dependency direction) is folded into it ("T + 37 helpers"),
  keeping shared nodes. Fold, don't hide, so paths survive. First measure
  the reduction with a throwaway script on `public/graph.json`.
- **Clustering:** Louvain/Leiden communities as automatic concepts;
  mismatch against file structure as a diagnostic.

## Review decisions

Codex reviewed this plan on 2026-09-29. Its points adopted above: traversal
semantics for the edge filter, role preserved through link copies,
"Body/proof" naming, crate-boundary root cause, atomic chip actions, exact
IDs via `NodeMatcher`, separate verified/trusted/transitive counts,
unfinished vs assumptions, unique-descendant ranking, target-preserving
truncation, three-state visibility, no `!is-public-api` for Verus, isolated
blueprint nodes kept, layer split before analysis, bindings not edges,
plain-text statement text, validated issue links, legacy URL alias,
contraction direction and deferral.

Second Codex review, same day, checked against the code. Adopted: escaping
all graph strings in node details (Phase 0), an explicit query-intent state
instead of field resets, real history (`pushState` + `popstate`) and URL
codec fixes, a generation token on `loadFocusSet`, anchors kept by
`removeIsolated`, budget-aware BFS truncation, `spec` links outside the
role filter (reversed in #51), ranking direction and SCC weighting spelled out, chip status
selection matching the separate counts, layer-local filters and caches for
blueprint atoms.

Deliberately not done (reviewers: these are decisions, not omissions):

- **No computation budgets or cancellation for rankings.** Bitset unions
  over the condensed DAG of a ~3k-node graph do not need them. Add them
  when a real graph shows a measurable stall.
- **No sidecar fingerprint or provenance validation.** Counts are derived
  from the loaded graph; the sidecar is not used for anything that could go
  stale.
- **Out-of-order graph loads: revisited in #57.** A file picked while the
  default `graph.json` was still loading got replaced by it (seen as flaky
  e2e tests in CI); graph requests now carry a token. Auxiliary
  loads that write query state (`?focus=`, `?entrypoints=`) do get a
  generation token (Phase 1.1).
- **No in-app undo for Guide actions.** Browser history covers it once
  Phase 1.1 adds `pushState` and a `popstate` handler.
- **Display filters are not overridden to keep paths.** Language, status
  and file filters are explicit user choices; the toast reports when they
  cut nodes from a Guide subgraph.
- **No viewer-wide security audit.** Phase 0 covers the details panel,
  where extract strings are rendered.
- **No exhaustive acceptance-test matrix.** Tests target the defects and
  semantics listed in each phase, asserting IDs and edges; not every
  combination of filter, layer and dataset.
- **No viewer-side fix for upstream ID collisions (probe-lean #88).** The
  viewer cannot recover identities lost during extraction; it is noted as a
  known limit.
- **No Rust/Verus private filter** until probe-verus emits real visibility.
- **Guide rankings do not follow the Phase 2 edge boxes.** They use the full
  relation, and the Guide says so when a box is off. Recomputing on every
  toggle adds cost for little value.
- **No phase reordering.** The order already matches the reviewer's
  proposed sequence (Guide fixes, then edge filter, then blueprint); the
  semantic decisions now live inside each phase. Phase 0 was added in
  front; see "Order of work".
- **The LAX background stays** as motivation, with the claim narrowed:
  Phase 5, not Phase 2, is the concept-level view.
