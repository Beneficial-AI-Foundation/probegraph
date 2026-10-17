# Viewer: trust base and proof frontier

Status (2026-10-15): planned, nothing started. Split out of the
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

Verus atoms with `untracked: true` carry no status; they are *unknown*, not
done. Lean `axiom` is a kind and also `trusted` with reason `axiom`.

Consequences for this plan: **done** means `transitively-verified` or
`trusted`. A `verified` dependency is a blocker, because something
unfinished sits below it. An empty dependency list is only "done" if the
node's own status is done; a node whose dependencies are not in the
extract (external, or the extract was cut) has an unknown closure, and
every answer below says so rather than reporting zero.

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

Measurements on the SPQR extract (`web/public/graph.json`) and a dalek
Verus graph: trust-base sizes and the number of distinct trust bases on
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
are the same set on both projects.

Known numbers (SPQR, probe-lean 0.14.0, 2907 atoms): 179 axioms, 280
`trusted`, 58 `unverified`, 47 `verified`, 2522 `transitively-verified`;
349 of 1076 theorems reach an assumption or unfinished node, sharing about
102 distinct sets (cycles not condensed; largest 23).

## Phase 1: trust base per node

Guide plan Phase 4 lists assumptions with their dependent counts (reverse
direction). This is the forward direction.

- **Computation.** On the SCC-condensed DAG in reverse topological order:
  each component's set is its own members that are `trusted`, `unverified`
  or unknown, union its dependencies' sets. Bitsets over the list of those
  nodes. `trusted` is a leaf: nothing below a trusted node is added.
- **Three sets, never one count:** accepted assumptions (`trusted`, with
  reason), unfinished (`unverified`, and `failed` where it occurs), unknown
  (missing targets, `untracked`). A selected node that is itself
  unfinished appears under unfinished, not under assumptions.
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
- **Display.** Nodes whose unfinished set is non-empty get a dashed border
  on the Call Graph; on the File Map, a marker that does not collide with
  its existing border status.
- Verus: same computation; `precondition` / `postcondition` link roles do
  not change it.

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
- **Guide.** A "Frontier" list alongside `unverifiedHotspots`, not
  replacing it until Phase 0's overlap measurement shows the hotspots add
  nothing. The two answer different questions: hotspots rank by verified
  direct callers and may list nodes that are not ready; the frontier may be
  empty on a project whose unfinished nodes all depend on each other.
- Policy switch (open question below): whether `trusted` dependencies with
  reason `admit` count as done. Default yes, since the extractor says so.
- **Search box.** An `is:frontier` word for the ready nodes, one more name
  in `IS_NAMES` (`src/query-words.ts`) next to `is:unfinished`. Then
  `top 10 by dependents is:frontier` ranks them by unique transitive
  dependents, and Show all draws them. Document it in the `is:` table of
  `docs/guides/viewer.md`. It moved here from the search plan
  (`docs/archive/graph-search.md`), which is done.

## Open questions

- Should an `admit`-trusted Verus node count as done for the frontier?
  The extractor puts it in the trust base; a project may treat it as debt.
  Phase 1 shows it under assumptions with its reason either way; a toggle
  can come later if asked for.
- Whether the Guide should show the frontier on graphs extracted with
  `--skip-enrich`, where `transitively-verified` does not exist and every
  clean node reads `verified`. Probably hide it with a note.
