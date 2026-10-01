# Change Log

All notable changes to the Call Graph Visualizer extension will be documented in this file.

## [Unreleased]

### Added
- "Call Graph: Show at Cursor" (`Ctrl+Alt+G` / `Cmd+Alt+G`), at the top of the editor
  context menu and as an editor-title icon, for Rust and Lean files
- Lean support: probe-lean extracts as the graph file, `lean4` files, the Lake
  project containing the index as the default project root
- `callGraph.projectRoot` for graphs whose paths are relative to another directory
- Status bar with the index state and extraction time
- When a viewer filter hides the selected declaration, the warning names it and offers to turn it off

### Changed
- The panel opens beside the editor and keeps focus in the editor; "Open in Editor"
  opens files in the editor's group instead of over the graph
- A second "Show at Cursor" selects the node in the loaded graph instead of resending it
- One workspace folder per session; showing from another folder asks before switching
- The index is read asynchronously and validated; an invalid rewrite keeps the previous graph
- "Regenerate Index" writes to a temporary file and renames it over the index, runs
  only in trusted workspaces, and finds the `pipeline` binary through
  `CARGO_TARGET_DIR` and `cargo metadata`
- `callGraph.indexPath` must be inside the workspace folder; "Open in Editor" opens
  only files the graph names, under the project root

### Removed
- The "Call Graph" context submenu; the direction commands stay in the palette

## [0.0.5] - 2025-08-08

### Changed
- **Default Settings Updated**: Changed default `filterSources` from `filter-non-libsignal-sources` to `none`
- **Call Direction Updated**: Changed default from `--include-callers` to `--include-callees` 
- **New Configuration Options**: Added separate `includeCallers` and `includeCallees` boolean settings
- Users can now independently control whether to show callers (functions that call the target) and callees (functions called by the target)

### Added
- New user configuration options for `includeCallers` and `includeCallees`
- Comprehensive settings documentation in README

### Fixed
- Improved error handling and debugging for binary extraction issues
- Better recursive search for extracted binaries
- More detailed error messages when binary extraction fails

## [0.0.4] - 2025-08-08

### Fixed
- Fixed binary extraction issues with better error handling and debugging
- Added recursive search for binaries in extracted archives
- Improved platform detection and download verification

## [0.0.3] - 2025-08-08

### Changed
- **Performance Improvement**: Now downloads pre-built rust-analyzer-test binaries instead of building from source
- **Major Performance Improvement**: Extension now expects pre-generated SCIP index file (`index_scip.json`) rather than generating it on-demand
- Replaced git clone and cargo build with direct binary download from GitHub releases
- Added platform-specific binary detection (Linux, macOS Intel/ARM, Windows)
- Binary is cached after first download to avoid repeated downloads
- Removed automatic SCIP generation to avoid long wait times
- Removed Python and Git dependencies as they're no longer needed

### Fixed
- Fixed slow extension startup times due to building rust-analyzer-test from source
- Fixed extremely slow graph generation due to on-demand SCIP index generation
- SCIP file now expected at fixed location: `<project-root>/index_scip.json`
- Added clear error messages with instructions when SCIP file is missing

## [0.0.2] - 2025-08-04

### Added
- Integration with rust-analyzer-test tools for real call graph generation
- SCIP (Symbol Code Intelligence Protocol) support for accurate symbol resolution
- Automatic download and build of graph generation tools
- User configuration settings for graph depth, filtering, and output format
- Enhanced WebView with better styling and controls
- Comprehensive README with installation and usage instructions
- Development guide for contributors
- Support for Verus-verified function analysis

### Changed
- **BREAKING**: Complete rewrite of graph generation logic
- Now uses the same tools and process as the GitHub workflow
- Replaced mock graph generation with real analysis using `generate_function_subgraph_dot`
- Updated UI with better progress reporting and error handling
- Enhanced WebView with zoom controls and responsive design
- Improved error messages and user feedback

### Technical Changes
- `CallGraphGenerator` class completely rewritten to integrate with rust-analyzer-test
- Added automatic tool setup and SCIP data management
- Implemented symbol mapping using the same algorithm as Python scripts
- Added support for configurable graph generation parameters
- Enhanced WebView with VS Code theme integration
- Added comprehensive logging and debug output

### Dependencies
- Added runtime dependencies: Git, Rust/Cargo, Python 3, Graphviz
- Extension now automatically downloads and builds required tools
- Uses SCIP analysis data for libsignal dependency tracking

### Requirements
- Git (for cloning rust-analyzer-test repository)
- Rust toolchain (for building graph generation tool)
- Python 3 (for symbol mapping scripts)
- Graphviz (for rendering DOT files to SVG/PNG)

## [0.0.1] - Initial Release

### Added
- Basic VS Code extension structure
- Context menu integration for Rust files
- Mock call graph generation
- WebView display for graphs
- Basic error handling and progress reporting

### Features
- Right-click context menu on Rust functions
- Simple graph visualization in WebView
- Basic zoom and pan controls
- Integration with VS Code theming