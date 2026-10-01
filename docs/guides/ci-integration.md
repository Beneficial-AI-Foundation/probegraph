# CI Integration Guide

How to generate and deploy an interactive call graph for your Rust, Verus, or
Lean 4 project using the reusable GitHub Actions workflows in this repo. The
workflows run on `ubuntu-latest` and install Linux x86_64 tools, and they
always build the viewer from probegraph's `main` branch.

## One-time setup: enable GitHub Pages

In your repository: **Settings → Pages → Build and deployment → Source:
GitHub Actions**. The workflow needs `pages: write` and `id-token: write`
permissions.

## Workflow file

Every example below is the `jobs:` section of a workflow file like this one:

```yaml
# .github/workflows/callgraph.yml
name: Call Graph

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  callgraph:
    uses: Beneficial-AI-Foundation/probegraph/.github/workflows/generate-callgraph.yml@main
```

With no inputs this builds a Verus project at the repo root and deploys to
`https://YOUR_ORG.github.io/YOUR_REPO/`.

## Rust / Verus projects

For reproducible runs, pin the Verus release:

```yaml
jobs:
  callgraph:
    uses: Beneficial-AI-Foundation/probegraph/.github/workflows/generate-callgraph.yml@main
    with:
      verus_version: '0.2025.11.23.41c5885'
```

For a plain Rust project, use rust-analyzer and skip the Verus-specific steps:

```yaml
jobs:
  callgraph:
    uses: Beneficial-AI-Foundation/probegraph/.github/workflows/generate-callgraph.yml@main
    with:
      use_rust_analyzer: true
      skip_verification: true
      skip_similar_lemmas: true
```

### Rust/Verus workflow inputs

All inputs are optional.

| Input | Description | Default |
|-------|-------------|---------|
| `project_path` | Path to the project relative to repo root | `.` |
| `github_url` | Repo URL for source links | auto-detected |
| `github_branch` | Branch for source links | `main` |
| `github_path_prefix` | Prefix for source file paths (e.g. `curve25519-dalek` when the crate lives in a subdirectory) | `''` |
| `package` | Cargo package name, for workspaces | `''` |
| `use_rust_analyzer` | Use rust-analyzer instead of verus-analyzer | `false` |
| `skip_verification` | Skip the Verus verification step | `false` |
| `skip_similar_lemmas` | Skip similar-lemma enrichment | `false` |
| `verus_version` | Verus release to install (e.g. `0.2025.11.23.41c5885`) | latest release |
| `rust_version` | Rust toolchain (must match the Verus version) | `1.91.0` |
| `deploy_mode` | `standalone` or `subpath` | `standalone` |
| `subpath` | URL subpath when `deploy_mode: subpath` | `callgraph` |

### Base path

The viewer is built for a fixed URL path and shows a blank page when served
anywhere else. In `standalone` mode the path is `/<name>/`, where `<name>` is
the last component of `github_url` (which defaults to the calling
repository). That matches `YOUR_ORG.github.io/YOUR_REPO/`, but not a custom
domain root or a fork whose `github_url` points at an upstream with a
different name. In `subpath` mode the path is `/<subpath>/`, taken literally.

## Lean 4 projects

```yaml
jobs:
  callgraph:
    uses: Beneficial-AI-Foundation/probegraph/.github/workflows/generate-lean-callgraph.yml@main
```

The workflow runs
[probe-lean](https://github.com/Beneficial-AI-Foundation/probe-lean)
`pipeline`, which builds the project with `lake build`, extracts declarations
and dependencies, and maps `sorry` warnings to declarations. Each declaration
gets a verification status (`verified`, `transitively-verified`, `trusted`,
`failed` or `unverified`), colored as for Verus projects. probe-lean's Lean
toolchain is aligned to your project's `lean-toolchain` file; older Lean
versions may need probe-lean source changes.

### Lean workflow inputs

All inputs are optional.

| Input | Description | Default |
|-------|-------------|---------|
| `project_path` | Path to the Lean project relative to repo root | `.` |
| `github_url` | Repo URL for source links | auto-detected |
| `github_branch` | Branch for source links | `main` |
| `github_path_prefix` | Prefix for source file paths | `''` |
| `probe_lean_version` | probe-lean git ref (branch, tag, SHA) | `main` |
| `use_mathlib_cache` | Run `lake exe cache get` before building. Required for Mathlib-dependent projects | `true` |
| `skip_verification` | Skip sorry detection | `false` |
| `pre_built_atoms` | Artifact name with pre-built atoms JSON; skips `lake build` and extraction entirely | `''` |
| `deploy_mode` | `standalone` or `subpath` | `standalone` |
| `subpath` | URL subpath when `deploy_mode: subpath` | `callgraph` |

The [base path](#base-path) rule applies here too.

## Deploying to a subpath of an existing Pages site

If your repo already publishes a Pages site, build the graph in `subpath` mode
and merge its `callgraph-viewer` artifact into your site before deploying:

```yaml
jobs:
  callgraph:
    uses: Beneficial-AI-Foundation/probegraph/.github/workflows/generate-callgraph.yml@main
    with:
      deploy_mode: subpath
      subpath: YOUR_REPO/callgraph

  build-site:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Your existing site build steps here
      - name: Build site
        run: |
          mkdir -p _site
          cp -r docs/* _site/
      - name: Upload site artifact
        uses: actions/upload-artifact@v4
        with:
          name: main-site
          path: _site

  deploy:
    needs: [callgraph, build-site]
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Download main site
        uses: actions/download-artifact@v4
        with:
          name: main-site
          path: site
      - name: Download callgraph viewer
        uses: actions/download-artifact@v4
        with:
          name: callgraph-viewer
          path: site/callgraph
      - name: Upload combined artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: site
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

The graph appears at `https://YOUR_ORG.github.io/YOUR_REPO/callgraph/`.
`subpath` is the full URL path, including the repo name, because it becomes
the [base path](#base-path); on a site served from a domain root use
`subpath: callgraph`.

## Sharing graphs without a deployment

Any deployed viewer can load a graph from a URL with the `?json=` parameter,
so you can host just the JSON (in a repo, a gist, or any static host with
CORS) and share a link:

```
https://YOUR_ORG.github.io/YOUR_REPO/?json=https://raw.githubusercontent.com/you/repo/main/graph.json
```

The [viewer guide](viewer.md) covers what the viewer shows and how source
links are configured.

## Unused specs report

`detect-unused-specs-with-release.yml` runs `detect_unused_specs` from a
probegraph release (inputs `project_path`, default `.`, and
`scip_callgraph_version`, a release tag, default `latest`) and uploads an
`unused-specs-report` artifact. It is currently broken: it downloads a scip
asset that does not exist and never installs verus-analyzer
([#62](https://github.com/Beneficial-AI-Foundation/probegraph/issues/62)).

## Troubleshooting

**verus-analyzer fails.** Check the project analyzes locally with
verus-analyzer. If it is not a Verus project, set `use_rust_analyzer: true`.

**rust-analyzer fails.** Make sure the project compiles with `cargo check`.
Verus-specific syntax needs verus-analyzer (the default).

**Verification times out.** Set `skip_verification: true` to generate the
graph structure without verification.

**Similar lemmas missing.** Set `skip_similar_lemmas: true` if the Python
setup fails.

**Lean build fails on a Mathlib project.** Leave `use_mathlib_cache` at its
default (`true`); building Mathlib from source usually exceeds runner limits.

**Pages deploy fails or 404s.** Check the Actions log for the failed job and
confirm the Pages source is "GitHub Actions". First deployments can take
5-10 minutes. A blank page usually means the [base path](#base-path) does
not match the URL.

**Changing the viewer itself.** See [web/README.md](../../web/README.md) for
building and testing it locally.
