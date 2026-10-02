# Editor → graph: open the call graph from a Rust, Verus or Lean construct

Status (2026-10-02): Phases 0 to 3 are implemented. Phase 0 merged in #67
and Phase 2 in #70; the protocol is in `docs/guides/vscode-extension.md`.
Phase 1 is done, with fixtures cut from secure-messaging's extracts. The
old repo was archived on 2026-10-02 with a pointer README. Phase 3 (the
extension's first release) is in #72: the
session, the host side of the protocol, project-root and containment
rules, the watcher, "Show at Cursor" with its keybinding and menus, the
panel beside the editor, the status bar, and the integration tests listed
in that phase. The performance numbers are at the end of Phase 3. What is
left before a release is tagging a VSIX. Revised on 2026-10-01 after a
Codex review; see "Review decisions" at the end, and "Decisions" before
that.

Goal: with the cursor on a declaration in a Rust, Verus or Lean file, one
keystroke shows that declaration's neighbourhood in a graph panel beside the
code, and clicking a node jumps back to the source without hiding the graph.
Later: CodeLens, following the cursor, and fetching graphs built in CI.

## Where we were

The seven points below were found on 2026-10-01 and are all addressed by
Phases 0 to 3 (see each phase for where). Kept as the record of what the
design answers.

Tested on 2026-10-01 against probegraph `main` (6fd5708) and
`call_graph_vs_code_extension` `main` (de17d69):

- In a real VS Code 1.102.3, with an index built by `pipeline` from
  `examples/quicksort`, "Show Call Graph" on `partition` resolves the node by
  file and line and opens the panel.
- The current `dist-vscode` build, loaded with the HTML and CSP that
  `webviewLoader.ts` produces, sends `ready`, renders the exact-node
  neighbourhood, round-trips **Open in Editor** to `navigate` (the extension
  opened `src/lib.rs:14`), and applies `setQuery`.
- The extension's own 22 tests pass but are placeholders: none loads a graph
  or the webview.

What stands between that and the goal:

1. **Lean is blocked in three places.**
   - Every command and menu entry has `editorLangId == rust`, and
     `showCallGraph` rejects other languages. Lean files are `lean4`.
   - `indexLoader.ts` only reads the flat D3 format (`graph.nodes`). A
     probe-lean or probe-verus extract (schema-2 envelope around an atom
     dict) and a probe-leanblueprint extract fail on `graph.nodes.length`.
     The viewer's `parseAndNormalizeGraph` reads all of them, and atoms
     carry `code-path` and `code-text.lines-start/end`.
   - "Regenerate Index" only runs probegraph's Verus/SCIP `pipeline`.
2. **Cursor lookup is fragile.** `findNodeAtPosition` keeps the path after
   `/src/`, otherwise falls back to the first file with the same basename.
   Lean paths have no `/src/` and basenames repeat (the SPQR extract has 8
   `Basic.lean` and 13 `IntoPb.lean`). Line ranges are written into a map
   last-wins, so nested or generated declarations sharing a range overwrite
   the one the user meant. After an edit, line numbers drift.
3. **The interaction is clunky.**
   - Right-click → "Call Graph" submenu → command, then a progress
     notification. No keybinding.
   - The panel opens in `ViewColumn.One`, on top of the code. `navigate`
     also opens files in `ViewColumn.One`, which then covers the graph.
   - Every "Show Call Graph" re-posts the whole graph.
4. **Lifecycle and safety problems in the current extension** (found in
   review):
   - The panel's `ready` handler captures the index and options from panel
     creation (`webviewLoader.ts` ~line 77); a later reload of the webview
     restores that stale state.
   - One cached index, one watcher, and `workspaceFolders[0]` for
     navigation and regeneration, while lookup uses the editor's folder.
   - The watcher handles change and delete but not create, and never tells
     the panel about a new graph.
   - `pipelineRunner.ts` spawns with `shell: true`, so a workspace path with
     shell metacharacters changes the command.
   - `navigate` joins a webview-supplied path to the workspace root without
     checking it is in the graph or under the root.
   - `indexPath` may be absolute or contain `..`.
5. **The viewer's normalization loses data the editor needs.**
   - Atom normalization does not copy `is-hidden`, `is-lean-generated` or
     `is-aeneas-generated` (`convertAtomDictToD3Graph`, `graph-loader.ts`
     ~line 305).
   - All three loaders set `metadata.generated_at` to the load time; the
     envelope's `timestamp` and `source.commit` are dropped.
   - The parser does not validate: `{ nodes: [{}] }` and unknown formats
     pass through as a `D3Graph`.
6. **The bundled viewer drifts.** `webview/` in the extension is a manual
   copy of `web/dist-vscode`, older than `main`, with uncommitted changes
   that match neither commit.
7. **Small things.** `index.html` loads Inter from Google Fonts, which the
   webview CSP blocks. The extension README and settings still say
   "scip-callgraph". The viewer ignores VS Code's colour theme.

## Scope

**First release (Phases 0 to 3):** "Show at Cursor" for Rust, Verus and Lean
against a local graph file, in one workspace folder, with a known project
root, validated input, conservative resolution, a revision-aware panel
protocol, and the panel beside the editor.

**Later (Phase 4):** CodeLens, follow mode, downloading CI graphs, a local
probe-lean generator. Each needs the revision-aware protocol and measured
performance first.

**Not planned:** several workspace folders at once, remote workspaces (SSH,
containers, WSL), merged Rust + Lean graphs whose sources live in different
roots. The extension says so instead of guessing.

## Design

### One workspace folder per session

A panel session is bound to one workspace folder and one graph source
(`callGraph.indexPath`, read with that folder as the configuration scope).
"Show at Cursor" from a file in another folder asks whether to switch the
session; switching reloads the graph. Navigation, regeneration and the
watcher all use the session's folder, never `workspaceFolders[0]`.

`indexPath` must resolve inside the folder (or the extension's storage, for
downloads later). Anything else is rejected with a message.

Only `file:` URIs are supported.

### Project root

Graph paths are relative to the analysed project root. The root is, in
order:

1. `callGraph.projectRoot` (relative to the folder), if set.
2. For a SCIP index, `metadata.project_root` if it is an existing directory
   inside the folder. A root from another machine (CI) is ignored.
3. For a Lean extract, the Lake root that contains the index file's
   folder, if there is exactly one.
4. Otherwise the workspace folder.

A file's graph path is its path relative to the root, with `/` separators.
There is no suffix or basename matching. If the file's graph path has no
nodes, the status is "file not in graph" and the message names the root in
use and the setting that changes it.

The same root maps `navigate` paths back. A `navigate` path must be a
`relative_path` of some node in the session's graph and resolve under the
root; anything else is refused.

### Editor location data from normalization

`parseAndNormalizeGraph` gains three things, each with a unit test from a
raw extract:

- Atom nodes keep `is_hidden` and `is_generated` (`is-lean-generated` or
  `is-aeneas-generated`).
- `metadata.extracted_at` and `metadata.source_commit` from the envelope's
  `timestamp` and `source.commit`, absent when the input has none.
  `generated_at` stays as it is for the viewer; the editor reads only the new
  fields and shows "unknown" when they are absent.
- A `validateGraph` that rejects input with no recognised format, nodes
  without a string `id`, or links to unknown IDs beyond a small fraction.
  The extension refuses graphs that fail; the viewer only logs.

### Cursor → node lookup

New pure module `web/src/editor-lookup.ts`, bundled into the extension:

```typescript
export interface LocationIndex { /* file → ranges sorted by size, file → names */ }
export function buildLocationIndex(graph: D3Graph): LocationIndex;
export function nodesInFile(index: LocationIndex, graphPath: string): D3Node[];
export function resolveCursor(index: LocationIndex, q: {
  graphPath: string;
  line: number;
  symbol?: { name: string; containers: string[] };
}): Resolution;

type Resolution =
  | { kind: 'match'; node: D3Node; evidence: 'symbol' | 'symbol+line' | 'line' }
  | { kind: 'ambiguous'; candidates: D3Node[] }
  | { kind: 'not-indexed'; reason: 'file' | 'symbol' | 'line' };
```

Rules:

1. Candidates by line: nodes in the file whose range contains the line,
   innermost first. Hidden and generated nodes count only if nothing else
   matches.
2. With an enclosing symbol from the document symbol provider (both
   `DocumentSymbol[]` and flat `SymbolInformation[]`), keep candidates whose
   `display_name` equals the symbol name. Containers break ties against the
   node ID. If the line candidates exist but none has that name, the result
   is `not-indexed: 'symbol'`: the declaration was probably renamed or added
   since the graph was built, and a line match would be wrong.
3. With a symbol but no line candidates, nodes in the file with that name
   are candidates (the lines shifted). One is a `match`, several are
   `ambiguous`.
4. Without a symbol provider, line candidates decide alone, evidence
   `line`.

There is no global name lookup on the cursor path. Searching the whole
graph by name stays a separate, explicit command ("Call Graph: Find…").

The graph has line granularity only, so two declarations on one line are
`ambiguous`.

### Panel protocol

Every `loadGraph` carries a `revision` (incremented per graph the host
loads) and every selection a `requestId`:

```typescript
// host → webview
{ type: 'loadGraph', revision: number, graph: unknown, selection?: Selection, requestId?: number }
{ type: 'selectNode', revision: number, requestId: number, selection: Selection }
{ type: 'relaxFilters', revision: number, keys: string[] }
type Selection = { nodeId: string; direction: 'both' | 'callees' | 'callers' | 'none'; depth: number };

// webview → host
{ type: 'ready' }
{ type: 'graphLoaded', revision: number, nodes: number }
{ type: 'selectResult', revision: number, requestId: number,
  status: 'shown' | 'filtered' | 'missing', filteredBy?: string[] }
{ type: 'navigate', revision: number, relativePath: string, startLine?: number, endLine?: number, displayName: string }
{ type: 'requestRefresh', revision: number }
```

- On `ready`, the host sends the session's current graph and latest
  selection (read at that moment, not captured at panel creation).
- The host holds at most one pending selection until `graphLoaded` for the
  current revision arrives, then sends it. Newer selections replace it.
- The webview ignores `selectNode` for a revision other than the one it has
  loaded. The host ignores results for an old revision or a superseded
  request, and `navigate` / `requestRefresh` for a revision other than its
  current graph's (the path would resolve against the new graph's root).
- A selection equal to the last one is sent again: the viewer may have
  moved away from it on its own (node hidden, depth changed, filter
  ticked), and a `selectNode` costs ~44 ms.
- On disposal the session drops the pending selection; a new panel starts
  from `ready`.

Viewer side, a selection from the editor:

- switches to the code layer;
- removes the selected node from the hidden-node set;
- leaves kind, verification and edge filters alone, but if the node is
  still not drawn replies `filtered` with the filter names, and the
  extension shows "partition is hidden by the Spec filter" with a button
  that turns that filter on;
- uses the selection's depth, which is always finite (the `callGraph.depth`
  setting, default 3). The current "omitted depth means unlimited" rule for
  directional exact selections does not apply to editor selections.

`loadGraph` without `revision` keeps today's behaviour for other hosts.
A selection in `loadGraph` is answered like a `selectNode` when it carries a
`requestId`, after `graphLoaded`.

`filteredBy` names the `FilterOptions` keys to relax so that the node is
drawn: those that each do it on their own (`showSpecFunctions`,
`excludeNamePatterns`, ...), or, when none does alone, a set that does
together (every node filter relaxed, then each put back while the node
stays drawn). It is empty when no node filter is responsible.

### Index updates

- The watcher handles create, change and delete, and debounces 500 ms.
- A new file is read asynchronously, parsed and validated before it
  replaces the session's graph. On failure the last good graph stays and
  the status bar says the new file is invalid.
- A successful replacement increments the revision and sends `loadGraph`
  with the current selection.
- "Regenerate" runs the generator with output to a temp file in the same
  directory and renames it over `indexPath` on success. With several
  windows, the last rename wins; each window reloads.
- Generators run with `spawn(command, args)` and no shell, and only in
  trusted workspaces.

### Interaction (first release)

- "Call Graph: Show at Cursor", default keybinding `ctrl+alt+g` /
  `cmd+alt+g`, at the top level of the editor context menu, and as an
  editor-title icon for Rust and Lean files. The three direction commands
  stay in the palette.
- An `ambiguous` result shows a quick pick; `not-indexed` shows a message
  naming the reason and the graph's `extracted_at` / `source_commit`
  ("unknown" when absent), with **Regenerate** if a generator is
  configured.
- The panel opens with `ViewColumn.Beside` and `preserveFocus: true`.
  `navigate` opens files in the group of the most recent text editor if
  that group does not contain the panel; otherwise in a new group beside
  it.
- Status bar: index state (loaded, loading, invalid, none) and
  `extracted_at` when known. It does not run cursor lookup in the first
  release.

### Where graphs come from (first release)

A local file at `indexPath`, in any format the viewer reads:

- Rust/Verus: probegraph `pipeline`, run by "Regenerate". Binary lookup
  honours `CARGO_TARGET_DIR` and `cargo metadata` instead of assuming
  `<repo>/target/release/pipeline`.
- Lean: produced outside the extension (`probe-lean extract`, or downloaded
  by hand from CI). "Regenerate" says how.

## Phases

### Phase 0: move, build and test baseline

1. Preserve the extension's uncommitted `webview/` changes. Done: branch
   `wip/webview-uncommitted-2026-02` in the old repo, pushed with the
   `webview/` snapshot (`bff8586`) and an untracked design note from
   December 2025.
2. Move the extension to `vscode/` with its filtered history. `webview/`
   is no longer tracked: `npm run build` in `vscode/` runs
   `npm run build:vscode` in `web/` and copies `web/dist-vscode` to
   `vscode/webview/`. Commit the test config (`.vscode-test.mjs`, which the
   old repo's `.gitignore` excluded).
3. CI job for `vscode/`: lint, compile, tests in VS Code under `xvfb-run`,
   and `vsce package`. Packaging refuses a dirty tree, so a VSIX always
   matches a commit.
4. Turn the 2026-10-01 ad-hoc checks into tests:
   - `web/e2e/vscode-webview.spec.ts` on the dev server with a stubbed
     `acquireVsCodeApi`: `ready`, VS Code header and hidden file picker,
     render after `loadGraph`, `navigate` after **Open in Editor**,
     `setQuery`, `refresh`.
   - The extension's CSP is covered in real VS Code instead: the workspace
     suite (copy of `vscode/test-fixtures/quicksort`) checks that "Show Call
     Graph" opens the tab and the bundled viewer posts `ready`, seen through
     the API `activate()` returns. It also checks every contributed command
     is registered, and that "Regenerate" passes a path with a space and a
     `;` as one argument.
   - Placeholder tests deleted; the `formatTimestamp` tests kept.
5. Rename scip-callgraph → probegraph in the extension README and settings
   text (the setting key `callGraph.defaultScipCallgraphPath` stays). Drop
   the Google Fonts links from the VS Code build.
6. Remove `shell: true` from `pipelineRunner.ts`.
7. Archive the old repo with a README pointing to `probegraph/vscode`.
   Done 2026-10-02.

### Phase 1: normalization and lookup (probegraph)

1. Normalization changes: `is_hidden`, `is_generated`, `extracted_at`,
   `source_commit`, `validateGraph`. Tests from raw extracts.
2. `editor-lookup.ts`, tested from raw extracts through normalization:
   - duplicate basenames in different directories;
   - nested and shared ranges, hidden and generated atoms;
   - symbol name matching after shifted lines;
   - a renamed declaration (line candidates with another name →
     `not-indexed`);
   - repeated method names in two `impl` blocks of one file;
   - Lean namespaces as containers;
   - two declarations on one line → `ambiguous`.
3. Fixtures: the quicksort SCIP index, a probe-lean extract cut from
   `web/src/test-data` with hidden and generated atoms, a
   probe-leanblueprint extract.

### Phase 2: panel protocol (probegraph viewer)

1. `revision` on `loadGraph`, `selectNode`, `graphLoaded`, `selectResult`,
   the editor-selection rules (layer, hidden set, filtered report, finite
   depth).
2. Document in `docs/guides/vscode-extension.md`.
3. e2e tests: selection sent before `graphLoaded` is applied after it; a
   `selectNode` for an old revision is ignored; a node hidden by
   shift-click is shown again; a Spec node with Spec off yields `filtered`;
   the drawn graph contains the node for `shown`.

### Phase 3: extension, first release

Implemented in #72. Where things ended up:

1. `session.ts`: `GraphSession` (one folder, one graph file, revision per
   read, last good graph kept) and `Sessions` (the one active session, the
   switch prompt, the status bar). `indexLoader.ts` reads asynchronously
   and holds the `indexPath` and project-root rules. `webviewLoader.ts` is
   the host side of the protocol: `loadGraph` only for an unconfirmed
   revision, one pending selection until `graphLoaded`, stale results and
   stale `navigate`s dropped, everything reset on disposal. A session is
   rebound only when `callGraph.indexPath` or `callGraph.projectRoot`
   changes, and reads its file right away.
2. Project root rules as designed; `navigate` paths must be in the graph's
   path set and under the root (lexically); `indexPath` must be inside the
   folder. `callGraph.projectRoot` moves the `navigate` boundary, so it is
   a restricted configuration: in Restricted Mode the workspace value is
   ignored.
3. The watcher handles create, change and delete with a 500 ms debounce,
   plus a 2 s `fs.watchFile` stat poll because `fs.watch` fails where
   inotify watches run out (it did on the development machine). Each read
   records the file's `mtimeMs`, `size` and `ino`; a notification for a
   file with the same stamp is not read again, so one write costs one read
   whichever watcher reports it, and a file that goes and comes back
   unchanged is read because the stamp of a missing file is null.
   "Regenerate" writes `.<index>.<pid>.tmp` beside the index and renames it
   over on success; generators need `workspace.isTrusted`
   (`capabilities.untrustedWorkspaces: limited`). The `pipeline` binary is
   looked up under `CARGO_TARGET_DIR`, then `<repo>/target`, then
   `cargo metadata`'s `target_directory`. On a Lean graph (or, before one
   is loaded, in a `lean4` editor) "Regenerate" says to run
   `probe-lean extract` and spawns nothing.
4. "Call Graph: Show at Cursor" with `ctrl+alt+g` / `cmd+alt+g`, at the top
   of the editor context menu and as an editor-title icon for `rust` and
   `lean4`. The `lean4` language ID comes from vscode-lean4; the extension
   does not contribute it, so a user without vscode-lean4 is not shown a
   "Lean 4" mode with no language support behind it. The Lean test suite
   loads a fixture extension (`test-fixtures/lean4-language/`) that
   contributes only the ID.
5. Panel with `ViewColumn.Beside` and `preserveFocus`; `navigate` opens in
   the last text editor's group unless the panel is there. A `filtered`
   result shows which filters hide the node with a "Show it" button that
   sends the new `relaxFilters` message to the viewer.

Integration tests (real VS Code), all in `vscode/src/test/`:

- Rust and Lean fixtures resolve the cursor; the Lean test runs once
  without a symbol provider (line evidence) and once with symbols supplied
  by a stub provider registered in the test.
- A second "Show at Cursor" sends `selectNode`, not `loadGraph`; an equal
  one is sent again.
- Rapid selections: only the last one is shown.
- Replacing the index file during a lookup: the panel ends on the new
  revision with the latest selection.
- One write to the index is read once, though two watchers report it.
- An invalid index file leaves the previous graph loaded.
- `navigate` with a path outside the graph, or for a stale revision, is
  refused.
- A settings change that does not name the file keeps the graph loaded.
- Two workspace folders with the same relative paths: navigation opens the
  session folder's file.
- Closing and reopening the panel.
- "Regenerate Index" on a Lean graph does not start the pipeline.

Measured on 2026-10-02 (host: node 22 against the compiled loader; webview:
Chromium through the Playwright harness of `web/e2e/vscode-webview.spec.ts`,
which is the same renderer as the webview):

| Graph | Size | Nodes / links | Host blocking (parse + normalize + validate + index) | `loadGraph` → `graphLoaded` | `selectNode` → `selectResult` (depth 3) | Page JS heap after load |
|---|---|---|---|---|---|---|
| SPQR `lean_Spqr_0.1.0_ec-bridge.json` | 5.1 MB | 2,907 / 13,530 | 53 ms (12 parse, 39 normalize) | 130 ms | 44 ms | 6 MB |
| secure-messaging `probe-lean-extract.json` | 7.3 MB | 2,313 / 27,706 | 70 ms | not measured | not measured | |
| `web/public/graph_fixed.json` (libsignal SCIP index) | 32 MB | 22,109 / 48,923 | 82 ms (59 parse, 21 validate) | no `graphLoaded` after 9 min | | |

Cursor lookup (`resolveCursor`) is 1 to 3 µs on every graph. Host-side
cost is small; the viewer is the limit: its synchronous `loadGraph` on the
22k-node graph kept Chromium's main thread busy until the run was stopped,
so graphs of that size are not usable through the panel today. The
budgets for Phase 4: a graph the size of SPQR stays under 100 ms of host
blocking and 200 ms to `graphLoaded`; CodeLens and follow mode may issue
one `selectNode` per cursor move at 50 ms each; anything over ~10k nodes
needs the viewer's deferred-load path on the `loadGraph` message first.
"Memory with the panel hidden" was not measured in VS Code itself
(`retainContextWhenHidden` keeps the page as is, so the page heap is the
number to watch).

### Phase 4: later, each behind the protocol and the budgets

- **CodeLens** above each node in `nodesInFile`. A lens passes its node ID
  and revision; a lens from an old revision re-resolves on click. Lenses
  are recomputed on revision change and hidden on a dirty document whose
  line count changed since the graph's lines were valid. Setting
  `callGraph.codeLens`.
- **Follow mode**, off by default. Background resolution never shows a
  quick pick: `ambiguous` and `not-indexed` only update the status bar.
  Each request carries document URI, version, position and revision; a
  result for an older request is dropped. A cursor move caused by
  `navigate` does not trigger a selection.
- **CI graph download** (`callGraph.indexUrl`), on command only: `https`
  only, trusted workspaces only, a timeout and a size limit, written to the
  extension's global storage (not the workspace), validated before use.
  The status bar compares `source_commit` with the folder's `HEAD` and
  warns on a mismatch.
- **Local probe-lean generator**: `probe-lean extract <lake root>
  --skip-verify`, manual only.
- Viewer follows the VS Code colour theme.
- Publish to Open VSX and the VS Code Marketplace, built in CI.

## Risks

- Inside `verus! { }` blocks, rust-analyzer may give no document symbols;
  verus-analyzer should. Without symbols, resolution is line-only and a
  renamed declaration can still match the old range until regeneration.
- Lean display names are short and repeat across namespaces; the container
  chain from vscode-lean4 disambiguates. Without it, quick picks appear
  more often.
- With the extension in probegraph, a viewer change can break the
  extension in the same PR; the `vscode/` CI job has to run on changes
  under `web/` too.

## Decisions

Decided 2026-10-01:

1. **The extension moves into probegraph as `vscode/`.** It imports
   `web/src` directly and its build bundles the current `web/dist-vscode`,
   so the copy cannot drift. Its history comes along with `git subtree`,
   filtered to drop the 3.6 MB screencast, the built `webview/` assets and
   the generator's quickstart. The old repo is archived with a pointer.
   Extension releases are tagged `vscode-v<version>`.
2. **First release is a VSIX** attached to a GitHub release by CI,
   installed with "Extensions: Install from VSIX…". Open VSX after Phase 3
   has been in use for a while; it needs a licence, the
   `beneficial-ai-foundation` namespace and a CI token. The VS Code
   Marketplace stays in Phase 4.
3. Follow mode is off by default; CodeLens and downloads are not in the
   first release.

## Review decisions

Codex reviewed the first version on 2026-10-01. Accepted:

- Normalization dropped the hidden/generated flags and replaced the
  extraction time; added the normalization changes and tests from raw
  extracts.
- Suffix path matching could pick a file from another project; removed it,
  with explicit root rules instead.
- One cache, one watcher and `workspaceFolders[0]`: sessions bound to one
  folder; several folders at once is out of scope.
- `selectNode` had no revision or request ID and `ready` restored stale
  state: added the revision-aware protocol.
- Line fallback after a contradicting symbol name showed the wrong
  declaration: now `not-indexed`; global name lookup removed from the
  cursor path.
- Downloads, `shell: true`, unchecked `navigate` and `indexPath`: no shell,
  containment checks, workspace trust; downloads moved to Phase 4 with
  storage, size and timeout rules.
- Non-atomic index replacement: validate-then-replace, temp file and
  rename, create events.
- Follow mode would raise quick picks and race: background resolution is
  silent and sequenced; follow mode is off by default and in Phase 4.
- A found node can still be filtered out: `selectResult` reports
  `filtered`, the editor selection clears the hidden-node set for that
  node, and depth is always finite.
- Large graphs: measure before Phase 4 instead of asserting the cost.
- Tests covered only the happy path: added lifecycle, multi-folder,
  invalid-file and filtered cases.
- Do not drop the uncommitted `webview/` copy; make the build reproducible
  first; Phase 0 does not wait for the repo decision.

Not taken:

- Locking writers across windows: temp file and rename keeps every file
  whole; last writer wins and every window reloads.
- Full schema validation: `validateGraph` checks structure only; the schema
  belongs to the producers (probe-lean, probe-verus).
- Special handling for trait vs impl declarations and Lean quoted or
  anonymous names: these surface as `ambiguous` or `not-indexed`, which is
  safe; revisit if the quick pick shows up too often.
- Windows paths: separators are normalized to `/`; nothing else
  Windows-specific until someone uses it there.
