<!-- Use this file to provide workspace-specific custom instructions to Copilot. For more details, visit https://code.visualstudio.com/docs/copilot/copilot-customization#_use-a-githubcopilotinstructionsmd-file -->

This is a VS Code extension project. Please use the get_vscode_api with a query as input to fetch the latest VS Code API references.

## Project Overview
This extension adds a "Display Call Graph" context menu item to the editor that generates and displays function call graphs for Rust code. It integrates with rust-analyzer and uses graphviz to visualize the call relationships.

## Key Features
- Right-click context menu on functions to display their call graph
- Integration with rust-analyzer for Rust code analysis
- Graphviz-based visualization
- Webview panel to display generated graphs
- Default depth of 5 levels for call graph generation
- Filtering modes for source files (default: filter-non-libsignal-sources)
