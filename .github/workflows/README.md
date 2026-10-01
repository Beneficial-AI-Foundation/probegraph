# Workflows

CI and release workflows for probegraph. To add a call graph to another repo,
use the [CI integration guide](../../docs/guides/ci-integration.md), which also
lists the reusable workflows' inputs.

## Reusable workflows

Called from other repos via `workflow_call`:

- `generate-callgraph.yml` builds the graph for a Rust or Verus project and
  deploys the viewer to GitHub Pages.
- `generate-lean-callgraph.yml` does the same for Lean 4 projects: it runs
  `lake build`, then `probe-lean extract` on the build output (both skipped
  when `pre_built_atoms` is set).
- `detect-unused-specs-with-release.yml` runs `detect_unused_specs` from a
  probegraph release. It is currently broken
  ([#62](https://github.com/Beneficial-AI-Foundation/probegraph/issues/62)).

## Internal workflows

`build.yml` runs on pushes and pull requests to `main`, with three jobs:
`web-tests` (type check and unit tests in `web/`), `web-e2e` (Playwright) and
`build` (clippy, build and test the Rust workspace on Linux, Windows and macOS).
`cargo fmt --check` runs with `continue-on-error`, and the binary smoke tests
at the end of `build` don't check the binaries' exit codes (#62): the Unix
step masks each failure with `|| echo`, and the Windows step fails only on a
missing `.exe` or on the last call's exit code.

`deploy-pages.yml` publishes this repo's demo viewer on pushes to `main` that
touch `web/**`, or by manual dispatch with optional graph URL and source-link
overrides.

`release.yml` runs on a pushed tag matching `v*.*.*`, or by manual dispatch
with a `version` input. It builds the binaries listed in its `Build binaries`
step for Linux x86_64, macOS x86_64 and aarch64, and Windows x86_64, and
attaches one archive per target to a GitHub Release. The archives include
`README.md` and `docs/guides/metrics-pipeline.md`; the `LICENSE*` copy
matches nothing because the repo has no LICENSE file (#62). Tags are the
source of truth for versions; the workspace `Cargo.toml` version is not kept
in sync.

To release, push a tag (`git tag v5.1.0 && git push origin v5.1.0`). A manual
run from the Actions tab must be started with the tag selected as the ref:
the release step takes its tag from the ref, so a run on `main` builds every
target and then fails. The `version` input only names the archives.

## Adding a binary to releases

Add the `[[bin]]` entry in `crates/metrics-cli/Cargo.toml`, then add a
`--bin` flag, the copy lines for both archive steps (Unix and Windows), and
an entry in the release notes' "Tools Included" list in `release.yml`.
