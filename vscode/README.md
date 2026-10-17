# Call Graph Visualizer Extension

A VS Code extension that provides **interactive call graph exploration** for Verus/Rust and Lean projects. This extension embeds the full [probegraph](https://github.com/Beneficial-AI-Foundation/probegraph) web app directly in VS Code, giving you powerful filtering and visualization capabilities.

## ✨ Features

- **🌐 Full Web App Integration**: Embeds the complete probegraph web viewer in VS Code
- **🎚️ Depth Slider**: Adjust traversal depth (0-10) in real-time
- **🔍 Source/Sink Queries**: Powerful glob-pattern filtering with support for Rust-style paths (`module::function`)
- **📁 File Filters**: Include/exclude files by name or pattern
- **🎯 Function Mode Filters**: Show/hide exec, proof, and spec functions (Verus)
- **✅ Verification Status**: Color-coded nodes showing Verus verification status
- **🔗 Click to Navigate**: Click any node to jump to its source code
- **👁️ Hide Nodes**: Shift+click to hide nodes from the graph
- **🔄 Auto-regeneration**: Optionally regenerate the index on file save

## 🚀 Quick Start

### 0. Install the Extension

The extension is not on the Marketplace yet. Download
`call-graph-visualizer-<version>.vsix` from the latest `vscode-v*`
[release](https://github.com/Beneficial-AI-Foundation/probegraph/releases),
then in VS Code run **Extensions: Install from VSIX…** from the Command
Palette (`Ctrl+Shift+P`) and pick the file.

### 1. Install probe-verus

"Regenerate Index" runs [probe-verus](https://github.com/Beneficial-AI-Foundation/probe-verus),
which indexes the project with verus-analyzer, runs Verus and writes the
graph. Install it with the installer script from its
[releases](https://github.com/Beneficial-AI-Foundation/probe-verus/releases)
(it puts `probe-verus` on PATH), or set `callGraph.probeVerusPath` to the
binary. The extension passes `extract -o`, which needs a release newer than
v8.0.1 ([probe-verus#51](https://github.com/Beneficial-AI-Foundation/probe-verus/pull/51)).

probe-verus needs verus-analyzer, scip and Verus. **Call Graph: Check
Prerequisites** runs `probe-verus setup --status` and offers to install
whatever is missing with `probe-verus setup --from-project`, which also
picks the Verus release the project pins. Nothing from the probegraph repo
is needed.

### 2. Generate the Index

1. Open your Verus/Rust project in VS Code
2. Open Command Palette (`Ctrl+Shift+P`)
3. Run: **"Call Graph: Regenerate Index"**
4. Wait for `probe-verus extract` to finish. Verification dominates (a
   minute or two on a mid-sized crate); `callGraph.skipVerification` skips
   it and loses the verification colours. Output goes to the "Call Graph
   Pipeline" output channel; the status bar shows the run.

The extract is written to `callGraph.indexPath` (default
`.vscode/call_graph_index.json`), replacing it only when the run succeeds.
probe-verus also leaves its intermediate files (`_atoms`, `_specs`,
`_proofs`) under `<package>/.verilib/probes/`, whatever `-o` says, so
`.verilib/` is worth adding to the project's `.gitignore`. An extract made
outside the extension works too: run `probe-verus extract .` in the project
and point `callGraph.indexPath` at
`.verilib/probes/verus_<package>_<version>.json`.

For a Lean project, point `callGraph.indexPath` at the probe-lean extract:

```json
{ "callGraph.indexPath": ".verilib/probes/probe-lean-extract.json" }
```

Lean graphs are produced by `probe-lean extract`, not by the extension;
"Regenerate Index" on one says so. Lean files need the
[vscode-lean4](https://marketplace.visualstudio.com/items?itemName=leanprover.lean4)
extension, which gives them the `lean4` language ID the commands key on.

The graph file must be inside the workspace folder. Its paths are read
relative to the project root: `callGraph.projectRoot` if set, else the
index's own project root when that is a directory inside the folder, else
the Lake project (Lean) or Cargo package (Rust) the index file belongs to,
else the folder itself. probe-verus runs on a Cargo package, so on a
workspace folder that is a Cargo workspace it moves to the single member, or
to the one `callGraph.package` names, and writes paths relative to that; the
extension follows the same rule when reading the extract, as long as the
member is inside the folder (one outside it, `../other`, needs
`callGraph.projectRoot`). "Open in Editor" opens files under the project
root only, so in Restricted Mode `callGraph.projectRoot` is read from user
settings, not the workspace's. The status bar shows what is loaded and when it was
extracted.

### 3. Explore Call Graphs

1. Open a Rust or Lean file
2. Put the cursor in a declaration
3. Press `Ctrl+Alt+G` (`Cmd+Alt+G` on macOS), use the graph icon in the
   editor title, or right-click → **Show at Cursor**. The graph opens beside
   the code and stays there; **Open in Editor** on a node opens the file in
   the editor's group.

When the declaration is not in the graph (new, renamed, or outside the
extracted files), a warning says so and names the graph file, when it was
extracted and at which commit, rather than showing something nearby. When it
is in the graph but a viewer filter hides it, the warning names the filter
and offers to turn it off.
4. Use the full web app UI:
   - Adjust depth with the slider
   - Enter Source/Sink queries to filter
   - Toggle function modes (exec/proof/spec)
   - Click nodes to navigate to source

## 📖 Usage

### Commands

| Command | Description |
|---------|-------------|
| `Call Graph: Show at Cursor` (`Ctrl+Alt+G`) | Open graph explorer on the declaration at the cursor, callers and callees |
| `Call Graph: Show Call Graph (Bidirectional)` | The same, kept for older keybindings |
| `Call Graph: Show Dependencies` | Open graph explorer showing callees |
| `Call Graph: Show Dependents` | Open graph explorer showing callers |
| `Call Graph: Regenerate Index` | Run `probe-verus extract` (trusted workspaces only; the index is replaced only when the run succeeds) |
| `Call Graph: Cancel Regenerate` | Stop the running probe-verus, with the verus-analyzer and `cargo verus` it started; a second cancel kills what did not exit |
| `Call Graph: Check Prerequisites` | Find probe-verus and check its tools (`probe-verus setup --status`); offers to install the missing ones |

### Graph Explorer UI

The embedded web app provides:

#### Source/Sink Queries
- **Source only**: Shows what the function calls (callees)
- **Sink only**: Shows what calls the function (callers)
- **Same in both**: Shows full neighborhood (bidirectional)
- **Different source & sink**: Shows paths between them

#### Query Syntax
- `decompress` - Exact match
- `*decompress*` - Contains
- `decompress*` - Starts with
- `edwards::decompress` - Function in file/module matching "edwards"

#### Filters
- **Depth**: How many hops from source/sink (0 = unlimited)
- **Function Mode**: exec, proof, spec (Verus modes)
- **Call Types**: Body calls, requires, ensures
- **Exclude Patterns**: Hide functions matching patterns
- **Include Files**: Only show functions from specific files

#### Interactions
- **Click node**: Navigate to source code in editor
- **Shift+click**: Hide the node
- **Drag node**: Reposition
- **Scroll**: Zoom
- **Drag background**: Pan
- **🔗 Copy Link**: Generate shareable URL with current filters

## ⚙️ Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `callGraph.depth` | `3` | Initial depth for call graph traversal |
| `callGraph.indexPath` | `.vscode/call_graph_index.json` | Path to the graph, inside the workspace folder; "Regenerate Index" writes a probe-verus extract here |
| `callGraph.projectRoot` | `""` | Directory the graph's paths are relative to, if not the index's own root, the Lake or Cargo root or the folder |
| `callGraph.probeVerusPath` | `probe-verus` | The probe-verus binary: a name on PATH or a path (`~` expanded). User settings only in Restricted Mode |
| `callGraph.autoRegenerateOnSave` | `false` | Auto-regenerate on Rust file save |
| `callGraph.debounceDelayMs` | `3000` | Delay before auto-regeneration (ms) |
| `callGraph.skipVerification` | `false` | `probe-verus extract --skip-verify`: faster, no verification status |
| `callGraph.useRustAnalyzer` | `false` | `probe-verus extract --rust-analyzer`: index with rust-analyzer, for plain Rust projects |
| `callGraph.package` | `""` | In a Cargo workspace with several members, the package to extract (`--package`) |

`callGraph.defaultScipCallgraphPath` is no longer read; the pipeline binary
from the probegraph repo was replaced by probe-verus.

## 🎨 Node Colors (Verification Status)

| Color | Status | Meaning |
|-------|--------|---------|
| 🟢 Green | Verified | Function passed Verus verification |
| 🔴 Red | Failed | Function failed Verus verification |
| ⚫ Gray | Unverified | Function not verified (uses assume/admit) |
| 🔵 Blue | Unknown | Not a Verus function or no verification data |

## 🔧 How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│               BUILD TIME (probe-verus extract)                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Source Code → verus-analyzer scip → atoms (functions + calls)  │
│                                        ↓                        │
│                 Verus verification → per-function status        │
│                                        ↓                        │
│                 extract envelope → call_graph_index.json        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    VIEW TIME (VS Code)                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  User clicks function → Load embedded web app → Send graph data │
│                              ↓                                   │
│                    Full probegraph UI                        │
│           (filters, depth slider, D3 visualization)             │
│                              ↓                                   │
│                  Click node → Navigate to source                 │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Index Structure

The graph file is a probe extract (schema 2): a `source` block with the
repository and commit, and `data` with one atom per function naming its
file, lines, mode, dependencies and verification status (`verified`,
`failed`, `unverified`). The extension and the viewer read it directly.

## 🐛 Troubleshooting

### "Call graph index not found"
Run **"Call Graph: Regenerate Index"** to generate the index.

### "probe-verus was not found"
Install it from the probe-verus
[releases](https://github.com/Beneficial-AI-Foundation/probe-verus/releases),
or point `callGraph.probeVerusPath` at the binary (user settings, not the
workspace's, in Restricted Mode). VS Code may need a restart to see a new
PATH entry.

### "probe-verus extract failed"
The "Call Graph Pipeline" output channel has probe-verus's output. A
verification failure in the project is not a failure of the extract; the
affected functions are shown red. When a tool is missing, probe-verus says
so there; **Check Prerequisites** in the message (or **Call Graph: Check
Prerequisites**) runs `probe-verus setup --status` and offers to install
what is missing with `probe-verus setup --from-project <folder>`. The same
from a terminal:
```bash
probe-verus setup --status
probe-verus setup --from-project .
probe-verus extract . -o /tmp/graph.json
```

### "This probe-verus predates `extract -o`"
Releases up to v8.0.1 have no `-o`; install a newer one from the
[releases](https://github.com/Beneficial-AI-Foundation/probe-verus/releases).

### "Index updated, but verification was skipped"
probe-verus skips verification when `cargo verus` is not installed and
still exits 0, so the index is current but its verification statuses are
whatever an earlier run left (or none). **Check Prerequisites** in the
message offers to install it; then regenerate.

### Graph shows but no nodes visible
- Check that the index was generated successfully
- Try adjusting the depth slider
- Enter a Source or Sink query to filter

### Debug Information
- View probe-verus output: `Output` panel → `Call Graph Pipeline`
- View logs: `Help > Toggle Developer Tools` → Console tab

## 🛠️ Development

### Building

The extension lives in `vscode/` of the probegraph repo and bundles the
viewer from `web/`. `npm run compile` builds the viewer
(`npm run build:vscode` in `web/`) and copies it to `webview/`, which is not
tracked.

```bash
git clone https://github.com/Beneficial-AI-Foundation/probegraph.git
cd probegraph
npm ci --prefix web
cd vscode
npm ci
npm run compile
npm test        # runs in a downloaded VS Code
npm run vsix    # call-graph-visualizer-<version>.vsix
```

### Releasing

Set the version in `package.json` and add a `## [<version>] - <date>` section
to `CHANGELOG.md` (CI fails the PR without it), then merge. On the push to
`main`, `.github/workflows/vscode-release.yml` sees that no `vscode-v<version>`
release exists, runs the tests, packages the VSIX and creates the release and
its tag from the merge commit, with that changelog section as the notes. A
merge that leaves the version alone releases nothing, so changes that should
not ship yet go under `## [Unreleased]` and the bump comes later.

### Running in Development

1. Open the project in VS Code/Cursor
2. Press `F5` to launch the Extension Development Host
3. Open your Rust project in the new window
4. Test the extension

### Project Structure

```
src/
├── extension.ts           # Entry point, commands, messages to the user
├── session.ts             # One folder, one graph file: revisions, watcher, status bar
├── indexLoader.ts         # Read and validate the graph; index path and project root rules
├── cursorSymbol.ts        # The declaration at the cursor, from document symbols
├── webviewLoader.ts       # The viewer in a panel; host side of the selection protocol
├── generator.ts           # Run probe-verus extract; prerequisites and tool install
└── test/
    ├── unit/              # Plain mocha
    ├── workspace/         # In VS Code, on test-fixtures/quicksort
    ├── lean/              # In VS Code, on test-fixtures/lean-ws, with test-fixtures/lean4-language for the language ID
    └── multiroot/         # In VS Code, on two copies of quicksort

scripts/build-webview.mjs  # Builds ../web and copies it to webview/
webview/                   # Built viewer (not tracked)
```

## 📚 Related Projects

- [probegraph](https://github.com/Beneficial-AI-Foundation/probegraph) - The viewer this extension embeds
- [probe-verus](https://github.com/Beneficial-AI-Foundation/probe-verus) - Produces the graph: SCIP indexing plus Verus verification status
- [SCIP](https://github.com/sourcegraph/scip) - Source Code Intelligence Protocol
- [verus-analyzer](https://github.com/verus-lang/verus-analyzer) - Fork of rust-analyzer with Verus support
- [Verus](https://github.com/verus-lang/verus) - Verified Rust for low-level systems code

## 📄 License

MIT; see [LICENSE](LICENSE).

🤖 Generated with Claude Opus 4.5
