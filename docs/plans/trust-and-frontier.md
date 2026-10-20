# Viewer: trust base and proof frontier

Status (2026-10-20): Phase 0 merged in #106. Phase 1 is split into three
PRs (see "PR split" in Phase 1): PR 1 merged in #110, and PR 2 is in
review. Phase 2 is not started. Split out of the
graph-insights brainstorm (`docs/archive/graph-insights.md`) after a Codex
review on 2026-10-05. Depends on `viewer-filters-and-guide.md` Phase 4 for
the SCC-condensed DAG and the reverse-reachability bitsets; that code
merged in #81 (`src/reachability.ts`).

Goal: for a selected node, which assumptions and which unfinished work it
rests on; for the project, which unfinished declarations can be worked on
now and which would unblock the most.

## Status semantics

Both extractors use the same five statuses with the same meaning
(probe-lean `docs/SCHEMA.md`, probe-verus `docs/SCHEMA.md`):

| Status | Meaning |
|---|---|
| `trusted` | In the trust base (`trusted-reason`: axiom, external, external-body, admit, assume-specification). A leaf: a `sorry` below it does not taint its callers. |
| `unverified` | The declaration itself carries a `sorry` / `assume` / `admit`. |
| `verified` | Locally clean, but an unfinished declaration is reachable from it. |
| `transitively-verified` | Clean modulo the trust base. Not produced under `--skip-enrich`, where such atoms read `verified`. |
| `failed` | Never produced by probe-lean today; produced by probe-verus. |

probe-aeneas also uses the trusted reason `auto-generated`.

Verus atoms with `untracked: true` carry no status; they are *unknown*, not
done. Lean `axiom` is a kind and also `trusted` with reason `axiom`.

Consequences for this plan (settled 2026-10-17, measured in Phase 0):

- **Done** is structural: a `trusted` node, or a node that is not
  unfinished, not unknown, and whose dependencies are all done. A
  `verified` dependency is a blocker, because something unfinished sits
  below it. `trusted` is a leaf, so its outgoing links are cut for every
  answer in this plan. A `trusted` node with reason `admit` counts as done.
- **No status is neutral.** An atom with no status and no `untracked` flag
  adds nothing and blocks nothing; the walk goes through it. Verus dalek
  has 993 such atoms (615 spec functions, 378 Rust exec functions), and
  1008 `transitively-verified` atoms depend on one of them.
- **Missing targets do not block.** A dependency that is not in the
  extract is listed as information. SPQR has 312 atoms with such targets
  (Lean constructors such as `spqr.Error.StateDecode`), and 280 of them are
  `transitively-verified`. A `trusted` atom's missing targets are cut
  with its links. Unresolved `*-dependencies-external` names are not
  listed: the extractor already judged them.
- Only `untracked: true` is unknown. None of the three measured extracts
  has it.

The extractor computed each status over the full program, so the rules
above trust it. Phase 0 confirms this: on SPQR and Verus dalek, the
structural rule gives done for an atom with a status exactly when that
status is `transitively-verified` or `trusted`.

## Scope rule

Everything here is computed on `state.fullGraph`, never on the filtered
or truncated graph. A role filter that hides the edge to an axiom must not
remove the axiom from the answer. Display filters affect only what is
drawn when an answer is opened; the toast says when they cut something.

## Phase 0: fixtures and measurements

A Python script under `scripts/` that stays in the repo as the executable
specification of Phases 1 and 2, plus small fixture graphs with expected
output that the TypeScript tests also run:

- chain, diamond with two blockers, unfinished SCC, `unfinished →
  verified → unfinished` (the contaminated intermediary), a `trusted`
  wrapper over an unfinished implementation, a node with a missing
  dependency target, a witness path longer than the render cap.

Measurements on the SPQR extract (`web/public/graph.json`), a dalek
Verus graph and a dalek Aeneas graph: trust-base sizes and the number of distinct trust bases on
the condensed DAG; frontier size under the policy below; the top ten by
"unfinished dependents affected" and by "would become ready"; the overlap
with the current `unverifiedHotspots` top five; peak memory of the bitsets
together with the guide plan's dependent counts (trust bases cost about
C·A/8 bytes for C components and A assumptions; the guide plan's
reachability costs C²/8).

Kill criteria, decided before running: Phase 1's grouping is not worth a
Guide section if more than half of the theorems that rest on anything have
a trust base of their own (no groups to show); Phase 2 is not worth
replacing `unverifiedHotspots` if its top five and the hotspots' top five
are the same set on both projects. The hotspots now show only as a
sentence in the Guide summary ("Unverified hotspots (called by verified
code)"), not as a list. The script computes them as
`computeUnverifiedHotspots` does, with every node as a candidate.

Known numbers (SPQR, probe-lean 0.14.0, 2907 atoms): 179 axioms, 280
`trusted`, 58 `unverified`, 47 `verified`, 2522 `transitively-verified`;
349 of 1076 theorems reach an assumption or unfinished node, sharing about
102 distinct sets (cycles not condensed; largest 23).

### Phase 0 results (2026-10-17)

The script is `scripts/trust_frontier.py`. `check` runs the fixtures in
`web/src/test-data/trust-frontier.json`, and `measure <extract>` prints
the numbers below. A "theorem" is a Lean `theorem` or a Verus `proof`,
the viewer's `kind:lemma`. A theorem's group key is its trust base
without the theorem itself.

| | SPQR (probe-lean 0.14.0) | Verus dalek 4.1.3 (probe-verus 6.10.0) | Aeneas dalek 4.2.0 (probe-aeneas 0.7.0) |
|---|---|---|---|
| Atoms | 2907 | 2220 | 2292 |
| Theorems resting on something | 349 of 1076 | 181 of 865 | 194 of 728 |
| Distinct trust bases (theorems / components) | 106 / 474 | 23 / 224 | 64 / 295 |
| Theorems with a base of their own | 27 (8%) | 8 (4%) | 37 (19%) |
| Trust base size (median, max) | 3, 23 | 1, 6 | 4, 24 |
| Largest group | 30 theorems | 103 theorems | 33 theorems |
| Longest witness | 15 nodes | 10 nodes | 12 nodes |
| Unfinished / ready | 58 / 57 | 1 / 1 | 13 / 8 |
| Top five overlap with the hotspots | 2 | 0 | 0 |
| Trust-base bitsets | 125 KB | 43 KB | 45 KB |
| Dependent-closure bitsets | 1.0 MB | 0.6 MB | 0.6 MB |

Verdicts:

- Phase 1 passes. At most 19% of the resting theorems have a base of
  their own, far under the 50% limit. No real witness comes near the
  render cap of 200, so the truncated-witness case is only a fixture.
- Phase 2 passes as written: the top fives differ on every project, so
  the Frontier list replaces the hotspots sentence (decided 2026-10-17).
  The hotspots also count atoms with no status: on Verus dalek they are
  spec functions such as `p()` and `pow2()`, and on Aeneas dalek they are
  Rust `core` functions. Under the neutral rule these are not work.
- But the frontier ranking is nearly flat. On SPQR, 57 of the 58
  unfinished atoms are ready, and only one has a non-zero count (would
  become ready 1). Most of them are `ProstMessageMessage` instances. On
  Aeneas dalek, one row unblocks 5 and the other seven unblock 0. The list
  is useful as "what can be worked on now", but the ranking separates
  little, and ties fall back to ID order.
- The frontier also works on `--skip-enrich` graphs. The Aeneas extract
  has no `transitively-verified` atom. The structural rule reads
  `verified` as locally clean, which the status table gives as its
  meaning in both modes. Phase 0 did not check that probe-aeneas
  follows the table here. See the second open question.
- Memory is small: trust bases need C·ceil(A/32)·4 bytes, at most 125 KB
  here. "Would become ready" reruns the done pass once per ready row,
  F·(C+E) work for F ready rows; on SPQR that is 57 passes over 2907
  components.

Phase 1 needs two fields that the loader drops today: `trusted-reason`
and `untracked`. The missing targets are also dropped
(`convertCodeAtoms` keeps only known IDs), so the details panel needs
them from the loader too. Phase 1 PR 1 adds the three fields to `D3Node`
as `trusted_reason`, `untracked` and `missing_dependencies`.

## Phase 1: trust base per node

Guide plan Phase 4 lists assumptions with their dependent counts (reverse
direction). This is the forward direction.

- **Computation.** First cut the links and the missing targets of every
  `trusted` node. Then, on the SCC-condensed DAG of the cut graph, in
  reverse topological order: each component's set is its own members that
  are `trusted`, `unverified`, `failed` or `untracked`, union its
  dependencies' sets. Bitsets over the list of those nodes. The missing
  targets are collected the same way, in a second bitset. A node with no
  status adds nothing, but the walk goes through it. The code is
  `src/trust-base.ts`, and it gives the same answers as
  `scripts/trust_frontier.py` on the fixtures.
- **Three sets, never one count:** accepted assumptions (`trusted`, with
  reason), unfinished (`unverified`, and `failed` where it occurs), unknown
  (`untracked`). The missing targets are a fourth list, for information
  only. A selected node that is itself unfinished appears under
  unfinished, not under assumptions.
- An assumption here is a `trusted` node. The `is:assumption` search word
  also matches `kind: axiom` without that status. The two differ only for
  such an axiom, and none of the three measured extracts has one.
- **Node details.** "Recorded dependencies include 4 assumptions and 2
  unfinished declarations", expandable, each with a witness path. The
  witness is the shortest path on the original graph (BFS from the node,
  ties by ID), not an expansion of the component-level path. When the
  closure is unknown, the line says "external closure unavailable" instead
  of a bare count.
- **Guide.** Theorems grouped by identical trust base ("37 theorems rest on
  exactly {A, B}"), largest groups first. A row opens the group plus its
  assumptions through the reveal path (`docs/archive/graph-search.md`,
  Phase 0): anchors first, then the witnesses, then the rest of the group
  until the cap. The toast gives the full count and the drawn count; a
  truncated witness is listed in the details panel as text, never drawn
  with its endpoints joined.
- **Display.** Dropped on 2026-10-20. The plan was a dashed border on the
  Call Graph, and a File Map marker, for nodes whose unfinished set is
  non-empty. On an enriched graph the status color already says this: on
  SPQR these nodes are exactly the 58 `unverified` and the 47 `verified`
  nodes, and on Verus dalek they are the `unverified` and `verified` nodes
  plus 5 nodes with no status. Only `--skip-enrich` graphs gain from it
  (Aeneas dalek: 88 of 1669 `verified` nodes), and there the details
  lines answer it for each node.
- Verus: same computation; `precondition` / `postcondition` link roles do
  not change it.

### PR split (2026-10-19)

1. Loader fields (`trusted_reason`, `untracked`, `missing_dependencies`)
   and the pure module `src/trust-base.ts`: trust bases, the BFS witness
   and the theorem groups. Its tests run the shared fixtures. It adds no
   UI, so it owes no user docs.
2. Node details: the trust-base lines with witnesses
   (`src/trust-details.ts`). User docs: "Trust base" under Node details
   in `docs/guides/viewer.md`. The border and the marker are dropped (see
   Display). Each entry also has a "show path" button (added in review,
   2026-10-20). It sets the existing paths intent (`idPathsIntent`) from
   the node to the entry. That intent draws every path and does not cut at
   trusted nodes, so it can show more than the witness. PR 3 adds an
   exact-set reveal for the Guide groups. The button can then switch to
   the exact witness chain.
3. Guide: the theorem groups, opened through the reveal path, with the
   toast counts. User docs: the Guide section in `docs/guides/viewer.md`.

## Phase 2: proof frontier

- **Ready**: an unfinished node (or an SCC of unfinished nodes, shown as
  one work group) whose dependencies outside the group are all done. A
  `verified` dependency blocks. Unknown dependencies block and the row says
  "unknown closure". Blueprint `ready` is the same idea on the other
  layer.
- **Two counts per ready node**, both on the condensed DAG:
  - *unfinished dependents affected*: unfinished nodes that reach it. An
    impact count, labelled as such.
  - *would become ready*: unfinished nodes for which this is the last
    blocker, that is, every other dependency is done. The unblocking
    count.
  Rank by the second, ties by the first, then by ID.
- **Guide.** A "Frontier" list that replaces the hotspots sentence in the
  Guide summary (Phase 0: the top fives differ on all three projects). The
  frontier can be empty on a project whose unfinished nodes all depend on
  each other; the Guide then says so.
- `trusted` dependencies with reason `admit` count as done, since the
  extractor says so (settled 2026-10-17). A toggle can come later if asked
  for.
- **Search box.** An `is:frontier` word for the ready nodes, one more name
  in `IS_NAMES` (`src/query-words.ts`) next to `is:unfinished`. Then
  `top 10 by dependents is:frontier` ranks them by unique transitive
  dependents, and Show all draws them. Document it in the `is:` table of
  `docs/guides/viewer.md`. It moved here from the search plan
  (`docs/archive/graph-search.md`), which is done.

## Open questions

- Settled 2026-10-17: an `admit`-trusted Verus node counts as done. Phase
  1 shows it under assumptions with its reason.
- Settled 2026-10-17: the Guide hides the frontier on graphs extracted
  with `--skip-enrich`, where `transitively-verified` does not exist, and
  shows a note. Phase 0 found that the structural rule computes a correct
  frontier there too (Aeneas dalek: 8 ready rows), so this can be revisited
  in Phase 2.
