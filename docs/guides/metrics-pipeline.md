# Metrics Pipeline

Computes code, specification and proof complexity metrics for the functions of
a Verus project and joins them into one CSV. What each metric means is in the
[metrics reference](https://github.com/Beneficial-AI-Foundation/probegraph/blob/main/docs/guides/metrics-reference.md);
this page covers how to produce them. Some matching steps assume
curve25519-dalek's crate name and repo layout; see
[Limitations](#limitations).

## Inputs

- **SCIP JSON** of the Verus source: see
  [Generating a SCIP index manually](https://github.com/Beneficial-AI-Foundation/probegraph/blob/main/README.md#generating-a-scip-index-manually).
- **RCA JSONs**: run
  [rust-code-analysis](https://github.com/mozilla/rust-code-analysis) on the
  *vanilla* (non-Verus) source of the same crate:
  `rust-code-analysis-cli -m -p /path/to/vanilla/project/ -O json -o rca_jsons/`.
- **`functions_to_track.csv`**: the functions to report on. A header row, then
  the function name and its module path in the first two columns, e.g.
  `FieldElement51::as_bytes,curve25519_dalek::backend::serial::u64::field`.
  Further columns are ignored.
- **Proof-difficulty CSV**: `function`, `has_proof` and `trivial_proof`
  columns; see [step 5](#step-5-join-spec-and-proof-metrics).

## Running it

`run_full_pipeline` runs the five steps below in order. Run it from the repo
root: it uses binaries from `target/debug` or `target/release` when present and
falls back to `cargo run` otherwise.

```bash
cargo run -p metrics-cli --bin run_full_pipeline -- \
  --scip index.scip.json --csv functions_to_track.csv \
  --rca-dir rca_jsons/ --proof-csv functions_with_trivial.csv \
  --output-dir out/
```

All flags except `--output-dir` (default `data/pipeline_output`) are required.
The output directory keeps every intermediate file, named as in the steps
below.

## Steps

### Step 1: atoms from SCIP

```bash
cargo run -p metrics-cli --bin write_atoms -- index.scip.json out/step1_atoms.json
```

One entry per function with `identifier`, `display_name`, `relative_path`,
`body` and `deps`.

### Step 2: spec metrics

```bash
cargo run -p metrics-cli --bin compute_metrics -- out/step1_atoms.json out/step2_with_specs.json
```

Parses each function with `verus_syn` and adds a `metrics` object:
`function_mode` (exec, proof or spec), `requires_count` / `requires_lengths` /
`requires_specs`, the same for `ensures`, `decreases_count` /
`decreases_specs`, `body_length` and an `operators` count. Each `*_specs`
entry holds the clause text and its Halstead counts.

### Step 3: proof metrics

```bash
cargo run -p metrics-cli --bin compute_proof_metrics -- out/step2_with_specs.json out/step3_with_proofs.json
```

Adds a `proof_metrics` object: `direct_proof_halstead` (the function's own
`proof { }` blocks), `transitive_proof_halstead` (adding the proofs of the
`lemma_*`-named functions called from those blocks, transitively),
`direct_lemmas`, `transitive_lemmas` and `proof_depth`. The
results currently vary between runs
([#58](https://github.com/Beneficial-AI-Foundation/probegraph/issues/58)).

### Step 4: code metrics from RCA

```bash
cargo run -p metrics-cli --bin enrich_csv_with_metrics -- functions_to_track.csv rca_jsons/ out/step4_with_code.csv
```

Matches each tracked function against the RCA output by name and module
path. Only RCA files whose path contains `src/` are loaded, keyed by the
path after the first `src/`.
Append `--debug` to print the match keys tried.

### Step 5: join spec and proof metrics

```bash
cargo run -p metrics-cli --bin enrich_csv_complete -- \
  out/step3_with_proofs.json functions_with_trivial.csv out/step4_with_code.csv out/FINAL.csv
```

The arguments are the step 3 JSON, the proof-difficulty CSV, the step 4 CSV
and the output path.

`has_proof` in the proof-difficulty CSV is supplied by you (`yes` for
functions that verify). Two binaries add `trivial_proof` to a CSV with the
columns `function,module,link,has_spec,has_proof`:

- `add_trivial_proof_from_source <source_repo> <input_csv> <output_csv>` reads
  the source at each row's GitHub `link` (`...#L<line>`) and checks for a
  `proof {` block.
- `add_trivial_proof_column <categories_json> <input_csv> <output_csv>` uses the
  output of `categorize_verified_functions` (below).

Both write `trivial_proof` only for rows where `has_proof` is `yes`, and
`no` when the function has a proof block. They differ on `yes`:
`add_trivial_proof_from_source` writes it whenever there is no proof block,
while `add_trivial_proof_column` writes it only for `trivially_verified`
functions (an `ensures` clause and no `assume(false)`) and leaves the rest
empty.

## FINAL.csv columns

| Columns | Source |
|---------|--------|
| `function`, `module` | `functions_to_track.csv` |
| `cyclomatic`, `cognitive`, `halstead_difficulty`, `halstead_effort`, `halstead_length` | RCA, step 4 |
| `has_proof`, `trivial_proof` | proof-difficulty CSV |
| `requires_halstead_{length,difficulty,effort}`, `ensures_halstead_{length,difficulty,effort}` | step 2, summed over the clauses |
| `decreases_count` | step 2 |
| `direct_proof_{length,difficulty,effort}`, `transitive_proof_{length,difficulty,effort}`, `proof_depth`, `direct_lemmas_count`, `transitive_lemmas_count` | step 3 |

## Empty values

A cell is empty when the function was not matched, or when RCA reported no
value for that metric (a match needs only one of cyclomatic, cognitive or
Halstead length). The step 5 columns are
also empty when the value is zero; the RCA columns from step 4 print `0`.
`has_proof` and `trivial_proof` are empty for functions missing from the
proof-difficulty CSV. Steps 4 and 5 print their match rates.

Unmatched functions are expected in step 4: files whose path has no `src/`
(such as a crate-root `build.rs`) are not loaded, RCA skips macro-generated functions
(`add_assign`, ...) and trait declarations without a body, and Verus-only
modules are absent from the vanilla source. `verify_rca_coverage
<rca_json_dir> <vanilla_source_dir> <atoms_json>` reports which functions are
missing where.

## Limitations

- Step 4 strips a leading `curve25519_dalek` from each module path before
  matching, and no other crate name. For another crate, a module path that
  starts with the crate name (as in the example above) keeps it and doesn't
  match the RCA keys, which start after `src/`; give crate-relative module
  paths (`backend::serial::u64::field`) instead.
- `add_trivial_proof_from_source` finds the file by splitting each `link` on
  `curve25519-dalek/`, so `<source_repo>` must be the curve25519-dalek crate
  directory and rows linking anywhere else get an empty `trivial_proof`.
- Step 5 tries a function's bare name before its module path, and keeps one
  atom per name. Two tracked functions with the same name in different
  modules (two `helper`s) get the same atom's metrics, and the match rate does
  not show it. Proof-difficulty rows are keyed by function name alone
  ([#69](https://github.com/Beneficial-AI-Foundation/probegraph/issues/69)).

## Other binaries

`enrich_csv_with_spec_metrics` and `enrich_csv_with_proof_metrics` are an older
two-step route to the same spec and proof columns; `enrich_csv_complete`
replaces them. Only `enrich_csv_with_proof_metrics` writes `proof_overhead`,
the ratio of transitive to direct proof effort. `body_length` from step 2
counts characters, not tokens
([#59](https://github.com/Beneficial-AI-Foundation/probegraph/issues/59)), so
it is not comparable with `halstead_length`.

`categorize_verified_functions <atoms_json> <output_json>` assigns each atom
one of five categories by searching its body text: `verified_with_proof` (has
`proof {`), `verified_with_assume_false`, `trivially_verified` (has `ensures`,
no proof block, no `assume(false)`), `only_requires` and `unspecified`. It
does not run the verifier. `enrich_csv_with_verification_category` adds these
categories to a CSV.
