# File Map Algorithm

The File Map draws the query result as a static left-to-right DAG with one
box per source file. Node shape encodes declaration kind; border and fill
encode two statuses derived from the dependency graph. Implementation:
`web/src/file-map.ts` (view) and `web/src/status.ts` (derived statuses). The
view's internal id is `file-map`; old `?view=blueprint` URLs still open it.

## Input

The filtered graph $G = (V, E)$ from the query pipeline (truncated to 200
nodes, like the Call Graph). Each node has a display name, a `relative_path`,
a declaration kind (`exec` / `proof` / `spec` for Verus, `def` / `theorem` /
`axiom` / … for Lean), and the derived `border_status` and `fill_status`
below. Links have the types listed in
[CALL_GRAPH_ALGORITHM.md](CALL_GRAPH_ALGORITHM.md#input).

## Derived statuses

`computeDerivedStatuses` runs once on the **full** graph after load (for a
large graph, on the first filter), so the colours reflect every dependency,
not only those in the current result. Write $D(v)$ for $v$'s dependencies
(callees) in the full graph and call a status *verified-like* if it is
verified, transitively-verified or trusted. Nodes are processed leaves first:
a node is evaluated once all of $D(v)$ has been.

**Border** (the node's own readiness):

| `border_status` | Condition |
|-----------------|-----------|
| `verified` | status is verified-like |
| `blocked` | status is failed |
| `ready` | status is unverified and every $d \in D(v)$ has border `verified` (vacuously true if $D(v) = \emptyset$); or no status, $D(v) \neq \emptyset$, and every $d$ has border `verified` |
| `not_ready` | status is unverified and some $d$ is not `verified` |
| `unknown` | no status and the `ready` condition fails |

**Fill** (completeness of the dependency subtree):

| `fill_status` | Condition |
|---------------|-----------|
| `fully_verified` | status is verified-like and every $d$ has fill `fully_verified` (vacuously if $D(v) = \emptyset$) |
| `verified` | status is verified-like but some $d$ is not `fully_verified` |
| `ready` | status is not verified-like, $D(v) \neq \emptyset$, and every $d$ is `fully_verified` |
| `none` | otherwise |

So an unverified leaf has border `ready` but fill `none`. Nodes never reached
by the leaves-first walk (on a cycle, or depending on one) get `unknown` /
`none`.

## Step 1. Transitive reduction

`transitiveReduction` (`graph-utils.ts`) drops a link $(u, v, t)$ when $v$ is
still reachable from $u$ without that direct hop, found by a BFS from $u$'s
other successors. Reachability ignores link type, so a typed link is dropped
if any path implies it. Cost is $O(|E| \cdot (|V| + |E|))$.

## Step 2. Layout

Nodes are grouped by `relative_path` (`unknown` if missing). Each node is
$w(v) \times 36$ with

$$
w(v) = \max(120,\; 6.5\,|\text{name}(v)| + 24)
$$

and is given to dagre as $(w(v) + 10) \times 46$ so neighbours keep a small
gap. Each file is a compound parent `file:<path>` of its nodes. dagre runs
with `rankdir: 'LR'`, `nodesep: 30`, `ranksep: 160`, `marginx`/`marginy: 40`.

dagre's compound layout can throw on some topologies (for example cycles that
span clusters). Then the same nodes and links are laid out flat with the same
parameters, and file backgrounds are not drawn.

After layout the SVG `viewBox` is set to the layout size plus 80, so the whole
map fits the container. Manual zoom is limited to $[0.05, 8]$.

## Step 3. Visual encoding

**File groups.** Each file's bounding box is a rounded rectangle in the
shared group palette (`groupColors` in `theme.ts`, 8 hues, cycling by file
order) at 0.10 alpha fill and 0.30 alpha stroke, labelled with the last two
path segments.

**Shape** by kind, using the language's kind sets (`getKindSetsForLanguage`
in `types.ts`):

| Shape | Kinds | Legend label (Verus / Lean) |
|-------|-------|-----------------------------|
| ellipse | proof kinds: `proof` (Verus), `theorem` (Lean), `blueprint-theorem` (blueprint), both in mixed graphs | Proof / lemma, Theorem |
| diamond | `spec`, `axiom` | Spec function, Axiom |
| rounded rectangle | everything else | Exec function, Definition |

Axioms share the spec diamond even though they have their own filter.

**Border colour** (2.5px stroke):

| `border_status` | Colour |
|-----------------|--------|
| `verified` | `--pg-status-verified` |
| `ready` | `--pg-status-unknown` (blue) |
| `blocked` | `--pg-status-failed` |
| `not_ready` | amber (no token) |
| `unknown` | `--pg-status-unverified` (grey) |

**Fill colour** (fixed in `file-map.ts`, no tokens): `fully_verified` dark
green, `verified` light green, `ready` light blue, `none` white. The selected
node's border becomes a 4px `--pg-selection` stroke.

**Edges** run from the source's right side to the target's left side with
$c = 0.4$, typed colours and dashes as in
[README.md](README.md#shared-edge-geometry) (`precondition` and
`postcondition` 6,3), opacity 0.55, width 1.5.

## Interaction

Click, Shift+click and hover work as in the Call Graph; see the
[viewer guide](../../../docs/guides/viewer.md#clicking-nodes). Hover dims
non-neighbours to 0.2 and non-incident links to 0.08.

## References

- Sugiyama, Tagawa & Toda, "Methods for Visual Understanding of Hierarchical System Structures," *IEEE SMC* 11(2), 1981 — the layered framework dagre implements.
- Gansner, Koutsofios, North & Vo, "A Technique for Drawing Directed Graphs," *IEEE TSE* 19(3), 1993 — Graphviz `dot`, which dagre follows.
- Sander, "Layout of Compound Directed Graphs," Universität des Saarlandes, 1996 — compound (clustered) layering.
