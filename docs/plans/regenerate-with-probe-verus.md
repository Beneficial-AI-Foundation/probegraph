# Regenerate with `probe-verus extract` instead of `pipeline`

Status (2026-10-02): proposal. Nothing implemented. Decisions marked
"open" at the end need an answer before Phase 1.

Goal: "Regenerate Index" in the extension and the reusable
`generate-callgraph.yml` produce a probe-verus extract (the schema-2
envelope the viewer, the editor lookup and probe-lean already use) by
running a released `probe-verus` binary, and probegraph stops carrying its
own Rust call-graph builder for that purpose.

## Where we are

`crates/metrics-cli/src/bin/pipeline.rs` (added 2025-12-22) is what
"Regenerate" and `generate-callgraph.yml` run. It is a thinner, older
re-implementation of `probe-verus extract`, built from probe-verus's own
library functions:

1. `verus-analyzer scip .` and `scip print --json`, always, unless
   `--use-cached-scip` (the extension never passes it).
2. probe-verus's `parse_scip_json`, `build_call_graph`,
   `convert_to_atoms_with_parsed_spans`, `add_external_stubs`, then
   `scip-core`'s `atoms_to_d3_graph` to flatten the atoms into the viewer's
   legacy `{nodes, links, metadata}` format.
3. `cargo verus verify` through probe-verus's `VerusRunner`, then a re-read
   of the written graph to patch `verification_status` onto nodes by
   matching `(display_name, path)` pairs, falling through four heuristics;
   the last two match by bare name alone when that name has one status.
4. Optionally `uv run scripts/enrich_graph_with_similar_lemmas.py` (vstd
   similar lemmas). On by default in both callers.

`probe-verus extract <project>` (v8.0.1, released for five targets with
installers and sha256 sums) does the same work and more: atomize with the
`scip_cache` staleness check (an unchanged tree is not re-indexed),
specify (spec classification, taxonomy), run-verus with statuses written
onto the atoms directly, transitive status propagation, optional
`cargo public-api` for real `is-public-api`, and the envelope with
`timestamp`, `source.repo`, `source.commit`, package name and version.
Output goes to `<workspace root>/.verilib/probes/verus_<pkg>_<ver>.json`;
there is no `--output` flag (probe-lean has `-o`).

What `pipeline` has that `extract` lacks: `--github-url` (the viewer takes
`github_url` from the envelope's `source.repo`, and CI passes
`VITE_GITHUB_URL` anyway) and the similar-lemmas step.

What the viewer and extension lose with a `pipeline` graph: the envelope.
`parseAndNormalizeGraph` maps `verification-status`, `kind`, line ranges,
`is-public-api`, `is-hidden` and `source.repo` from an extract; the
extension's status bar and "not in graph" message read `extracted_at` and
`source_commit`, which only the envelope carries, so a `pipeline` graph
shows "unknown". The repo README already says the viewer's primary input
is probe atom JSON.

Measured 2026-10-02 on `dalek-verus` (120 files, 138k SCIP occurrences,
1,929 nodes / 11,800 edges), default "Regenerate" settings:

| Step | Wall | CPU | RSS |
|---|---|---|---|
| `verus-analyzer scip .` | 32 s | 51 s | 916 MB |
| `scip print --json` (17.7 MB) | 0.3 s | | |
| `pipeline.rs` itself (parse, graph, `verus_syn` spans, D3, write 6 MB) | 0.84 s | 0.75 s | 74 MB |
| `cargo verus verify` (2,063 functions) | 91 s cold, 62 s warm | 429–511 s | 2.7 GB |
| enrich round-trip | < 1 s | | |

The pipeline's own code is under 1% of a 95–125 s run. The cost is in
what it runs and that it runs all of it, serially, every time. Those two
problems are the same in `probe-verus extract` and are fixed in one place
if they are fixed there.

Callers today: `vscode/src/pipelineRunner.ts` (needs a probegraph checkout
built with `cargo build --release`, found through `CARGO_TARGET_DIR`,
`<repo>/target` or `cargo metadata`), and `generate-callgraph.yml`, used
with `@main` by `libsignal_focus_dalek_lite`, `pmemlog_with_callgraph` and
`spqr_with_callgraph`.

## Design

### Extension

- A new setting `callGraph.probeVerusPath` (default `probe-verus`, i.e. on
  `PATH`). `callGraph.defaultScipCallgraphPath` is marked deprecated with
  a message pointing at the new one; it is no longer read.
- "Regenerate" runs `probe-verus extract <folder> -o <temp> [-p <pkg>]
  [--skip-verify] [--rust-analyzer]`, no shell, trusted workspaces only,
  and renames the temp file over `indexPath` on success as today.
  `callGraph.skipVerification` maps to `--skip-verify`. A new
  `callGraph.useRustAnalyzer` (default false) maps to `--rust-analyzer`
  for plain Rust projects. `callGraph.skipSimilarLemmas` is removed (see
  open decision 1).
- Until probe-verus has `-o`, the runner reads the `Primary output:` line
  from stdout and moves that file to the temp path. This is the fallback,
  not the design.
- "Check Prerequisites" runs `probe-verus --version` and
  `probe-verus setup --status --from-project <folder>` and shows the
  result. When tools are missing it offers to run
  `probe-verus setup --from-project <folder>`, which downloads
  verus-analyzer, scip, Verus and the matching Rust toolchain; that runs
  only after an explicit click and in a trusted workspace, and its output
  goes to the output channel.
- Project root rule for a Rust/Verus extract, inserted as rule 3 beside
  the Lean one: the topmost directory with a `Cargo.toml` between the
  index file and the workspace folder. probe-verus writes paths relative
  to the workspace root (`resolve_workspace_root`), which is the topmost
  one, and puts the index under that root's `.verilib/probes/`.
- `hasGenerator` is true for `rust` when `probe-verus` resolves (configured
  path exists, or `which` finds it). The "not in graph" message keeps its
  **Regenerate** button under that condition.
- Status bar item label "Pipeline: …" becomes "probe-verus: …".
  `pipelineRunner.ts` is renamed `generator.ts`; the output channel stays
  "Call Graph Pipeline" so existing users find it.
- The default `callGraph.indexPath` stays `.vscode/call_graph_index.json`;
  the file is an extract now, which the loader already accepts. Users who
  already run `probe-verus extract` themselves can instead point
  `indexPath` at `.verilib/probes/verus_<pkg>_<ver>.json`, as the README
  tells Lean users to do with probe-lean.

### `generate-callgraph.yml`

- New input `probe_verus_version`, default pinned to the latest release
  (`v8.0.1` at the time of writing). The job downloads
  `probe-verus-x86_64-unknown-linux-gnu.tar.xz` and its `.sha256` from
  that release and checks the sum. No probegraph Rust build; the checkout
  of probegraph is still needed for `web/`.
- The existing tool-install steps (verus-analyzer or rust-analyzer, scip,
  Verus with `verus_version` / `rust_version`) stay as they are in this
  phase; switching them to `probe-verus setup --from-project` is a
  follow-up once the step is seen working in CI.
- Runs `probe-verus extract "$PROJECT_PATH" -o web/public/graph.json
  [-p "$PACKAGE"] [--skip-verify] [--rust-analyzer]` from the probegraph
  checkout. `github_url` is still passed to the viewer build via
  `VITE_GITHUB_URL`; the extract carries `source.repo` as well.
- Inputs keep their names so the three `@main` consumers keep working.
  `skip_similar_lemmas` stays declared and is ignored, with a notice in
  the log (open decision 1).

### probegraph cleanup

- Remove `pipeline` from `metrics-cli` and `atoms_to_d3` from `scip-core`
  (its only user). Neither is in the Rust release. Update
  `docs/technical/scip-core-architecture.md`, the root README and
  `docs/guides/ci-integration.md`.
- Remove `scripts/enrich_graph_with_similar_lemmas.py`, the
  `external/verus_lemma_finder` submodule and the `enrich` extra in
  `pyproject.toml` if decision 1 says drop; otherwise adapt the script to
  the envelope (open decision 1).

## Phases

### Phase 0: probe-verus `--output`

`probe-verus extract -o/--output <path>`, mirroring probe-lean. Small; a
probe-verus PR and a release. Phases 1 and 2 use the `Primary output:`
fallback if this is not released first, and drop the fallback when it is.

### Phase 1: extension

1. `generator.ts` with the command, settings, prerequisites and root rule
   above; `package.json` settings and deprecation; README Quick Start
   rewritten (install probe-verus with its release installer or
   `cargo install --git`, run "Check Prerequisites", "Regenerate");
   CHANGELOG; version bump so
   the merge releases it.
2. Tests in real VS Code, replacing the two that build a fake `pipeline`
   under a fake target dir: `callGraph.probeVerusPath` points at a fake
   script that checks its arguments (a path with a space and `;` arrives
   as one argument, `-o` is a temp file beside the index, `--skip-verify`
   follows the setting) and writes an envelope; the index is replaced
   only when the script exits 0; the Lean test still shows that no
   generator is started on a Lean graph; a workspace fixture with a
   member crate checks the Cargo root rule picks the workspace root.
3. Manual check on `dalek-verus`: Regenerate, status bar shows the extract
   time and commit, "Show at Cursor" resolves, verification colours match
   `probe-verus extract` run by hand.

### Phase 2: CI workflow

1. The download, checksum and `extract` steps; `probe_verus_version`
   input; `skip_similar_lemmas` notice; `docs/guides/ci-integration.md`,
   `examples/*.yml` and `.github/workflows/README.md`.
2. `test-callgraph-local.yml` (or a dispatch of the reusable workflow on
   `examples/quicksort`) runs green; then one dispatch on a consumer
   (`spqr_with_callgraph` or `pmemlog_with_callgraph`) before announcing.
3. Record the CI wall time before and after: the probegraph `cargo build
   --release --bin pipeline` step and the `uv sync --extra enrich` +
   maturin step disappear.

### Phase 3: cleanup

The removals above, after Phases 1 and 2 have been in `main` for a release
cycle of the extension (so a user on the previous VSIX can still build
`pipeline` from a tagged commit if they must).

### Later

- The extension downloads `probe-verus` itself, with the same rules the
  editor plan gives CI graph downloads (`https` only, trusted workspace,
  size limit, sha256 from the release, extension global storage).
- Incremental verification in probe-verus for the on-save case:
  `--verify-only-module` / `--verify-function` exist in its runner, and
  the call graph it just built says which functions depend on the changed
  ones, so the affected set is computable. This turns the 62 s warm
  re-verify above into seconds for a one-file edit and makes
  `callGraph.autoRegenerateOnSave` usable. A verification-result cache
  keyed by source hash and Verus version is the simpler first step.
  Running SCIP and verification concurrently (independent inputs) is a
  few lines and takes a default run from ~95 s to ~63 s.

## Risks

- `probe-verus extract` writes `.verilib/probes/*_atoms.json`, `_specs`,
  `_proofs` and `_extract_summary` next to its primary output, inside the
  user's project. With `-o` elsewhere those intermediates still land in
  `.verilib/probes/`. Users may want them in `.gitignore`; the README
  says so.
- A workspace with several Verus packages needs `-p`; the extension has
  no UI for it today (options.package exists, nothing sets it). A quick
  pick over `cargo metadata` members when the extract fails with the
  workspace error is a follow-up.
- The three `@main` consumers change behaviour on merge. The extract
  gives them better data but a different file shape; their viewer builds
  come from the same probegraph checkout, so they stay consistent.
- probe-verus's `--auto-install` is deprecated in favour of `setup`;
  the plan uses `setup`, not the flag.

## Open decisions

1. **Similar lemmas.** The only consumer is a section in the viewer's
   node tooltip (`main.ts` ~2951). It costs a Python environment and the
   `verus_lemma_finder` submodule in CI and a `uv` install for extension
   users. Recommendation: drop it, and remove the script, submodule and
   extra in Phase 3. The alternative is a post-processing step that reads
   and writes the envelope and a `similar-lemmas` field carried through
   normalization.
2. **Pin or latest.** CI pins `probe_verus_version` with an input to
   override (recommended; a probe-verus release cannot break a consumer's
   pages build). The extension uses whatever `probe-verus` the user has
   and shows its version in "Check Prerequisites".
3. **Phase 0 first, or ship the fallback.** Waiting for `-o` in a
   probe-verus release makes the extension change cleaner; the fallback
   costs about twenty lines and a test. Recommendation: open the
   probe-verus PR now and implement Phase 1 against the fallback only if
   the release has not happened by the time Phase 1 is ready.
