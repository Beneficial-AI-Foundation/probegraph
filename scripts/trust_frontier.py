#!/usr/bin/env python3
"""
Reference implementation of the trust base and the proof frontier.

This is the executable specification of docs/plans/trust-and-frontier.md,
Phases 1 and 2. The TypeScript code must give the same answers on the
fixtures in web/src/test-data/trust-frontier.json.

Rules:

- The graph is the code layer of a probe extract: every atom whose language
  is not "blueprint". A link goes from a caller to a dependency. The links
  are `dependencies` plus the `*-dependencies-external` names that resolve
  to an atom, as in web/src/graph-loader.ts.
- `trusted` is a leaf: its outgoing links are cut before anything else.
- An assumption is a `trusted` node, unfinished is `unverified` or
  `failed`, unknown is `untracked: true`. A node with no status is neutral:
  the walk goes through it, and it adds nothing.
- A dependency target that is not in the extract does not block. It is
  listed under `missing`, for information.
- Done: a `trusted` node, or a node that is not unfinished, not unknown,
  and whose dependencies are all done. `admit` is a trusted reason, so it
  counts as done.

Usage:
    python3 scripts/trust_frontier.py check
    python3 scripts/trust_frontier.py measure web/public/graph.json [--json]
"""

import argparse
import json
import statistics
import sys
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent.parent / "web/src/test-data/trust-frontier.json"

BLUEPRINT_LANGUAGE = "blueprint"
UNFINISHED = {"unverified", "failed"}
DONE_STATUSES = {"transitively-verified", "trusted"}
# Statuses that count as verified for the Guide hotspots (isVerifiedStatus)
HOTSPOT_VERIFIED = {"verified", "transitively-verified", "trusted"}
# Lean theorems and Verus proof functions (the viewer's kind:lemma)
THEOREM_KINDS = {"theorem", "proof"}
# Largest number of nodes the Call Graph draws (MAX_RENDERED_NODES in main.ts)
RENDER_CAP = 200


# ============================================================================
# Graph
# ============================================================================


class Graph:
    """The code layer of an extract, with trusted nodes cut."""

    def __init__(self, atoms: dict):
        self.atoms = {k: a for k, a in atoms.items() if a.get("language") != BLUEPRINT_LANGUAGE}
        ids = self.atoms.keys()
        self.ids = sorted(ids)
        # Full relation, as the loader builds it
        self.full_deps: dict[str, list[str]] = {}
        self.missing: dict[str, list[str]] = {}
        for k, a in self.atoms.items():
            deps = a.get("dependencies", [])
            external = a.get("type-dependencies-external", []) + a.get("term-dependencies-external", [])
            self.full_deps[k] = sorted({d for d in deps + external if d in ids})
            self.missing[k] = sorted({d for d in deps if d not in ids})
        # Trusted is a leaf
        self.deps = {k: ([] if self.status(k) == "trusted" else d) for k, d in self.full_deps.items()}

    def status(self, k: str) -> str | None:
        return self.atoms[k].get("verification-status")

    def is_assumption(self, k: str) -> bool:
        return self.status(k) == "trusted"

    def is_unfinished(self, k: str) -> bool:
        return self.status(k) in UNFINISHED

    def is_unknown(self, k: str) -> bool:
        return self.atoms[k].get("untracked") is True

    def is_theorem(self, k: str) -> bool:
        return self.atoms[k].get("kind") in THEOREM_KINDS


class Condensation:
    """SCC-condensed DAG. Components are in topological order, callers first."""

    def __init__(self, ids: list[str], deps: dict[str, list[str]]):
        index = {k: i for i, k in enumerate(ids)}
        adj = [sorted({index[d] for d in deps[k]}) for k in ids]
        n = len(ids)
        order = [-1] * n
        low = [0] * n
        on_stack = [False] * n
        stack: list[int] = []
        emitted: list[list[int]] = []
        counter = 0
        # Iterative Tarjan, as in reachability.ts. Emits dependencies first.
        for root in range(n):
            if order[root] != -1:
                continue
            order[root] = low[root] = counter
            counter += 1
            stack.append(root)
            on_stack[root] = True
            work = [[root, 0]]
            while work:
                frame = work[-1]
                v = frame[0]
                if frame[1] < len(adj[v]):
                    w = adj[v][frame[1]]
                    frame[1] += 1
                    if order[w] == -1:
                        order[w] = low[w] = counter
                        counter += 1
                        stack.append(w)
                        on_stack[w] = True
                        work.append([w, 0])
                    elif on_stack[w]:
                        low[v] = min(low[v], order[w])
                    continue
                work.pop()
                if work:
                    parent = work[-1][0]
                    low[parent] = min(low[parent], low[v])
                if low[v] == order[v]:
                    comp = []
                    while True:
                        w = stack.pop()
                        on_stack[w] = False
                        comp.append(w)
                        if w == v:
                            break
                    emitted.append(comp)
        emitted.reverse()
        comp_of_index = [0] * n
        for c, comp in enumerate(emitted):
            for v in comp:
                comp_of_index[v] = c
        self.members = [sorted(ids[v] for v in comp) for comp in emitted]
        self.component_of = {ids[v]: comp_of_index[v] for v in range(n)}
        dep_sets: list[set[int]] = [set() for _ in emitted]
        for v in range(n):
            for w in adj[v]:
                if comp_of_index[w] != comp_of_index[v]:
                    dep_sets[comp_of_index[v]].add(comp_of_index[w])
        self.dependencies = [sorted(s) for s in dep_sets]
        self.dependents: list[list[int]] = [[] for _ in emitted]
        for c, ds in enumerate(self.dependencies):
            for d in ds:
                self.dependents[d].append(c)

    def __len__(self) -> int:
        return len(self.members)

    def links(self) -> int:
        return sum(len(d) for d in self.dependencies)


# ============================================================================
# Phase 1: trust base
# ============================================================================


def trust_bases(g: Graph, c: Condensation) -> list[frozenset[str]]:
    """Per component: the assumption, unfinished and unknown nodes it rests on, itself included."""
    sets: list[frozenset[str]] = [frozenset()] * len(c)
    # Dependencies come last, so walk backwards
    for k in range(len(c) - 1, -1, -1):
        own = {m for m in c.members[k] if g.is_assumption(m) or g.is_unfinished(m) or g.is_unknown(m)}
        for d in c.dependencies[k]:
            own |= sets[d]
        sets[k] = frozenset(own)
    return sets


def missing_targets(g: Graph, c: Condensation) -> list[frozenset[str]]:
    """Per component: dependency targets outside the extract, in its closure."""
    sets: list[frozenset[str]] = [frozenset()] * len(c)
    for k in range(len(c) - 1, -1, -1):
        own = {t for m in c.members[k] for t in g.missing[m]}
        for d in c.dependencies[k]:
            own |= sets[d]
        sets[k] = frozenset(own)
    return sets


def split(g: Graph, node_set: frozenset[str]) -> dict[str, list[str]]:
    """The three sets, never one count."""
    return {
        "assumptions": sorted(m for m in node_set if g.is_assumption(m)),
        "unfinished": sorted(m for m in node_set if g.is_unfinished(m)),
        "unknown": sorted(m for m in node_set if g.is_unknown(m)),
    }


def witness(g: Graph, start: str, target: str) -> list[str] | None:
    """Shortest path on the (cut) node graph. BFS visits dependencies in ID order."""
    parent = {start: None}
    queue = [start]
    i = 0
    while i < len(queue):
        v = queue[i]
        i += 1
        if v == target:
            path = []
            while v is not None:
                path.append(v)
                v = parent[v]
            return path[::-1]
        for w in g.deps[v]:
            if w not in parent:
                parent[w] = v
                queue.append(w)
    return None


def theorem_groups(g: Graph, c: Condensation, sets: list[frozenset[str]]) -> list[dict]:
    """Theorems grouped by identical trust base, the theorem itself left out. Largest first."""
    groups: dict[frozenset[str], list[str]] = {}
    for k in g.ids:
        if not g.is_theorem(k):
            continue
        key = sets[c.component_of[k]] - {k}
        if key:
            groups.setdefault(key, []).append(k)
    rows = [{"base": sorted(key), "theorems": sorted(ts)} for key, ts in groups.items()]
    rows.sort(key=lambda r: (-len(r["theorems"]), r["base"]))
    return rows


# ============================================================================
# Phase 2: frontier
# ============================================================================


def done_components(g: Graph, c: Condensation, forced: int | None = None) -> list[bool]:
    """Whether each component is done. `forced` is treated as done (finished work)."""
    done = [False] * len(c)
    for k in range(len(c) - 1, -1, -1):
        members = c.members[k]
        if k == forced or all(g.is_assumption(m) for m in members):
            done[k] = True
        elif any(g.is_unfinished(m) or g.is_unknown(m) for m in members):
            done[k] = False
        else:
            done[k] = all(done[d] for d in c.dependencies[k])
    return done


def unfinished_members(g: Graph, c: Condensation, k: int) -> list[str]:
    return [m for m in c.members[k] if g.is_unfinished(m)]


def is_ready(g: Graph, c: Condensation, k: int, done: list[bool]) -> bool:
    """A work group (the unfinished members of one component) whose outside dependencies are all done."""
    members = c.members[k]
    if not any(g.is_unfinished(m) for m in members) or any(g.is_unknown(m) for m in members):
        return False
    return all(done[d] for d in c.dependencies[k])


def frontier(g: Graph, c: Condensation) -> list[dict]:
    done = done_components(g, c)
    ready = [is_ready(g, c, k, done) for k in range(len(c))]
    # Transitive dependents of each component, callers first so every set is final when read
    reach: list[set[int]] = []
    for k in range(len(c)):
        s: set[int] = set()
        for p in c.dependents[k]:
            s |= reach[p]
            s.add(p)
        reach.append(s)
    rows = []
    for k in range(len(c)):
        if not ready[k]:
            continue
        affected = sum(len(unfinished_members(g, c, j)) for j in reach[k])
        # Only callers of k can change, and they come before k
        after = done_components(g, c, forced=k)
        unblocks = sum(
            len(unfinished_members(g, c, j))
            for j in reach[k]
            if not ready[j] and is_ready(g, c, j, after)
        )
        rows.append({"members": unfinished_members(g, c, k), "unblocks": unblocks, "affected": affected})
    rows.sort(key=lambda r: (-r["unblocks"], -r["affected"], r["members"][0]))
    return rows


def hotspots(g: Graph, limit: int = 5) -> list[str]:
    """computeUnverifiedHotspots in web/src/guide/static-analysis.ts, all nodes as candidates."""
    callers: dict[str, set[str]] = {k: set() for k in g.ids}
    for k, ds in g.full_deps.items():
        for d in ds:
            callers[d].add(k)
    rows = []
    for k in g.ids:
        st = g.status(k)
        if st in HOTSPOT_VERIFIED or st == "failed":
            continue
        n = sum(1 for p in callers[k] if g.status(p) in HOTSPOT_VERIFIED)
        if n > 0:
            rows.append((-n, k))
    return [k for _, k in sorted(rows)[:limit]]


# ============================================================================
# Answers
# ============================================================================


def answers(atoms: dict) -> dict:
    """Everything the fixtures can check."""
    g = Graph(atoms)
    c = Condensation(g.ids, g.deps)
    sets = trust_bases(g, c)
    missing = missing_targets(g, c)
    done = done_components(g, c)
    return {
        "graph": g,
        "condensation": c,
        "trust_base": {
            k: {**split(g, sets[c.component_of[k]]), "missing": sorted(missing[c.component_of[k]])}
            for k in g.ids
        },
        "done": {k: done[c.component_of[k]] for k in g.ids},
        "frontier": frontier(g, c),
        "groups": theorem_groups(g, c, sets),
        "sets": sets,
    }


def check() -> int:
    cases = json.loads(FIXTURES.read_text())
    failures = 0
    for case in cases:
        got = answers(case["data"])
        exp = case["expected"]
        problems = []
        for k, v in exp.get("trust_base", {}).items():
            if got["trust_base"][k] != v:
                problems.append(f"trust_base[{k}]: expected {v}, got {got['trust_base'][k]}")
        for k, v in exp.get("done", {}).items():
            if got["done"][k] != v:
                problems.append(f"done[{k}]: expected {v}, got {got['done'][k]}")
        for start, target, path in exp.get("witness", []):
            w = witness(got["graph"], start, target)
            if w != path:
                problems.append(f"witness {start} -> {target}: expected {path}, got {w}")
        for key in ("frontier", "groups"):
            if key in exp and got[key] != exp[key]:
                problems.append(f"{key}: expected {exp[key]}, got {got[key]}")
        status = "ok" if not problems else "FAIL"
        print(f"{status:4} {case['name']}")
        for p in problems:
            print(f"     {p}")
        failures += bool(problems)
    print(f"{len(cases) - failures}/{len(cases)} fixtures pass")
    return 1 if failures else 0


# ============================================================================
# Measurements
# ============================================================================


def bitset_bytes(sets: int, bits: int) -> int:
    """Uint32Array words, as in reachability.ts."""
    return sets * ((bits + 31) // 32) * 4


def measure(path: str) -> dict:
    envelope = json.loads(Path(path).read_text())
    atoms = envelope.get("data", envelope)
    a = answers(atoms)
    g: Graph = a["graph"]
    c: Condensation = a["condensation"]
    sets: list[frozenset[str]] = a["sets"]

    statuses: dict[str, int] = {}
    for k in g.ids:
        st = g.status(k) or ("untracked" if g.is_unknown(k) else "none")
        statuses[st] = statuses.get(st, 0) + 1
    enriched = statuses.get("transitively-verified", 0) > 0

    # Extractor cross-check: structural done against the status
    disagree: dict[str, int] = {}
    if enriched:
        for k in g.ids:
            st = g.status(k)
            if st is None:
                continue
            if a["done"][k] != (st in DONE_STATUSES):
                key = f"{st} but {'done' if a['done'][k] else 'not done'}"
                disagree[key] = disagree.get(key, 0) + 1

    theorems = [k for k in g.ids if g.is_theorem(k)]
    groups = a["groups"]
    resting = sum(len(r["theorems"]) for r in groups)
    alone = sum(len(r["theorems"]) for r in groups if len(r["theorems"]) == 1)
    base_sizes = [len(sets[c.component_of[k]] - {k}) for k in theorems]
    base_sizes = [s for s in base_sizes if s > 0]
    distinct_component_bases = len({s for s in sets if s})

    rows = a["frontier"]
    hot = hotspots(g)
    front_top = [r["members"][0] for r in rows[:5]]

    full = Condensation(g.ids, g.full_deps)
    tracked = sum(1 for k in g.ids if g.is_assumption(k) or g.is_unfinished(k) or g.is_unknown(k))
    longest = max(
        (len(witness(g, k, t)) for k in theorems for t in sets[c.component_of[k]] - {k}),
        default=0,
    ) if len(theorems) * max(base_sizes, default=0) < 2_000_000 else None

    return {
        "path": path,
        "tool": envelope.get("tool"),
        "nodes": len(g.ids),
        "statuses": statuses,
        "trusted_reasons": _count(g.atoms[k].get("trusted-reason") for k in g.ids if g.is_assumption(k)),
        "enriched": enriched,
        "extractor_disagreements": disagree,
        "nodes_with_missing_targets": sum(1 for k in g.ids if g.missing[k]),
        "phase1": {
            "components_cut": len(c),
            "theorems": len(theorems),
            "theorems_resting_on_something": resting,
            "distinct_bases_theorems": len(groups),
            "distinct_bases_components": distinct_component_bases,
            "theorems_with_own_base": alone,
            "own_base_share": round(alone / resting, 3) if resting else None,
            "kill": bool(resting) and alone / resting > 0.5,
            "base_size": _summary(base_sizes),
            "largest_groups": [
                {"theorems": len(r["theorems"]), "base": len(r["base"]), "example": r["theorems"][0]}
                for r in groups[:5]
            ],
            "longest_witness_nodes": longest,
            "witnesses_over_render_cap": None if longest is None else longest > RENDER_CAP,
        },
        "phase2": {
            "unfinished": sum(1 for k in g.ids if g.is_unfinished(k)),
            "frontier_rows": len(rows),
            "frontier_nodes": sum(len(r["members"]) for r in rows),
            "top_by_unblocks": rows[:10],
            "top_by_affected": sorted(rows, key=lambda r: (-r["affected"], r["members"][0]))[:10],
            "hotspots_top5": hot,
            "frontier_top5": front_top,
            "top5_overlap": len(set(hot) & set(front_top)),
            "top5_same_set": set(hot) == set(front_top),
        },
        "memory": {
            "assumption_like_nodes": tracked,
            "trust_base_bitsets_bytes": bitset_bytes(len(c), tracked),
            "components_full": len(full),
            "dependent_closure_bytes": bitset_bytes(len(full), len(full)),
        },
    }


def _count(values) -> dict:
    out: dict = {}
    for v in values:
        out[str(v)] = out.get(str(v), 0) + 1
    return out


def _summary(values: list[int]) -> dict | None:
    if not values:
        return None
    return {"min": min(values), "median": statistics.median(values), "max": max(values)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check", help="run the fixtures")
    m = sub.add_parser("measure", help="measure an extract")
    m.add_argument("graphs", nargs="+")
    m.add_argument("--json", action="store_true", help="print JSON")
    args = parser.parse_args()
    if args.command == "check":
        return check()
    for path in args.graphs:
        result = measure(path)
        print(json.dumps(result, indent=2 if args.json else None) if args.json else _text(result))
    return 0


def _text(r: dict) -> str:
    p1, p2, mem = r["phase1"], r["phase2"], r["memory"]
    lines = [
        f"== {r['path']}",
        f"nodes {r['nodes']}, statuses {r['statuses']}, trusted reasons {r['trusted_reasons']}",
        f"enriched (has transitively-verified): {r['enriched']}",
        f"extractor disagreements: {r['extractor_disagreements'] or 'none'}",
        f"nodes with missing targets: {r['nodes_with_missing_targets']}",
        "-- Phase 1",
        f"theorems {p1['theorems']}, resting on something {p1['theorems_resting_on_something']}",
        f"distinct bases: {p1['distinct_bases_theorems']} over theorems, "
        f"{p1['distinct_bases_components']} over components",
        f"theorems with a base of their own: {p1['theorems_with_own_base']} ({p1['own_base_share']}), "
        f"kill: {p1['kill']}",
        f"base size {p1['base_size']}",
        f"largest groups {p1['largest_groups']}",
        f"longest witness {p1['longest_witness_nodes']} nodes, over the render cap: {p1['witnesses_over_render_cap']}",
        "-- Phase 2",
        f"unfinished {p2['unfinished']}, frontier rows {p2['frontier_rows']} ({p2['frontier_nodes']} nodes)",
        "top by would become ready:",
        *[f"  {row}" for row in p2["top_by_unblocks"]],
        "top by unfinished dependents affected:",
        *[f"  {row}" for row in p2["top_by_affected"]],
        f"hotspots top 5 {p2['hotspots_top5']}",
        f"frontier top 5 {p2['frontier_top5']}",
        f"overlap {p2['top5_overlap']}, same set: {p2['top5_same_set']}",
        "-- Memory",
        f"trust bases: {mem['trust_base_bitsets_bytes']} bytes ({mem['assumption_like_nodes']} assumption-like nodes); "
        f"dependent closure: {mem['dependent_closure_bytes']} bytes ({mem['components_full']} components)",
    ]
    return "\n".join(lines)


if __name__ == "__main__":
    sys.exit(main())
