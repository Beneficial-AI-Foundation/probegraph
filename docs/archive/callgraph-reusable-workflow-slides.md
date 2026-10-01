> **Archived 2026-10.** Pitch deck from February 2026, unmaintained since.
> Some claims were never true of the pipeline (complexity metrics, unused-spec
> detection). Current usage: `docs/guides/ci-integration.md`.

# Interactive Call Graphs for Every Verus Project

*One workflow. Zero setup. Instant visibility into your codebase.*

`Beneficial-AI-Foundation/probegraph`

---

## The Problem

**Understanding (Verus/Rust) codebases is hard**

- Which functions call which? 
- Which lemmas are reused, which are dead?
- Verification is expensive — where should you focus effort?
- Onboarding new contributors means navigating unfamiliar call chains

---

## The Solution

**A reusable GitHub Actions workflow that generates an interactive call graph for any Verus (or Rust) project**

```
Your Repo  →  verus-analyzer  →  SCIP index  →  Call Graph Pipeline  →  Interactive Web Viewer
               (or rust-analyzer)                 (enrichment, metrics)    (deployed to GitHub Pages)
```

Everything runs in CI. Nothing to install locally.

---

## How Simple Is It?

**Minimal setup — just add one file to your repo:**

`.github/workflows/deploy-callgraph.yml`

```yaml
name: Deploy Call Graph

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  callgraph:
    uses: Beneficial-AI-Foundation/probegraph/.github/workflows/generate-callgraph.yml@main
```

That's it. GitHub URL is auto-detected. Deploys to GitHub Pages automatically.

---

## What You Get

**An interactive, searchable call graph viewer at `https://YOUR_ORG.github.io/YOUR_REPO/`**

- **Force-directed graph visualization** (D3.js) — zoom, pan, drag
- **Three views** — Call Graph, File Map (layered by file), Crate Map (crate-level dependencies)
- **Search** by function name, symbol path, or file name
- **Depth-based exploration** — click a node, set max depth, see its neighborhood
- **Clickable source links** — jump directly to the function on GitHub
- **Caller/callee details** — click any node to see who calls it and what it calls

---

## Enrichments Beyond a Raw Call Graph

The pipeline doesn't just extract calls. It enriches the graph with:

| Enrichment | What it does |
|---|---|
| **Verus verification status** | Marks each function as verified / failed / unverified |
| **Function modes** | Distinguishes `exec`, `proof`, and `spec` functions |
| **Spec clause visualization** | Separate edge types for `requires` and `ensures` calls |
| **Similar lemmas detection** | Finds structurally similar lemmas (potential deduplication targets) |
| **Unused specs detection** | Identifies spec/proof functions with no callers |
| **Complexity metrics** | Cyclomatic, cognitive, Halstead difficulty/effort/length |
| **Cross-language mapping edges** | Rust ↔ Lean links in merged multi-probe graphs |
| **GitHub deep links** | Every node links to its exact file and line range |

---

## Visualizing Specs: Requires and Ensures as Edges

A call graph typically shows "function A calls function B in its body." But in Verus, calls also happen in **specification clauses** — and those relationships matter.

The callgraph distinguishes **three edge types**:

```
 ┌────────────┐                          ┌────────────┐
 │  my_func   │ ── solid gray ────────►  │  helper    │   Body call
 │            │ ── dashed orange ──────► │  is_valid  │   requires clause
 │            │ ── dashed pink ────────► │  result_ok │   ensures clause
 └────────────┘                          └────────────┘
```

| Edge style | Color | Meaning |
|---|---|---|
| **Solid line** | Gray | Call in the function body (exec/proof code) |
| **Dashed line** | Orange | Call in a `requires` clause (precondition) |
| **Dashed line** | Pink | Call in an `ensures` clause (postcondition) |

Toggle each type independently in the viewer. Default: body calls on, spec calls off — turn them on to see the full contract landscape.

---

## Why Spec Edges Matter

Seeing which spec functions appear in `requires` vs `ensures` answers questions that a body-only call graph cannot:

- **Which specs guard entry to this function?** (requires edges)
- **Which specs describe what this function promises?** (ensures edges)
- **Which spec functions are used only in contracts, never in bodies?**
- **If I change this spec, which contracts break?** (follow the dashed edges backward)
- **Are my preconditions and postconditions using the same vocabulary?** (shared spec callees)

This turns the call graph from a tool for understanding *implementation* into a tool for understanding *verification architecture*.

---

## Questions the Callgraph Answers: Navigation

**Understanding structure and dependencies**

- What functions does `my_function` call?
- What functions call `my_function`?
- What is the call chain between function A and function B?
- What is the neighborhood within N steps of a function?
- Which functions are entry points (public API, few or no internal callers)?
- Which functions are hubs (many callees)?

---

## Questions the Callgraph Answers: Verification Status

**Tracking verification progress**

- Which functions are verified? Which have failed? Which haven't been attempted?
- What is the overall verification coverage of the codebase?
- Are the functions I depend on verified?
- Which unverified functions are on the critical path?

Nodes are color-coded across six states: **green** = verified, **dark green** = transitively verified, **purple** = trusted, **red** = failed, **gray** = unverified, **blue** = unknown.

---

## Questions the Callgraph Answers: Proof Strategy

**Planning and prioritizing verification work**

- Which spec functions are unused — written but never referenced in any contract?
- Which lemmas are structurally similar to ones already proved (in my project or in vstd)?
- How complex is this function? (cyclomatic, cognitive, Halstead metrics)
- What is the transitive proof burden — how many lemmas does proving this function pull in?
- Where does proof effort concentrate in the codebase?

---

## Questions the Callgraph Answers: Code Review and Impact

**Assessing the blast radius of a change**

- If I change function X, what else is affected? (follow callers)
- If I change a spec function, which `requires`/`ensures` clauses reference it?
- What does this function depend on? (follow callees)
- Are there isolated clusters of functions with no external callers? (potential dead code)

---

## Questions the Callgraph Answers: Onboarding

**Getting up to speed on an unfamiliar codebase**

- What are the main entry points?
- How are modules organized and connected?
- What does function X do? (jump to its source on GitHub, see its callers and callees)
- Which functions are central to the architecture? (high connectivity)
- What patterns exist in the proof structure? (similar lemmas)

---

## Configurable for Your Project

The workflow accepts optional inputs for flexibility:

```yaml
jobs:
  callgraph:
    uses: Beneficial-AI-Foundation/probegraph/.github/workflows/generate-callgraph.yml@main
    with:
      # Pin a specific Verus version for reproducibility
      verus_version: '0.2025.11.23.41c5885'

      # For workspaces, specify the package
      package: my-crate

      # If your Verus project is in a subdirectory
      project_path: crypto/core

      # Skip slow steps if you just want the graph fast
      skip_verification: true
      skip_similar_lemmas: true
```

---

## Works for Non-Verus Rust Projects Too

Not using Verus? Switch to `rust-analyzer`:

```yaml
jobs:
  callgraph:
    uses: Beneficial-AI-Foundation/probegraph/.github/workflows/generate-callgraph.yml@main
    with:
      use_rust_analyzer: true
      skip_verification: true
```

Same interactive viewer. Same GitHub Pages deployment. Same zero-setup experience.

---

## Lean 4 Projects Too

A sibling reusable workflow does the same for Lean:

```yaml
jobs:
  callgraph:
    uses: Beneficial-AI-Foundation/probegraph/.github/workflows/generate-lean-callgraph.yml@main
```

- **probe-lean pipeline** extracts declarations, dependencies, and specs
- **Mathlib cache** support (`use_mathlib_cache`, on by default) keeps CI fast
- **`sorry` detection** — incomplete proofs surface as verification status
- **Pre-built atoms** (`pre_built_atoms`) let you skip the build entirely
- Same viewer, same Pages deployment — and merged Rust + Lean graphs get
  cross-language mapping edges

---

## Two Deployment Modes

**Standalone** (default) — the call graph viewer IS the entire site

```
https://your-org.github.io/your-repo/  →  Call Graph Viewer
```

**Subpath** — embed alongside an existing site (e.g., a verification dashboard)

```
https://your-org.github.io/your-repo/           →  Your Dashboard
https://your-org.github.io/your-repo/callgraph/  →  Call Graph Viewer
```

```yaml
with:
  deploy_mode: subpath
  subpath: callgraph
```

---

## Real-World Example: dalek-lite

**`curve25519-dalek` verification project uses this workflow today**

- Dashboard at root, call graph at `/callgraph`
- 200+ functions indexed with verification status
- Complexity metrics help prioritize which functions to verify next
- Similar lemmas detection surfaces deduplication opportunities

---

## What the Pipeline Does Under the Hood

```
1. Checkout your repo + probegraph repo
2. Install toolchain (Rust, verus-analyzer/rust-analyzer, SCIP CLI)
3. Generate SCIP index from your source code
4. Run the enrichment pipeline:
    - Parse SCIP → build call graph
    - Run Verus verification (optional)
    - Detect similar lemmas (optional)
    - Compute complexity metrics
    - Record line ranges for GitHub deep links
5. Build the web viewer (Vite + TypeScript + D3.js)
6. Deploy to GitHub Pages
```

All cached where possible. Runs on `ubuntu-latest`.

---

## Who Benefits

| Who | What they get |
|---|---|
| **Verification engineers** | Verification status at a glance, unused specs, similar lemmas to reuse, proof complexity metrics |
| **New contributors** | Visual codebase map, click-to-explore call chains, one-click jump to source |
| **Code reviewers** | Impact analysis — callers, callees, spec dependencies of any changed function |
| **Project leads** | Verification coverage dashboard, dead code detection, codebase health over time |
| **Security auditors** | Data flow tracing, critical path identification, dependency analysis |
| **Researchers** | Proof effort prediction, complexity correlation, lemma reuse patterns |

---

## Getting Started

**Three steps. Five minutes.**

1. **Enable GitHub Pages** in your repo settings (Settings → Pages → Source: GitHub Actions)

2. **Add the workflow file** — the one-file YAML from the "How Simple Is It?" slide.

3. **Push to `main`.** Done.

---

## Meeting Engineers Where They Are

Good tooling doesn't ask engineers to change how they work. It shows up where they already are.

Engineers live in two places:

- **GitHub** — where code is reviewed, merged, and deployed
- **Their editor** — where code is written, read, and debugged

If a tool only exists in one of those places, half the team won't use it.

Our approach: **deliver the call graph to both.**

---

## On GitHub: Reusable Workflows

The reusable workflow deploys an interactive call graph to **GitHub Pages** — accessible to anyone with a browser.

- Runs automatically on every push to `main` (and can be triggered on PR branches)
- No local tooling required — works for the whole team, including non-Rust contributors
- Shareable URL: paste a link in a PR comment, a Slack thread, or a design doc
- Always up to date with the latest code

**Result:** the call graph becomes a living artifact of the project, not a one-off analysis someone ran on their laptop.

---

## In the Editor: VS Code Extension

The same call graph viewer runs as a **VS Code webview panel** — embedded directly in the editor.

- **Open in Editor** — click any node and jump straight to that function in your editor
- **No context switching** — explore the graph and read code side by side
- **Bidirectional** — the extension sends graph data to the viewer, the viewer sends navigation commands back
- **Same UI** — identical D3.js visualization, search, filtering, and depth exploration

```
┌──────────────────────────────────────────────────┐
│  VS Code                                         │
│  ┌─────────────────┐  ┌───────────────────────┐  │
│  │  src/lib.rs     │  │  Call Graph Explorer  │  │
│  │                 │  │                       │  │
│  │  fn my_func() { │◄─│  [my_func] ──► ...    │  │
│  │    ...          │  │                       │  │
│  │  }              │  │                       │  │
│  └─────────────────┘  └───────────────────────┘  │
└──────────────────────────────────────────────────┘
```

---

## Two Surfaces, One Pipeline

The web viewer and the editor extension are built from the **same codebase**.

| | GitHub Pages | VS Code Extension |
|---|---|---|
| **Graph data** | Loaded from static JSON | Sent via extension message |
| **Source navigation** | Opens GitHub at file + line | Opens file in editor |
| **Audience** | Whole team, external reviewers | Individual developer |
| **Update cadence** | On every push (CI) | On demand / workspace reload |
| **Zero install?** | Yes (just a URL) | Yes (install extension once) |

Same enrichments. Same search. Same visualization. Different delivery.

---

## Summary

- **Any Verus project** can get an interactive call graph by adding a single workflow file
- **Zero local setup** — everything runs in GitHub Actions
- **Rich enrichments** — verification status, similar lemmas, complexity metrics
- **Two deployment modes** — standalone or alongside existing sites
- **Works for plain Rust and Lean 4 too** — `use_rust_analyzer: true`, or the Lean workflow
- **Meet engineers where they are** — on GitHub via Pages, in the editor via VS Code extension
- **One codebase, two surfaces** — same viewer, same data, delivered to both

**Try it today:** [github.com/Beneficial-AI-Foundation/probegraph](https://github.com/Beneficial-AI-Foundation/probegraph)
