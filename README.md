# Call Graph Visualizer Extension

A VS Code extension that provides **interactive call graph exploration** for Verus/Rust projects. This extension embeds the full [scip-callgraph](https://github.com/Beneficial-AI-Foundation/scip-callgraph) web app directly in VS Code, giving you powerful filtering and visualization capabilities.

## ✨ Features

- **🌐 Full Web App Integration**: Embeds the complete scip-callgraph web viewer in VS Code
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

### 2. Clone scip-callgraph

```bash
git clone --recurse-submodules https://github.com/Beneficial-AI-Foundation/scip-callgraph.git
cd scip-callgraph
cargo build --release --workspace
```

### 3. Configure the Extension

Open VS Code settings (`Ctrl+,`) and set:

```json
{
  "callGraph.defaultScipCallgraphPath": "/path/to/scip-callgraph"
}
```

Or add to your project's `.vscode/settings.json`.

### 4. Generate the Index

1. Open your Verus/Rust project in VS Code
2. Open Command Palette (`Ctrl+Shift+P`)
3. Run: **"Call Graph: Regenerate Index"**
4. Wait for the pipeline to complete (~30-60 seconds)

### 5. Explore Call Graphs

1. Open a Rust file
2. Click on a function name
3. Right-click → **Call Graph** → **Show Call Graph (Bidirectional)**
4. Use the full web app UI:
   - Adjust depth with the slider
   - Enter Source/Sink queries to filter
   - Toggle function modes (exec/proof/spec)
   - Click nodes to navigate to source

## 📖 Usage

### Commands

| Command | Description |
|---------|-------------|
| `Call Graph: Show Call Graph (Bidirectional)` | Open graph explorer with full neighborhood |
| `Call Graph: Show Dependencies` | Open graph explorer showing callees |
| `Call Graph: Show Dependents` | Open graph explorer showing callers |
| `Call Graph: Regenerate Index` | Run the scip-callgraph pipeline |
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
| `callGraph.indexPath` | `.vscode/call_graph_index.json` | Path to the index file |
| `callGraph.defaultScipCallgraphPath` | `""` | Path to scip-callgraph repository |
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
│                    Full scip-callgraph UI                        │
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
Set `callGraph.defaultScipCallgraphPath` to your scip-callgraph repository path:
```json
{
  "callGraph.defaultScipCallgraphPath": "/home/user/git/scip-callgraph"
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

```bash
git clone https://github.com/Beneficial-AI-Foundation/call_graph_vs_code_extension.git
cd call_graph_vs_code_extension
npm install
npm run compile
```

### Running in Development

1. Open the project in VS Code/Cursor
2. Press `F5` to launch the Extension Development Host
3. Open your Rust project in the new window
4. Test the extension

### Project Structure

```
src/
├── extension.ts           # Entry point, command registration
├── indexLoader.ts         # Load and cache D3 graph index
├── webviewLoader.ts       # Embed scip-callgraph web app
├── pipelineRunner.ts      # Run scip-callgraph pipeline
└── test/
    └── indexLoader.test.ts

webview/                   # Embedded scip-callgraph web app
├── index.html
└── assets/
    ├── main.js
    └── main.css
```

### Updating the Web App

To update the embedded web app:

```bash
# In scip-callgraph/web/
npm run build:vscode

# Copy to extension
cp -r dist-vscode/* /path/to/call_graph_vs_code_extension/webview/
```

## 📚 Related Projects

- [scip-callgraph](https://github.com/Beneficial-AI-Foundation/scip-callgraph) - Call graph generation from SCIP indices
- [SCIP](https://github.com/sourcegraph/scip) - Source Code Intelligence Protocol
- [verus-analyzer](https://github.com/verus-lang/verus-analyzer) - Fork of rust-analyzer with Verus support
- [Verus](https://github.com/verus-lang/verus) - Verified Rust for low-level systems code

## 📄 License

MIT OR Apache-2.0

🤖 Generated with Claude Opus 4.5
