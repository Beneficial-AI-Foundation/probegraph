# Call Graph Visualizer Extension

A VS Code extension that generates and displays function call graphs for Rust code, with special support for Verus-verified functions. This extension uses the same tools and analysis as the GitHub workflow to provide accurate call graph visualization.

## Features

- **Context Menu Integration**: Right-click on any function in a Rust file to generate its call graph
- **Real Call Graph Analysis**: Uses `rust-analyzer-test` and SCIP (Symbol Code Intelligence Protocol) data for accurate analysis
- **Interactive Visualization**: View graphs in an integrated webview with zoom and pan controls
- **Verus Function Support**: Specifically designed to work with Verus-verified functions and show dependency paths to libsignal functions
- **Fast Performance**: Uses pre-built binaries and pre-generated SCIP indices for instant graph generation

## Requirements

The extension requires the following tools to be installed on your system:

### Essential Dependencies

1. **Rust and Cargo** - Required for Rust projects
   ```bash
   # Install via rustup
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

2. **curl** - For downloading pre-built binaries
   ```bash
   # Most systems have this pre-installed
   curl --version
   ```

3. **Graphviz** - For rendering DOT files to SVG/PNG
   ```bash
   # Ubuntu/Debian
   sudo apt-get install graphviz
   
   # macOS (with Homebrew)
   brew install graphviz
   
   # Windows (with Chocolatey)
   choco install graphviz
   ```

### Verification

You can verify all dependencies are correctly installed by running:

```bash
cargo --version
curl --version
dot -V
```

## Pre-requisite: SCIP Index

**Important**: This extension requires a pre-generated SCIP index file named `index_scip.json` in your project root.

To generate this file, run one of these commands in your project root:

```bash
# Using rust-analyzer:
rust-analyzer scip . && scip print --json index.scip > index_scip.json

# Using verus-analyzer:
verus-analyzer scip . && scip print --json index.scip > index_scip.json
```

The SCIP index generation can take several minutes for large projects, which is why we require it to be pre-generated rather than generating it on-demand.
[Here](https://github.com/Beneficial-AI-Foundation/installers_for_various_tools) are some tools to install rust-analyzer/verus-analyzer/scip and also to generate the json file.

## How It Works

The extension follows the same process as the GitHub workflow:

1. **Tool Setup**: Downloads pre-built `rust-analyzer-test` binaries (cached after first download)
2. **SCIP Data**: Uses the pre-generated `index_scip.json` file from your project root
3. **Symbol Mapping**: Maps function names to their SCIP symbols using the same algorithm as the Python scripts
4. **Graph Generation**: Uses the `generate_function_subgraph_dot` tool to create DOT format graphs
5. **Visualization**: Converts to SVG and displays in an interactive webview

## Usage

1. Open a Rust file in VS Code
2. Place your cursor on a function name
3. Right-click to open the context menu
4. Select "Display Call Graph"
5. Wait for the graph to be generated and displayed

## Graph Features

The generated graphs show:

- **Function Dependencies**: How functions call each other
- **Depth Analysis**: Up to 5 levels of function calls (configurable)
- **Source Filtering**: Filters to show paths to libsignal functions
- **Interactive Controls**: Zoom, pan, and fit-to-window functionality

## Configuration

The extension uses the following default settings:

- **Depth**: 5 levels of function calls
- **Filter**: `none` (no filtering by default)
- **Format**: SVG for best quality visualization
- **Include Callers**: `false` (don't show functions that call the target by default)
- **Include Callees**: `true` (show functions called by the target by default)

These settings can be customized in VS Code settings under "Call Graph Visualizer".

### Customizing Settings

You can customize the graph generation behavior by modifying these VS Code settings:

1. **Open Settings**: `Ctrl/Cmd + ,` or `File > Preferences > Settings`
2. **Search for**: "Call Graph Visualizer"
3. **Configure**:
   - **Depth**: Maximum levels of function calls to analyze (1-10)
   - **Filter Sources**: Choose `none` or `filter-non-libsignal-sources`
   - **Output Format**: Choose between `svg`, `png`, or `dot`
   - **Include Callers**: Show functions that call the target function
   - **Include Callees**: Show functions called by the target function

Alternatively, add these to your `settings.json`:

```json
{
  "callGraphVisualizer.depth": 5,
  "callGraphVisualizer.filterSources": "none",
  "callGraphVisualizer.outputFormat": "svg",
  "callGraphVisualizer.includeCallers": false,
  "callGraphVisualizer.includeCallees": true
}
```

## Troubleshooting

### Common Issues

1. **"Tool not found" errors**: Ensure all required dependencies are installed and available in your PATH
2. **"No symbol found" errors**: The function might not be in the SCIP analysis data
3. **Build failures**: Make sure you have a working Rust toolchain and internet access

### Debug Information

The extension logs detailed information to the VS Code console. To view:

1. Open VS Code Developer Tools (`Help > Toggle Developer Tools`)
2. Check the Console tab for debug output
3. Look for messages from the Call Graph Visualizer extension

## Technical Details

### Architecture

The extension consists of several components:

- **Extension Host** (`extension.ts`): Main VS Code integration and command handling
- **Graph Generator** (`graphGenerator.ts`): Core logic for setting up tools and generating graphs
- **Rust Analyzer Client** (`rustAnalyzer.ts`): Helper for Rust code analysis (legacy, kept for compatibility)

### Dependencies

The extension automatically downloads and builds:

- [rust-analyzer-test](https://github.com/Beneficial-AI-Foundation/rust-analyzer-test) - Contains the graph generation tool
- SCIP analysis data for libsignal dependencies

### Data Flow

```
Function Name → SCIP Symbol Mapping → Graph Tool → DOT File → SVG → Webview
```

## Development

To develop or modify this extension:

1. Clone the repository
2. Install dependencies: `npm install`
3. Open in VS Code and press F5 to launch in debug mode
4. Make changes and test with the development instance

### Building

```bash
npm run compile  # Compile TypeScript
npm run package  # Create production build
```

## Contributing

This extension is part of the curve25519-dalek project. Please follow the project's contribution guidelines when submitting changes.

## License

This extension is licensed under the same terms as the curve25519-dalek project.
