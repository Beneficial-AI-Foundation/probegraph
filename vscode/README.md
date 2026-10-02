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

### 1. Install Prerequisites

**verus-analyzer** (for SCIP generation):
```bash
# Install from: https://github.com/verus-lang/verus-analyzer
```

**scip CLI** (for converting SCIP to JSON):
```bash
# Download pre-built binaries from:
# https://github.com/sourcegraph/scip/releases

# Or build from source:
git clone https://github.com/sourcegraph/scip.git --depth=1
cd scip
go build ./cmd/scip
```

**Optional: cargo verus** (for verification status):
```bash
# Install from: https://github.com/verus-lang/verus
```

### 2. Clone probegraph

```bash
git clone --recurse-submodules https://github.com/Beneficial-AI-Foundation/probegraph.git
cd probegraph
cargo build --release --workspace
```

### 3. Configure the Extension

Open VS Code settings (`Ctrl+,`) and set:

```json
{
  "callGraph.defaultScipCallgraphPath": "/path/to/probegraph"
}
```

Or add to your project's `.vscode/settings.json`.

### 4. Generate the Index

1. Open your Verus/Rust project in VS Code
2. Open Command Palette (`Ctrl+Shift+P`)
3. Run: **"Call Graph: Regenerate Index"**
4. Wait for the pipeline to complete (~30-60 seconds)

For a Lean project, or a Rust project with a probe extract, skip the pipeline
and point `callGraph.indexPath` at the extract instead:

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
(for a Lean graph) the Lake project containing the index file, else the
folder itself. "Open in Editor" opens files under the project root only, so
in Restricted Mode `callGraph.projectRoot` is read from user settings, not
the workspace's. The status bar shows what is loaded and when it was
extracted.

### 5. Explore Call Graphs

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
| `Call Graph: Regenerate Index` | Run the probegraph pipeline (trusted workspaces only; the index is replaced only when the run succeeds) |
| `Call Graph: Cancel Pipeline` | Stop the running pipeline |
| `Call Graph: Check Prerequisites` | Verify all required tools are installed |

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
| `callGraph.indexPath` | `.vscode/call_graph_index.json` | Path to the graph, inside the workspace folder: a pipeline index or a probe extract |
| `callGraph.projectRoot` | `""` | Directory the graph's paths are relative to, if not the index's own root, the Lake root or the folder |
| `callGraph.defaultScipCallgraphPath` | `""` | Path to probegraph repository (its `pipeline` binary is found through `CARGO_TARGET_DIR` and `cargo metadata`) |
| `callGraph.autoRegenerateOnSave` | `false` | Auto-regenerate on Rust file save |
| `callGraph.debounceDelayMs` | `3000` | Delay before auto-regeneration (ms) |
| `callGraph.skipVerification` | `false` | Skip Verus verification (faster) |
| `callGraph.skipSimilarLemmas` | `true` | Skip similar lemmas enrichment |

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
│                    BUILD TIME (pipeline)                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Source Code → verus-analyzer scip → SCIP JSON → D3 Graph JSON  │
│                                        ↓                        │
│                              cargo verus verify                  │
│                                        ↓                        │
│                         call_graph_index.json                   │
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

The pre-computed index contains:
- All function nodes with metadata (file, line, mode, etc.)
- **dependencies**: What each function calls (O(1) lookup)
- **dependents**: What calls each function (O(1) lookup)
- **verification_status**: `verified`, `failed`, or `unverified`

## 🐛 Troubleshooting

### "Call graph index not found"
Run **"Call Graph: Regenerate Index"** to generate the index.

### "Pipeline command not found"
Set `callGraph.defaultScipCallgraphPath` to your probegraph repository path:
```json
{
  "callGraph.defaultScipCallgraphPath": "/home/user/git/probegraph"
}
```

### "verus-analyzer not found"
Ensure `verus-analyzer` is in your PATH:
```bash
which verus-analyzer
```

### "scip not found"
Install the SCIP CLI from [sourcegraph/scip](https://github.com/sourcegraph/scip):
```bash
# Download from releases:
# https://github.com/sourcegraph/scip/releases

# Or build from source:
git clone https://github.com/sourcegraph/scip.git --depth=1
cd scip
go build ./cmd/scip
```

### Graph shows but no nodes visible
- Check that the index was generated successfully
- Try adjusting the depth slider
- Enter a Source or Sink query to filter

### Debug Information
- View pipeline output: `Output` panel → `Call Graph Pipeline`
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
├── pipelineRunner.ts      # Run probegraph pipeline
└── test/
    ├── unit/              # Plain mocha
    ├── workspace/         # In VS Code, on test-fixtures/quicksort
    ├── lean/              # In VS Code, on test-fixtures/lean-ws, with test-fixtures/lean4-language for the language ID
    └── multiroot/         # In VS Code, on two copies of quicksort

scripts/build-webview.mjs  # Builds ../web and copies it to webview/
webview/                   # Built viewer (not tracked)
```

## 📚 Related Projects

- [probegraph](https://github.com/Beneficial-AI-Foundation/probegraph) - Call graph generation from SCIP indices
- [SCIP](https://github.com/sourcegraph/scip) - Source Code Intelligence Protocol
- [verus-analyzer](https://github.com/verus-lang/verus-analyzer) - Fork of rust-analyzer with Verus support
- [Verus](https://github.com/verus-lang/verus) - Verified Rust for low-level systems code

## 📄 License

MIT OR Apache-2.0

🤖 Generated with Claude Opus 4.5
