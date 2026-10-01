# Similar Lemmas

Enrich a call graph with semantically similar lemmas for each node, using
[verus_lemma_finder](https://github.com/Beneficial-AI-Foundation/verus_lemma_finder)
(the `external/verus_lemma_finder` submodule).

The `pipeline` binary runs this step automatically (skip it with
`--skip-similar-lemmas`). It only searches the vstd index,
`external/verus_lemma_finder/data/vstd_lemma_index.json` (falling back to
`data/vstd_lemma_index.json`), and it finds that file and the script relative
to the current directory, so it must be run from the repo root
([#63](https://github.com/Beneficial-AI-Foundation/probegraph/issues/63)).
If anything is missing it logs a warning and continues without enrichment.
This page covers running the script yourself, for example with a project
index.

## Setup (first time only)

```bash
uv sync --extra enrich
(cd external/verus_lemma_finder && uv tool run maturin develop --release)
```

`uv sync` installs the Python package but not its compiled Rust extension;
the `maturin develop` step is required.

## Quick start

```bash
uv run python scripts/enrich_graph_with_similar_lemmas.py \
    --graph web/public/graph.json \
    --index external/verus_lemma_finder/data/vstd_lemma_index.json
```

## Full workflow

```bash
# 1. Generate a call graph from a SCIP index
cargo run -p metrics-cli --bin export_call_graph_d3 -- project_scip.json -o graph.json

# 2. Build a lemma index for the project (-r: project root, default: the SCIP file's directory)
uv run python -m verus_lemma_finder index project_scip.json -o lemma_index.json -r /path/to/project

# 3. Enrich the graph
uv run python scripts/enrich_graph_with_similar_lemmas.py \
    --graph graph.json \
    --index lemma_index.json \
    --top-k 3

# 4. View it in the web UI
cd web && npm run dev
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--graph`, `-g` | required | Input call graph JSON |
| `--index`, `-i` | required | Lemma index JSON |
| `--output`, `-o` | overwrites input | Output file path |
| `--top-k`, `-k` | 3 | Similar lemmas per node |
| `--quiet`, `-q` | false | Suppress progress output |

## Output

The query for each node is its `display_name` plus the first five lines of
its `body`. Nodes with at least one match get a `similar_lemmas` field:

```json
{
  "display_name": "lemma_mod_bound",
  "similar_lemmas": [
    {
      "name": "lemma_mod_basics",
      "score": 0.92,
      "file_path": "src/lemmas/div_mod.rs",
      "line_number": 45,
      "signature": "pub proof fn lemma_mod_basics(x: int, m: int)",
      "source": "project"
    }
  ]
}
```

The viewer's Node Details panel shows each similar lemma's name, score as a
percentage, and file location (see [viewer.md](viewer.md)).
