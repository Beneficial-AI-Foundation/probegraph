# probegraph web viewer

Interactive D3 visualization for probe graphs: Rust/Verus call graphs from
SCIP, Lean atom graphs from probe-lean, and merged cross-language graphs.
Usage is documented in [docs/guides/viewer.md](../docs/guides/viewer.md);
this file covers development.

## Quick start

```bash
npm install
npm run dev          # opens http://localhost:3000/probegraph/
```

The Vite base path is `/probegraph/` (the Pages subdirectory) in dev too.

Other scripts (see `package.json`):

```bash
npm run build         # production build to dist/
npm run build:vscode  # VS Code webview build to dist-vscode/
npm run type-check    # tsc --noEmit
npm test              # vitest, watch mode
npm run test:run      # vitest, single run
npx playwright test   # e2e suite in e2e/ (starts its own server on port 3001)
```

## CI and deploy

`.github/workflows/build.yml` runs on pushes and pull requests to main. Its
`web-tests` job runs `type-check` and `test:run`; its `web-e2e` job ("Web
Viewer E2E") runs the Playwright suite on Chromium and uploads the results on
failure.

`.github/workflows/deploy-pages.yml` deploys to GitHub Pages on pushes to
main that touch `web/`, or by manual dispatch. It runs the type check and
unit tests, then builds with `VITE_GRAPH_JSON_URL`, `VITE_GITHUB_URL` and
`VITE_GITHUB_PATH_PREFIX` set from the dispatch inputs or their defaults.

## Demo graph

`public/graph.json` is auto-loaded on startup and is the graph shown on the
GitHub Pages deploy (currently probe-lean output; check its `tool` field for
provenance). Files served from `public/` land at the site root, so any
`public/*.json` can be loaded via `?json=./name.json`. Don't commit ad-hoc
local graphs.

## Documentation

- [docs/guides/viewer.md](../docs/guides/viewer.md) — user guide: views,
  filters, URL parameters, sharing.
- [ARCHITECTURE.md](ARCHITECTURE.md) — input formats, modules, data flow.
- [QUERY_PIPELINE.md](QUERY_PIPELINE.md) — the query and filter engine.
- [docs/technical/](docs/technical/README.md) — layout and colouring
  algorithms per view.
- [docs/guides/vscode-extension.md](../docs/guides/vscode-extension.md) —
  the VS Code webview integration.

## Troubleshooting

- **Nothing renders after loading a file** — check the browser console; the
  loader warns about formats it doesn't recognise (see
  [Input formats](ARCHITECTURE.md#input-formats)).
- **"Large Graph Detected" prompt or a partial view** — see
  [Large graphs and the seeded view](../docs/guides/viewer.md#large-graphs-and-the-seeded-view)
  and [Loading a graph](../docs/guides/viewer.md#loading-a-graph).
