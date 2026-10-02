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
├── examples/                # detect_unused_specs example script
└── docs/
    ├── guides/              # Using probegraph: CI, viewer, metrics
    ├── technical/           # Internals: scip-core, spec/proof metrics, CLI tools
    ├── plans/               # Work in progress
    └── archive/             # Historical design docs and analyses
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
(cd external/verus_lemma_finder && uv tool run maturin develop --release)

cargo run --release --bin pipeline -- /path/to/verus-project
cd web && npm install && npm run dev
```

The pipeline generates a SCIP index, exports the call graph to
`web/public/graph.json` (change with `-o`), runs verification to attach
statuses, and adds similar lemmas. Useful flags:

| Flag | Effect |
|------|--------|
| `--skip-verification` | Faster; no Verus needed |
| `--skip-similar-lemmas` | No Python needed |
| `--use-cached-scip` | Reuse `<project>/index.scip.json` if it exists |
| `--github-url <url>` | Source links in the viewer |
| `-p <crate>` | Select a package in a workspace |
| `--use-rust-analyzer` | Plain Rust projects (combine with `--skip-verification`) |

The [viewer guide](docs/guides/viewer.md) covers the views, filters and
queries.

### Generating a SCIP index manually

Install [rust-analyzer](https://rust-analyzer.github.io/book/installation.html)
(or [verus-analyzer](https://github.com/verus-lang/verus-analyzer)) and
[scip](https://github.com/sourcegraph/scip), then, in the project directory:

```bash
rust-analyzer scip .
scip print --json index.scip > index.scip.json
```

## CI integration

Reusable workflows build the graph in your repo's CI and deploy the viewer to
GitHub Pages. Minimal setup for a Verus project:

```yaml
permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  callgraph:
    uses: Beneficial-AI-Foundation/probegraph/.github/workflows/generate-callgraph.yml@main
```

Lean 4 projects use `generate-lean-callgraph.yml` the same way. Inputs, plain
Rust projects and subpath deployment are covered in the
[CI integration guide](docs/guides/ci-integration.md).

## Verus metrics

Computes Halstead metrics for `requires`/`ensures`/`decreases` clauses and
`proof { }` blocks (with transitive lemma analysis), and merges
implementation-complexity metrics from `rust-code-analysis`:

```bash
cargo run -p metrics-cli --bin run_full_pipeline -- \
  --scip index.scip.json --csv functions_to_track.csv \
  --rca-dir rca_jsons/ --proof-csv proofs.csv --output-dir out/
```

See the [metrics pipeline guide](docs/guides/metrics-pipeline.md) for the
inputs and steps.

## Documentation

- [docs/guides/ci-integration.md](docs/guides/ci-integration.md) — reusable workflows for Verus, Rust, and Lean projects
- [docs/guides/viewer.md](docs/guides/viewer.md) — using the interactive viewer
- [docs/guides/vscode-extension.md](docs/guides/vscode-extension.md) — embedding the viewer in VS Code extensions
- [docs/guides/metrics-pipeline.md](docs/guides/metrics-pipeline.md) — running the metrics pipeline
- [docs/guides/metrics-reference.md](docs/guides/metrics-reference.md) — what each metric column means
- [docs/guides/similar-lemmas.md](docs/guides/similar-lemmas.md) — similar-lemmas enrichment
- [docs/technical/](docs/technical/) — internals: scip-core architecture, spec and proof metrics, CLI tools
- [docs/archive/](docs/archive/) — historical design docs; [correlation-analysis.md](docs/archive/correlation-analysis.md) has the spec/proof/code correlations (numbers not reproducible)
- [web/README.md](web/README.md), [web/ARCHITECTURE.md](web/ARCHITECTURE.md), [web/QUERY_PIPELINE.md](web/QUERY_PIPELINE.md), [web/docs/technical/](web/docs/technical/) — viewer development docs
- [.github/workflows/README.md](.github/workflows/README.md) — this repo's CI and releases

## License

MIT; see [LICENSE](LICENSE).
