# Entry-point seeding for large graphs

> **Status: implemented.** Both phases shipped (PRs #18 and #20, commits
> `6658b5f` and `b103add`). Kept as the design record; the "Edge model and
> budget" and measurement sections explain decisions the code doesn't.

Plan for replacing the blank "Large graph" view in the web viewer with a
bounded initial view seeded from entry points. Written 2026-09-22, based on
measurements of local probe outputs.

## Problem

Graphs exceeding `LARGE_GRAPH_NODE_THRESHOLD` (2,000 nodes) or
`LARGE_GRAPH_LINK_THRESHOLD` (10,000 links) render nothing until the user
applies a filter. A blank page is a bad landing experience. Concrete case:
the sm-import-test deployment
(`merged_smimporttest_securemessaging.json`) has 1,547 nodes but 22,479
links, so it trips the link threshold and shows only the "use filters"
message. The `?depth=1` URL param does not help: `maxDepth` only limits
traversal from a source/sink query match and is ignored by
`hasSearchFilters()`.

## Design

Always attempt a bounded initial view: entry-point seeds plus their depth-1
neighborhood, bounded by a render budget. Never render a view whose induced
size exceeds the thresholds; count before rendering. If every tier of the
seed chain exceeds the budget, fall back to the current message.

### Edge model and budget

The induced view is computed over the full link set produced by
`parseAndNormalizeGraph()`: call/dependency edges, spec links, mapping
links, and resolved-external dependencies all count, each link
individually, for both the node and link budgets. Seed roots are nodes
with in-degree 0 over that same link set; expansion follows outgoing edges
of all link types from the seeds. Counting and rendering must consume the
same induced result — a BFS tree-edge count is not the induced link count.

Seed and expansion adjacency must be built from the normalized link set,
not from the per-node `dependencies`/`dependents` arrays: those are
populated from atom dependencies plus resolved externals only
(`graph-loader.ts` ~94), while mapping and spec links are appended
separately (~183), so array-based in-degree disagrees with link-based
in-degree.

Seeded views bypass the `MAX_RENDERED_NODES` (200) post-filter truncation:
they are bounded by construction, and connectivity-based truncation could
drop the seeds themselves. Their budget is the induced-view check against
the node/link thresholds. That effectively raises the render cap from 200
to 2,000 nodes, which the thresholds were never measured to support:
sanity-check render performance at the actual Phase 1 view size (~650
nodes / 4.5k links) and at a near-threshold case (~2,000 nodes, e.g. the
Verus fixture's 1,092-node / 9,153-link seeded view) before shipping; if
the latter is sluggish, cap the seeded view with its own lower constant.

`expandFromSeeds` returns its BFS depths, and the seeded render path
passes them as `nodeDepths` to the renderer (accepted at `graph.ts` ~181),
preserving them through display-only filtering. It must never fall back to
`computeTopologicalDepth()` (`graph.ts` ~55): that function's BFS provably
never terminates on a reachable cycle (a pre-existing latent bug — depth
grows around the loop and the `currentDepth >= depth` guard never fires).
All local probe outputs are acyclic, but SCIP graphs do contain cycles
(182 cycle nodes in libsignal), so a cyclic-view render test guards this.

### The 5 MiB pre-load gate

Seeding is unreachable if the graph never loads: `autoLoadGraph()` defers
any file whose `Content-Length` exceeds `LARGE_FILE_SIZE_THRESHOLD` (5 MiB,
`main.ts:105`), and the deferred path requires a search filter before
loading. The motivating JSON is 5,994,613 bytes, so it hits this gate
before any of the code Phase 1 changes.

Loading and rendering are separate budgets: the gate exists because
`JSON.parse` on large files freezes the browser (per the comment at
`main.ts:104`), which seeding does not change. Phase 1 therefore routes
the deferred path to load-and-seed only up to a hard cap (10 MiB — parsing
~6 MB up front is acceptable, and the cap covers the motivating file with
headroom). Files above the cap keep the current explicit-load behavior;
the repo already has 24–31 MB graph files that must not auto-parse.

### Seed preference chain

1. **Explicit entry points**, when the graph JSON carries them:
   - Rust/Verus: atoms with `is-public-api: true` (emitted by
     probe-rust/probe-verus; `--with-public-api` upgrades the default SCIP
     module-chain walk to `cargo public-api` ground truth).
   - Merged Aeneas projects: Lean atoms that are the `translation-name`
     target of a public-API Rust atom. The merged probe-aeneas output
     already contains both sides, so this is a field join in the loader —
     no top-level-function computation
     ([probe-lean#106](https://github.com/Beneficial-AI-Foundation/probe-lean/issues/106))
     is needed.
   - Pure Lean with attribute-style blueprint: atoms with `"blueprint"` in
     `attributes` (probe-lean's header scan picks up `@[blueprint]`;
     requires extraction with a probe-lean version that emits
     `attributes`).
   - Pure Lean with tex-macro blueprint: a probe-leanblueprint JSON passed
     via a new `?entrypoints=` URL param. The payload is an enriched atom
     base, not a seed list: seeds are the Lean atoms carrying
     `blueprint-label` (203 of 1,543 in the SecureMessaging sample),
     intersected with the graph. Raw atom-id intersection must not be
     used — it matches 1,543 of the motivating graph's 1,547 nodes.
     Reuses the focus-set fetch machinery, not its fuzzy matching.
2. **Fallback (topological)**: all in-degree-0 nodes; if that view exceeds
   the budget, restrict to in-degree-0 definition kinds (`def`, `instance`,
   `abbrev`, `structure`, `inductive`, `opaque`); if still too big, show
   the current "select or search a node" message. The kind tier applies to
   atom-schema graphs only: SCIP graphs carry no `kind` field (0 of 9,737
   libsignal nodes), so they fall from raw sources straight to the message.

### Depth control

Initial depth is 1, honoring `?depth=`, clamped to the range 1–10 in
seeded mode (the current parser maps 0 and invalid values to "All", which
seeded views must not inherit, and puts no upper bound on the URL value,
while the slider only represents depths up to 10). Depth changes are
transactional: compute the candidate view, validate it against the budget,
and only then commit graph, slider, label, URL, and banner together — the
current slider handler mutates `state.filters.maxDepth` before applying,
which seeded mode must not do. On refusal, keep the current view and name
the budget that actually failed ("depth N would add X nodes (limit
2,000)" or the link-limit variant). On initial load with an over-budget
`?depth=N`, use the largest depth that fits, found in a single layered BFS
that records the last admissible layer and stops at saturation or budget
violation — not by re-running expansion at N, N−1, …. Tier preference
beats depth: a preferred seed tier at depth 1 wins over a fallback tier at
the requested depth. The seeded view always carries a banner: "Showing N
of M nodes (entry points, depth d)".

Seeding replaces only the no-query initial view. Any interaction that
expresses query intent — search, node selection, focus set, language
toggle — exits seeded mode and goes through the existing filter pipeline.
That pipeline needs one fix first: `hasSearchFilters()` (`main.ts` ~1355)
does not consider `selectedNodes`, and the large-graph guard runs before
selection traversal, so clicking a seed would exit seeded mode into an
empty view. Selection must count as a real filter (add `selectedNodes` to
the gate) before it is allowed to exit seeded mode. Clearing the search or
selection with no other filters active returns to the seeded view, not to
the blank large-graph message. Display-only controls (hide node, kind and
verification-status filters) apply on top of the seeded view without
reseeding — noting that hide and select currently arrive through the same
`selectionChanged` callback (`graph.ts` ~550/~565), so the mode split must
key off the actual event, not that flag.

## Measurements motivating the design

| Graph | Nodes | Links | In-deg-0 | Seed set used | Seeds | Seeds + depth 1 |
|---|---|---|---|---|---|---|
| graph_libsignaL_8_01 (SCIP Rust) | 9,737 | 13,120 | 5,297 (54%) | — (raw sources fail) | — | 7,997 |
| curve25519-dalek (probe-rust) | 603 | — | 263 | `is-public-api` | 130 | 219 |
| dalek Verus (probe-verus) | 2,220 | — | 561 | `is-public-api` | 157 | 555 |
| dalek-lean (Aeneas) | 1,542 | — | 458 | issue-106 top-level | 190 | 459 |
| PrimeNumberTheoremAnd | 8,346 | — | 7,682 (92%) | `@[blueprint]` decls | 662 | 840 |
| sm-import-test (merged) | 1,547 | 22,479 | 133 | all sources | 133 | 648 / 4,514 links |

Notes:

- sm-import-test numbers are measured through the web loader
  (`parseAndNormalizeGraph()`), which adds spec links and resolved-external
  dependencies on top of the raw file. Raw-file counts are lower and must
  not be used as fixtures. Only measurements through the project's own
  toolchain count: an ad-hoc Node require-hook transpile of the loader gave
  slightly different numbers (22,469 / 646 / 4,487), while vitest with the
  real vite pipeline reproduces the values above. Pinned in
  `web/src/graph-utils.test.ts` (skipped when the fixture repo is not
  checked out alongside).
- Raw in-degree-0 fails on SCIP Rust graphs (dynamic dispatch, FFI, tests
  leave 54% of nodes callerless) and on math formalizations (92% of PNT
  nodes are sources: top-level theorems are terminal results).
- On Aeneas projects, raw sources are dominated by generated trait-instance
  wrappers (159 of 168 source `Funs` defs in dalek-lean), while the real
  public-API translations (`decompress`, `mul_base`, …) have in-project
  callers (spec theorems), so raw source-seeding hides them. The
  public-API mapping join avoids both problems.
- Ranking source theorems by in-project dependency-closure size is not an
  importance signal in math projects: closures are flat (max 43 in PNT,
  since proofs mostly depend on Mathlib, outside the graph), and the
  top-ranked items are numerics-table lemmas, not headline theorems.
- Big blueprint-less pure-Lean projects are rare (large formalizations
  tend to maintain blueprints); local blueprint-less projects (katydid
  589, SecureMessaging 1,543 atoms) are under the threshold anyway. The
  source-defs fallback is deliberately cheap, not polished.

## Probe requirements

- **probe-rust / probe-verus / probe-aeneas**: no changes.
  `--with-public-api` (present in all three; probe-aeneas forwards it to
  probe-rust) provides the entry points. Deployments should run extraction
  with the flag for ground truth; the SCIP-walk default is an acceptable
  approximation.
- **probe-lean**: no changes. `attributes` already captures `@[blueprint]`.
  Projects extracted before the `attributes` field need re-extraction.
- **probe-leanblueprint**: used as-is; its output becomes the
  `?entrypoints=` payload for tex-macro blueprint projects.

## Implementation phases (probegraph/web)

### Phase 1 — seeded initial view (fixes sm-import-test)

1. `graph-utils.ts`: `computeEntrySeeds(graph)` (fallback chain, explicit
   entry points slot in Phase 2; adjacency built from normalized links,
   not the per-node arrays), `expandFromSeeds(graph, seeds, depth)`
   returning the induced view plus per-node BFS depths and the last
   admissible layer (single layered BFS, stops at saturation or budget
   violation), and `countExpansion` for pre-render sizing.
2. `main.ts`: replace the empty large-graph view with the seeded view at
   `maxDepth` (default 1, honoring `?depth=` clamped to 1–10); banner with
   N-of-M counts; budget checks on the induced view (nodes and links);
   pass the BFS depths to the renderer as `nodeDepths` (never fall through
   to `computeTopologicalDepth()`, which hangs on cycles); route the
   deferred path (`autoLoadGraph`) to load and seed for files up to the
   10 MiB cap, keeping explicit load above it; exempt seeded views from
   `MAX_RENDERED_NODES` truncation; add `selectedNodes` to
   `hasSearchFilters()` so selection can exit seeded mode without
   blanking.
3. Depth slider on the seeded view: transactional count-validate-commit
   (no state mutation before the budget check), refusal message naming the
   failing budget; query-intent interactions exit seeded mode (clearing
   them returns to it), display-only filters apply on top, keyed off the
   actual event rather than the shared `selectionChanged` flag.
4. Test coverage. Vitest: fallback chain, budget refusal, expansion
   counts, rejected-depth rollback (state untouched on refusal),
   cyclic-expansion termination, the cycle guard in the renderer's
   `computeTopologicalDepth` fallback, the shared display predicate, and
   the golden fixture check (133 sources → 648 nodes / 4,514 links at
   depth 1; skipped without the sibling checkout). Playwright: seeded
   render and banner, transactional slider commit/refusal, selection
   exit plus reset return, and hide-node/display-toggle on top of the
   seeded view — the latter on a self-contained synthetic 2,100-node
   fixture so CI exercises the seeded paths without external data.

### Phase 2 — explicit entry-point signals

5. `graph-loader.ts` / `types.ts`: carry `is-public-api` and `attributes`
   through atom conversion; derive `is_entry_point` per language
   (Rust/Verus public API, Aeneas mapping join, Lean blueprint attribute).
   The Aeneas join is validated on
   `probe-aeneas/examples/aeneas_curve25519-dalek_4.2.0.json` (extracted
   with `--with-public-api`): 146 public-API Rust atoms, 100 with
   `translation-name`, all 100 resolving to Lean atoms — 246 entry points,
   whose depth-1 expansion is 526 nodes / 1,837 links through the web
   loader (pinned as a golden test).
6. `?entrypoints=` URL param loading a probe-leanblueprint JSON; seeds are
   the `blueprint-label`-carrying Lean atoms (see seed chain), and the
   banner reports matched/unmatched seed counts rather than silently
   falling back. The fetch is asynchronous (the focus loader it reuses
   mutates global state after an unawaited fetch), so tag the request with
   a graph-load generation token and recheck seeded-mode eligibility
   before committing: a late response must not overwrite newer query
   intent or apply to a different graph. `?focus=` takes precedence over
   `?entrypoints=`; on fetch failure or zero matches, fall through the
   normal seed chain with a banner saying so.

### Process

GitHub issue describing the problem and design, then one draft PR per
phase ("Closes #N"). Phase 1 is independently shippable.

## Pointers for implementation

Code anchors (`web/src/`):

- `main.ts`: `LARGE_GRAPH_NODE_THRESHOLD` / `LARGE_GRAPH_LINK_THRESHOLD`
  (~line 99), `LARGE_FILE_SIZE_THRESHOLD` (~105) and the deferred-load
  paths in `autoLoadGraph()` (~1100–1140), `MAX_RENDERED_NODES` truncation
  (~1886, applied ~1963), `isLargeGraph()` (~1314), `hasSearchFilters()`
  (~1355),
  large-graph empty view wired in `loadGraph` (~1758), `?depth=` parsing
  (~230), depth slider handler (~1026), focus-set loader `loadFocusSet()`
  (~1380, `?focus=` param) — the model for `?entrypoints=`.
- `graph-loader.ts`: `convertAtomDictToD3Graph()` (~line 91) is where
  `is-public-api` and `attributes` are currently dropped;
  `parseAndNormalizeGraph()` (~259) dispatches the input formats.
- `types.ts`: `D3Node` (~145) — has `mapping_id` (from `translation-name`),
  `kind`, `dependencies`/`dependents`. The latter are not the seeding
  adjacency: they omit mapping and spec links (see edge model), so seeding
  builds its own index from the normalized link set.

Data used for the measurements (all under `~/git_repos/baif/`):

- `sm-import-test/.verilib/probes/merged_smimporttest_securemessaging.json`
  — the motivating deployment
  (https://beneficial-ai-foundation.github.io/sm-import-test/?depth=1,
  JSON in the sm-import-test repo under the same path).
- `probe-rust/examples/rust_curve25519-dalek_4.1.3.json` (`is-public-api`
  ids look like `probe:curve25519-dalek/4.1.3/edwards/&CompressedEdwardsY#…`).
- `dalek-verus/.verilib/probes/verus_curve25519-dalek_4.1.3.json`.
- `curve25519-dalek-lean-verify/atoms.json` + sibling
  `Curve25519Dalek/Funs.lean` (Aeneas instance records detected there via
  the `Trait implementation:` docstring above the def; newer probe-lean
  marks them via `attributes` instead).
- `PrimeNumberTheoremAnd/.verilib/probes/lean_PrimeNumberTheoremAnd_0c7abf7.json`
  (predates `attributes`; blueprint decls counted by grepping
  `@[blueprint` in the Lean sources).
- `secure-messaging/.verilib/probes/leanblueprint_SecureMessaging_d5dbd6e.json`
  — probe-leanblueprint output sample (atom schema, `probe:` ids).
- `web/public/graph_libsignaL_8_01.json` — the SCIP-format large graph.

Probe references: `probe-verus/docs/SCHEMA.md` (`is-public-api`,
`--with-public-api`), `probe-aeneas/docs/SCHEMA.md` (merged schema,
`translation-name`, cross-language edges), `probe-lean/docs/SCHEMA.md`
(`attributes` header scan).
