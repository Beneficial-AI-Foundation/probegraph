# SCIP and Atoms CLI Tools

Three `metrics-cli` binaries that turn a Rust/Verus project into a SCIP index
or atoms JSON. All of them need the
[`scip`](https://github.com/sourcegraph/scip/releases) CLI on `PATH`, except
`detect_unused_specs` when given an existing SCIP JSON; the call graph they
build is described in
[scip-core-architecture.md](scip-core-architecture.md).

`generate_index_scip_json` and `detect_unused_specs` name their outputs after
the last component of the project path. With a path of
`.` (or `..`) there is no such component, so the names fall back to
`output_*` / `project_*` as noted below
([#63](https://github.com/Beneficial-AI-Foundation/probegraph/issues/63)).

## generate_index_scip_json

```bash
cargo run -p metrics-cli --bin generate_index_scip_json -- <project_dir>
```

Runs `verus-analyzer scip <project_dir>`, which leaves `index.scip` in the
current directory, then `scip print --json index.scip`, and writes
`<dir>_index_scip.json` to the current directory (`output_index_scip.json`
for `.`). Needs `verus-analyzer` on `PATH`. The same function is available as
`scip_core::scip_utils::generate_scip_json_index`.

The JSON is the raw SCIP index: documents, symbols and occurrences (each
occurrence is a symbol at a source range, with role bit 1 marking a
definition). It has no call edges; those are derived by `build_call_graph`.

## detect_unused_specs

```bash
cargo run -p metrics-cli --bin detect_unused_specs -- <project_dir> [scip_json]
```

Lists spec and proof functions that no other function calls. Without
`scip_json` it first runs `generate_index_scip_json` on `<project_dir>`. It
then builds the call graph, writes it as `<dir>_atoms.json`, and writes the
report to `<dir>_unused_specs_proofs.json` (`project_atoms.json` and
`project_unused_specs_proofs.json` for `.`), both in the current directory.

Classification is a substring test on the lowercased body:

- spec: contains `spec fn` or `spec(`, starts with `spec `, or contains both
  `#[verifier` and `spec`;
- proof: contains `proof fn`, `fn lemma_` or `fn proof_`, starts with
  `proof `, or contains both `#[verifier` and `proof`.

The two tests are independent, so a function can be reported as both a spec
and a proof. A function is unused when its identifier is in no atom's `deps`.
Visibility comes from the start of the body: `pub(crate)`, `pub open`,
`pub closed`, `pub`, otherwise `private`.

The report has a `summary` (totals, plus `specs_by_visibility` and
`proofs_by_visibility` with keys `public`, `pub_crate`, `pub_open`,
`pub_closed`, `private`), `unused_specs` and `unused_proofs` (each entry has
`identifier`, `display_name`, `visibility`, `file_name`, `relative_path`,
`full_path`, and `declaration`, the first line of the body), and a fixed
`warnings` list. Expect false positives for public API specs, top-level
theorems, and anything referenced only through macros, proof contexts the
index misses, or tests.

In CI, use the reusable
[`detect-unused-specs-with-release.yml`](../../.github/workflows/detect-unused-specs-with-release.yml)
workflow. It runs `detect_unused_specs .`, so its report is
`project_unused_specs_proofs.json`.

## generate_atoms_with_lines

```bash
cargo run -p metrics-cli --bin generate_atoms_with_lines -- <project_dir> <output_json>
```

Indexes with `rust-analyzer scip` (not `verus-analyzer`), run inside
`<project_dir>`, which must contain a `Cargo.toml`. It exits early unless
`rust-analyzer` is on `PATH`. It leaves `index.scip` in
`<project_dir>` and deletes the intermediate `index.scip.json` on success. No
workflow or script calls it.

## Atoms formats

`write_atoms <scip_json> <output_json>` and `detect_unused_specs` write the
body format, which `compute_metrics` and the rest of the
[metrics pipeline](../guides/metrics-pipeline.md) consume. The examples are
for a crate whose name has no digit; for curve25519-dalek the identifiers
keep the version (see below).

```json
{ "identifier": "scalar::Scalar::sub", "statement_type": "function",
  "deps": ["scalar::UnpackedScalar::sub"],
  "body": "fn sub(self, rhs: &'b Scalar) -> Scalar { ... }",
  "display_name": "sub", "full_path": "/abs/path/src/scalar.rs",
  "relative_path": "src/scalar.rs", "file_name": "scalar.rs", "parent_folder": "src" }
```

`generate_atoms_with_lines` writes the lines format, with no body:

```json
{ "display-name": "sub", "visible": true,
  "dependencies": { "scalar::UnpackedScalar::sub": { "visible": true } },
  "code-path": "src/scalar.rs", "code-function": "scalar::Scalar::sub",
  "code-text": { "lines-start": 679, "lines-end": 11 } }
```

`visible` is always `true`. `lines-start` is the 1-based line of the
function's name. `lines-end` is `range[2] + 1` of the same definition
occurrence; SCIP ranges on a single line have three elements
(`[line, start_col, end_col]`), so this is usually the name's end column
plus one, not the last line of the function.

`identifier`, `deps`, the `dependencies` keys and `code-function` all come
from `scip_core::symbol_to_path`, which drops the `rust-analyzer cargo <crate>
<version>` prefix and turns `/` and `#` into `::`. It finds the version by the
first digit in the symbol, so when the crate name has a digit (as
`curve25519-dalek` does) the version stays in: `4.1.3 scalar::Scalar::sub`.
Its `impl#` removal never matches
([#63](https://github.com/Beneficial-AI-Foundation/probegraph/issues/63)).
