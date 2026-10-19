# Viewer: trust bases, frontier, concept clusters and search

> **Status: superseded** on 2026-10-05, after a Codex review, by three
> plans: `docs/archive/graph-search.md` (Phase 6 and a shared reveal path;
> done and archived), `docs/plans/trust-and-frontier.md` (Phases 0 to 2)
> and `concept-discovery.md` (Phases 3 to 5 and 7 as an experiment; Phases
> 8 and 9 and the rest of Phase 7 under its "Later"; not yet in the repo). Phase 5b's declared vs.
> found edges went to `viewer-filters-and-guide.md`. Kept as the brainstorm
> record. Two things below are wrong and corrected in the new plans:
> Phase 2 counts `verified` dependencies as done, but `verified` means an
> unfinished declaration is reachable (the open question at the end has it
> backwards); and `verus_lemma_finder` indexes curve25519-dalek as well as
> vstd.

Status (2026-10-05): brainstorm turned into a plan, not yet reviewed and
nothing started. Builds on `viewer-filters-and-guide.md` Phase 4 (guide as
answers) and its "Later: structural abstraction" section; nothing here
should start before Phase 4's ranking code exists, except Phase 0. Revised
2026-10-05 with items from the choir proof tree (below).

Goal: help someone new to a project understand it from the graph alone: what
the main theorems rest on, what to prove next, and which groups of
declarations form a concept, independent of how the files are laid out. Ask
the user for input only where a small amount buys a lot (Phase 7).

Background: the Math Tree Explorer (https://tegmark.org/mathtree/) draws
formal systems as a tree where each edge says what the child adds
(definitions, axioms, or a new construction), frame colour gives one of five
branches, box style gives status (red dashed is inconsistent), and selecting
a system shows example models from a second, linked tree. The parts we can
use: a per-node "what it adds" (Phase 3), a few themes coloured across file
boundaries (Phases 4 and 7), a linked abstraction/implementation view
(Phase 8), and marking what rests on assumptions (Phase 1).

A second reference is the choir proof tree
(https://yidiq7.github.io/ProbMethodCombinatorics/choir-proof-tree.html):
a replay of a multi-agent proving run, one HTML file with the declarations,
edges and 2,371 events (stated, filled, claimed, PR opened and merged,
reduction accepted) embedded, a scrubber, and a layout recomputed from
whatever exists at each step. Its status is a text scan for `sorry`, not a
prover result, which the page says itself. The parts we take: a sequence of
snapshots instead of a pair (Phase 9), a goal-first / foundations-first
flip of the layered layout (Phase 7), a search whose hit is usable even
when hidden or off-screen (Phase 6), and "the helpers written for X" as a
by-node answer (Phase 3). Its declared-vs-discovered edge distinction goes
to the guide plan's Phase 5b, where the blueprint layer lives. Its
ownership channel (which worker holds which task, PR state) needs an event
feed from an orchestrator rather than an extract and is out of scope here.

## What the data gives us

Measured on `web/public/graph.json` (SPQR, probe-lean 0.14.0, 2907 atoms):

- 179 axioms, 280 `trusted`, 58 `unverified`, 47 `verified`, 2522
  `transitively-verified`. No `sorry` marker in the extract.
- Every atom has `type-dependencies` / `term-dependencies` and their
  `-external` variants. Statements mention 521 distinct external names; the
  most frequent are generic (`Aeneas.Std.Result` 1273, `Eq` 1047, `Nat`
  1029), so any vocabulary weighting needs IDF.
- `codomain-head` on theorems: `Aeneas.Std.WP.spec` 369, `Std.Do.Triple`
  348, `Eq` 252. `is-primary-spec` is present. Neither survives
  `convertAtomDictToD3Graph` today.
- Of 1076 theorems, 349 reach at least one axiom, trusted or unverified
  node; they share only 102 distinct sets of those (rough count, cycles not
  condensed; max set size 23).

Verus graphs carry `precondition` / `postcondition` link types and
exec/proof/spec kinds instead. The phases below say where a Verus graph
lacks what a Lean one has.

## Order of work

1. Phase 0 first: throwaway scripts that measure what each later phase
   would show. Drop or reshape a phase whose numbers are useless.
2. Phases 1 and 2 (graph passes over data we already load).
3. Phases 3 and 4, then 5 (names for Phase 4's clusters).
4. Phase 6 (search) can run alongside 3 to 5.
5. Phases 7 to 9 when the earlier ones have been used for a while.

## Phase 0: measure first

A Python script under `scripts/` (not shipped) that, for the SPQR extract
and a dalek Verus graph, prints:

- trust-base sizes and the number of distinct trust bases, on the
  SCC-condensed DAG;
- frontier size and the top 10 by dependents unblocked;
- for each node, the number of "new" statement names (Phase 3 definition)
  and how many nodes introduce none;
- cluster count, size distribution and the agreement with
  `code-module` (adjusted Rand index) for Phase 4's two clusterings.

## Phase 1: trust base per node

Phase 4 of the guide plan lists assumptions with their dependent counts
(reverse direction). This adds the forward direction: for a selected node,
the set of assumptions it transitively depends on.

- Assumption: Lean `axiom` kind, or `verification_status` `trusted` or
  `unverified`; Verus `trusted` (external_body / assume) or `unverified`.
  Unverified is listed separately from accepted assumptions, as in Phase 4.
- Computed on the SCC-condensed DAG in reverse topological order (each
  component's set is the union of its dependencies' sets), bitsets over the
  assumption list. Same direction conventions as the guide plan.
- Node details: "Rests on N assumptions", expandable, each with a witness
  path (shortest, ties by ID).
- Guide: group theorems by identical trust base ("37 theorems rest on
  exactly {A, B}"), largest groups first. Each row opens the group plus its
  assumptions.
- Display: nodes whose trust base contains an unverified node get a dashed
  border on the Call Graph and File Map, without clashing with the File Map's
  existing border status.

## Phase 2: proof frontier

Unverified nodes whose dependencies are all verified, transitively verified
or trusted: the things that can be worked on now. Rank by how many
unverified dependents each would move closer to done (the count of
unverified nodes that reach it), ties by ID. Generalises the blueprint's
`ready` to the code layer. Replaces the current `unverifiedHotspots` list
in the guide panel, which ranks unverified nodes by their verified direct
callers and ignores whether the node itself is ready to work on.

## Phase 3: what a node adds

For each node, the in-project and external names its statement
(`type-dependencies`) mentions that no statement of its direct dependencies
mentions. Shown in node details as "Introduces: ...". A node that
introduces nothing is a pure consequence of its dependencies; a node that
introduces many is where a concept enters.

Also per concept: the nodes that first mention it (no dependency's
statement mentions it), as a "where does X come in" answer.

Also by node, on graphs with a blueprint layer: the helpers written for X,
meaning the code nodes X reaches that no blueprint node binds and that no
other bound node reaches first. The choir tree's `plan` / `all` scope is
this split for the whole graph; here it is an answer in node details and a
count in the Guide's chapter table.

Verus: no type/term split. Use `precondition` + `postcondition` link
targets as the statement vocabulary; exec bodies have none.

## Phase 4: concept clusters

Automatic grouping by what statements talk about, not where the code lives.

- Features: each node's statement names (internal and external), TF-IDF
  weighted. Similarity: cosine. Clustering: Leiden on the k-nearest-neighbour
  graph (k around 10), fixed seed. Compare against Louvain/Leiden on the
  call graph itself (the guide plan's "Clustering" item); keep whichever
  Phase 0 shows agrees less trivially with `code-module`.
- Computed offline, written into the graph as a `cluster` field per atom, so
  the browser stays deterministic and fast. The loader copies it.
- Viewer: a cluster colour mode (frame or halo; fill stays status) and a
  Cluster Map view built like the Crate Map (aggregated nodes, edges
  weighted by link count).
- Diagnostic: nodes whose cluster differs from most of their file's nodes
  ("12 lemmas in `field.rs` cluster with scalar").

## Phase 5: cluster names

Default names: the top three TF-IDF names of the cluster. Optional build
step: an LLM writes a short name and one sentence per cluster from member
names, statements and docstrings, cached by cluster content hash so reruns
cost nothing. Also optional: the one-line "what it adds" of Phase 3 in
prose. The viewer works without either; LLM output is labelled as such.

## Phase 6: search

1. Lexical, in the browser: tokens from split identifiers (`mul_by_pow_2`
   → mul, by, pow, 2), module path, statement names, and docstrings when
   the extract carries them (it does not today). BM25 ranking. No model.
2. Embeddings, only if lexical misses too much in practice: index the
   project with `verus_lemma_finder` (today it only indexes vstd), ship
   384-dimensional int8 vectors (about 4 MB for 10k nodes), embed the query
   with transformers.js or precompute for suggested queries only.

Results feed the existing query intent: a search hit can be a source or a
sink, so "from *decompress* to *field inverse*" becomes a source/sink query
seeded by meaning rather than regex.

A hit must be usable when the viewer is not showing it. Browser find is no
help here: labels are abbreviated (`display_name`), a filtered-out node has
no element, and the Call Graph is a camera over an SVG, so a match can
exist and sit off-screen. So, for a chosen hit: pan and zoom to the node
(`fitToView` in `src/graph.ts` fits the whole result; this needs a
centre-on-node variant); if a filter hides it, say which (`filtersHiding`
in `src/editor-selection.ts`) and offer to relax them (`relaxations`, the
same path the `relaxFilters` message uses for editor selections); if it is
outside the current query's traversal, offer to add it to the intent. Once
Phase 9 has a snapshot sequence, "not in this snapshot" is one more reason
a hit is hidden, answered by moving to the first snapshot that has it, the
way the choir tree's find moves its scrubber.

## Phase 7: themes from a few examples

The one place we ask the user for input. A small themes file (or URL
parameter): theme name → two or three example IDs or a regex. Label
propagation over the statement-similarity graph of Phase 4 assigns every
node a theme and a confidence; low-confidence nodes stay uncoloured. This
gives the Math Tree's five branches for a project in a few minutes of work.

Other inputs worth asking for, each turning an existing pass into an answer:

- Headline theorems or API: roots for the dominator fold (guide plan,
  "Later"), Phase 1's grouping and Phase 2's ranking. Also a flow toggle
  for the layered views: goal-first puts the headline at the top and reads
  as a decomposition downward; foundations-first puts the assumptions at
  the top and reads as a construction. The choir tree flips the whole tree
  rather than only the arrowheads, so both read top-down with the head at
  the lower end. Every Dagre view is `rankdir: 'LR'` today
  (`src/file-map.ts`, `src/crate-map.ts`); the toggle needs a shared
  layout option rather than a per-view constant.
- "Why is X needed?": the headline items that reach X.
- "How does A reach B?": a few representative paths, grouped by cluster.
- "Paths from the API to any assumption avoiding module M."

## Phase 8: abstraction and implementation side by side

Selecting an abstraction highlights its implementations, like the Math
Tree's linked model tree:

- Verus: a spec fn → exec fns whose `requires`/`ensures` mention it and the
  proof fns that prove about it (precondition/postcondition links).
- Lean: a structure or class → its instances; a `def` → its `specs`
  theorems (field already on Lean def nodes); Aeneas mapping between Rust
  and Lean atoms.
- Blueprint: already covered by drill-down.

## Phase 9: snapshots over time

Load a sequence of extracts of the same project, ordered by the envelope's
`timestamp` and labelled by `source.commit` (the loader keeps both as
`extracted_at` and `source_commit` on `D3GraphMetadata`, `src/types.ts`).
Two snapshots is the smallest case: what became verified, new and removed
dependencies, trust-base changes from Phase 1. With more, a scrubber over
the sequence and, per node, the snapshot where it appeared and the one
where it became verified; the Guide gets "verified since <commit>".

Layout for the scrubber follows the choir tree: positions come from the
subgraph present at the current step, not from the final graph, so a
running project can be watched without knowing its final shape; within a
layer, nodes keep the order in which they first appeared, so growth spreads
outward instead of reshuffling, and nodes ease to new positions. Nodes
present in a snapshot but absent from the one before are the step's
"event" and get named in the control, since a step that moves nothing
should still say what it was.

Where the snapshots come from is a pipeline question: one extract per
tagged commit, or a CI job that keeps the last N. Not decided here.

## Open questions

- Phase 4 offline vs in-browser: offline needs a Python step in the
  pipeline and a schema field; in-browser needs a Leiden implementation in
  TypeScript. Offline is assumed above.
- Whether `transitively-verified` should count as done for Phase 2, given
  it can rest on trusted nodes. Phase 1 makes that visible either way.
- Docstrings: no extractor emits them today, which limits Phases 5 and 6.
