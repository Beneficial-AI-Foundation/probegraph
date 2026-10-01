# probegraph

Dependency and call graph generation, complexity metrics, and interactive
visualization for verified codebases. Graphs come from multiple probes:

- **probe-lean** — Lean 4 declarations (atom JSON), with `sorry` detection
- **probe-verus / probe-rust** — Rust and Verus projects via SCIP indices
- **probe-aeneas** — cross-language Rust↔Lean mapping links, merged graphs

The web viewer's primary input is probe atom JSON (probe-lean, probe-verus);
SCIP is one probe among several. This workspace also computes Halstead
complexity metrics for Verus specifications and proofs.

**Live demo:** https://beneficial-ai-foundation.github.io/probegraph/

## Workspace structure

```
probegraph/
├── crates/
│   ├── scip-core/           # SCIP parsing, call graph construction, D3 export
│   ├── verus-metrics/       # Halstead metrics for Verus specs/proofs
│   └── metrics-cli/         # Command-line tools (37 binaries, including pipeline)
├── external/
│   └── verus_lemma_finder/  # Similar lemma search (git submodule)
├── web/                     # Interactive viewer (see web/README.md)
├── scripts/                 # Python enrichment and plotting scripts
├── examples/                # Example data and workflow templates
└── docs/
    ├── guides/              # CI integration, viewer, VS Code, metrics reference
    ├── technical/           # Internals: scip-core, spec/proof metrics, tools
    ├── research/            # Correlation analysis findings
    └── archive/             # Historical design docs
```

## Quick start: graph your own project

The `pipeline` binary produces an enriched graph in one step (Rust/Verus
projects):

```bash
git clone --recurse-submodules https://github.com/Beneficial-AI-Foundation/probegraph.git
cd probegraph
cargo build --release --workspace

# Optional, for the similar-lemmas feature:
uv sync --extra enrich
uv run maturin develop --release -m external/verus_lemma_finder/rust/Cargo.toml

cargo run --release --bin pipeline -- /path/to/verus-project
cd web && npm install && npm run dev
```

The pipeline generates a SCIP index, exports the call graph to
`web/public/graph.json`, runs verification to attach statuses, and adds
similar lemmas. Useful flags:

| Flag | Effect |
|------|--------|
| `--skip-verification` | Faster; no Verus needed |
| `--skip-similar-lemmas` | No Python needed |
| `--use-cached-scip` | Reuse an existing SCIP JSON |
| `--github-url <url>` | Source links in the viewer |
| `-p <crate>` | Select a package in a workspace |
| `--use-rust-analyzer` | Plain Rust projects (combine with `--skip-verification`) |

The viewer offers three views: **Call Graph** (force-directed), **File Map**
(grouped by file), and **Crate Map** (crate-level dependencies with boundary
selection; shown as **Namespace Map** for Lean graphs). Nodes are colored by
verification status: verified, transitively verified, trusted, failed,
unverified, unknown. See [docs/guides/viewer.md](docs/guides/viewer.md).

### Generating a SCIP index manually

Install [rust-analyzer](https://rust-analyzer.github.io/book/installation.html)
(or [verus-analyzer](https://github.com/verus-lang/verus-analyzer)) and
[scip](https://github.com/sourcegraph/scip), then:

```bash
rust-analyzer scip .
scip print --json index.scip > index_scip.json
```

## CI integration

Reusable workflows build the graph in your repo's CI and deploy the viewer to
GitHub Pages. Minimal setup for a Verus project (`github_url` is
auto-detected):

```yaml
permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  callgraph:
    uses: Beneficial-AI-Foundation/probegraph/.github/workflows/generate-callgraph.yml@main
```

For a Lean 4 project, use the Lean workflow (powered by
[probe-lean](https://github.com/Beneficial-AI-Foundation/probe-lean); builds
the project, extracts the dependency graph, detects `sorry`):

```yaml
jobs:
  callgraph:
    uses: Beneficial-AI-Foundation/probegraph/.github/workflows/generate-lean-callgraph.yml@main
```

Full input tables, non-Verus Rust projects, subpath deployment to an existing
Pages site, and Pages setup:
[docs/guides/ci-integration.md](docs/guides/ci-integration.md).

## Verus metrics

Computes Halstead metrics for `requires`/`ensures`/`decreases` clauses and
`proof { }` blocks (with transitive lemma analysis), and merges
implementation-complexity metrics from `rust-code-analysis`. Single command:

```bash
cargo run -p metrics-cli --bin run_full_pipeline -- \
  --scip index_scip.json --csv functions_to_track.csv \
  --rca-dir rca_jsons/ --proof-csv proofs.csv --output-dir out/
```

Step-by-step guide and column reference:
[METRICS_PIPELINE.md](METRICS_PIPELINE.md) and
[docs/guides/metrics-reference.md](docs/guides/metrics-reference.md).

## Documentation

- [docs/guides/ci-integration.md](docs/guides/ci-integration.md) — reusable workflows for Verus, Rust, and Lean projects
- [docs/guides/viewer.md](docs/guides/viewer.md) — using the interactive viewer
- [docs/guides/vscode-extension.md](docs/guides/vscode-extension.md) — embedding the viewer in VS Code extensions
- [docs/guides/metrics-reference.md](docs/guides/metrics-reference.md) — what each metric column means
- [METRICS_PIPELINE.md](METRICS_PIPELINE.md) — the metrics pipeline, step by step
- [docs/SIMILAR_LEMMAS.md](docs/SIMILAR_LEMMAS.md) — similar-lemmas enrichment
- [docs/technical/](docs/technical/) — internals: scip-core architecture, spec/proof metric implementations, tool references
- [docs/archive/correlation-analysis.md](docs/archive/correlation-analysis.md) — spec/proof/code correlations (archived: numbers not reproducible)
- [web/README.md](web/README.md), [web/ARCHITECTURE.md](web/ARCHITECTURE.md), [web/QUERY_PIPELINE.md](web/QUERY_PIPELINE.md), [web/docs/technical/](web/docs/technical/) — viewer development docs

## License

MIT
