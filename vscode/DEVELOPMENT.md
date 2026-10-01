# Development Guide - Call Graph Visualizer Extension

This guide explains how to develop, test, and extend the Call Graph Visualizer VS Code extension.

## Project Structure

```
call_graph_vs_code_extension/
├── src/
│   ├── extension.ts          # Main extension entry point
│   ├── graphGenerator.ts     # Core graph generation logic
│   └── rustAnalyzer.ts      # Rust analysis utilities (legacy)
├── package.json             # Extension manifest
├── tsconfig.json           # TypeScript configuration
├── webpack.config.js       # Build configuration
├── test-sample.rs          # Sample Rust file for testing
└── README.md              # User documentation
```

## Development Setup

### Prerequisites

1. **Node.js** (version 16 or higher)
2. **VS Code** (for development and testing)
3. **All runtime dependencies** (Git, Rust, Python 3, Graphviz)

### Initial Setup

1. Clone the repository and navigate to the extension directory:
   ```bash
   cd call_graph_vs_code_extension
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Open the project in VS Code:
   ```bash
   code .
   ```

### Development Workflow

1. **Start Development**: Press `F5` to launch a new VS Code window with the extension loaded
2. **Make Changes**: Edit TypeScript files in the `src/` directory
3. **Reload Extension**: Press `Ctrl+R` (or `Cmd+R` on macOS) in the extension development window to reload
4. **Test**: Open a Rust file and test the "Display Call Graph" context menu option

### Building

```bash
# Compile TypeScript
npm run compile

# Watch for changes (development)
npm run watch

# Create production build
npm run package

# Run tests
npm test
```

### Running Tests

The extension includes unit tests that can be run in VS Code:

1. **From Command Line**: `npm test`
2. **From VS Code**: Open Command Palette and run "Tasks: Run Test Task"
3. **During Development**: Tests run automatically when you press F5

**Note**: Some tests may fail if external dependencies (like Graphviz) are not installed, which is expected behavior.

## Key Components

### Extension.ts

The main entry point that:
- Registers the `call-graph-visualizer.displayCallGraph` command
- Handles the context menu integration
- Manages the progress reporting and error handling
- Coordinates between components

Key functions:
- `activate()`: Extension activation
- `generateAndDisplayCallGraph()`: Main workflow orchestration
- `showGraphInWebview()`: WebView creation and management

### GraphGenerator.ts

Core logic for graph generation:
- Downloads and builds rust-analyzer-test tools
- Maps function names to SCIP symbols
- Executes the graph generation tool
- Converts output formats

Key methods:
- `setupRustAnalyzerTest()`: Downloads and builds tools
- `mapFunctionToSymbol()`: Symbol resolution
- `generateGraphWithTool()`: Graph generation using external tool

### WebView Integration

The extension displays graphs in a VS Code WebView with:
- Interactive SVG rendering
- Zoom and pan controls
- Responsive layout
- VS Code theme integration

## Testing

### Manual Testing

1. Open the test file: `test-sample.rs`
2. Place cursor on any function name (e.g., `calculate_sum`)
3. Right-click and select "Display Call Graph"
4. Verify the graph generates and displays correctly

### Debug Output

The extension logs detailed information to the console:
- Open Developer Tools: `Help > Toggle Developer Tools`
- Check Console tab for debug messages
- Look for `Call Graph Visualizer` prefixed messages

### Common Test Scenarios

1. **Simple Functions**: Test with basic function calls
2. **Verus Functions**: Test with `#[verifier::verify]` annotated functions
3. **Complex Hierarchies**: Test with deep call chains
4. **External Dependencies**: Test functions that call library code

## Configuration

The extension supports user configuration via VS Code settings:

```json
{
  "callGraphVisualizer.depth": 5,
  "callGraphVisualizer.filterSources": "filter-non-libsignal-sources",
  "callGraphVisualizer.outputFormat": "svg"
}
```

### Adding New Settings

1. Update `package.json` contribution points
2. Modify `extension.ts` to read configuration
3. Update `GraphOptions` interface if needed

## Extending the Extension

### Adding New Graph Formats

1. Update `GraphOptions.outputFormat` type
2. Modify `convertDotToFormat()` method
3. Add format-specific handling in WebView

### Custom Analysis

The extension can be extended to support:
- Different analysis tools
- Custom symbol mapping strategies
- Additional graph layouts
- Integration with other language servers

### Integration Points

The extension integrates with:
- **VS Code Language Server**: For symbol information
- **rust-analyzer-test**: For graph generation
- **SCIP Protocol**: For code intelligence data
- **Graphviz**: For rendering

## Troubleshooting Development Issues

### Common Problems

1. **TypeScript Errors**: Run `npm run compile` to check for compilation issues
2. **Extension Not Loading**: Check the VS Code console for activation errors  
3. **Command Not Found**: Verify command registration in `package.json`
4. **Tool Failures**: Ensure all external dependencies are installed
5. **"maxBuffer length exceeded" Error**: The graph generation tool output is too large
   - This is fixed in v0.0.2+ with increased buffer sizes
   - If it still occurs, try reducing the graph depth or using different filters

### Debug Steps

1. Check extension activation:
   ```
   Command Palette > Developer: Show Running Extensions
   ```

2. View extension logs:
   ```
   Command Palette > Developer: Toggle Developer Tools
   ```

3. Test command registration:
   ```
   Command Palette > Call Graph Visualizer: Display Call Graph
   ```

### Performance Considerations

- Graph generation can take several minutes for complex functions
- Large SCIP files require significant memory
- WebView rendering performance depends on graph complexity
- Tool compilation happens once per session

## Contributing

### Code Style

- Use TypeScript with strict type checking
- Follow VS Code extension best practices
- Include error handling and user feedback
- Add logging for debugging

### Pull Request Process

1. Test changes thoroughly
2. Update documentation if needed
3. Ensure all dependencies are properly handled
4. Follow the project's contribution guidelines

## Release Process

1. Update version in `package.json`
2. Test thoroughly with various Rust projects
3. Create production build: `npm run package`
4. Test the packaged extension
5. Create release notes
6. Package as VSIX: `vsce package`

## External Dependencies

The extension relies on several external tools:

- **rust-analyzer-test**: [GitHub Repository](https://github.com/Beneficial-AI-Foundation/rust-analyzer-test)
- **SCIP**: Symbol Code Intelligence Protocol
- **Graphviz**: Graph visualization software

### Updating Dependencies

When updating external dependencies:
1. Update the commit hash in `graphGenerator.ts`
2. Test with new versions
3. Update documentation if APIs change
4. Consider backward compatibility

## Future Enhancements

Potential improvements:
- Caching of generated graphs
- Real-time graph updates
- Multiple visualization layouts  
- Integration with more analysis tools
- Support for other programming languages

## Installing the Extension

### For Development

1. Open the extension source in VS Code
2. Press `F5` to launch Extension Development Host
3. Test in the new window that opens

### For Regular Use

1. Build the VSIX package:
   ```bash
   npm install
   vsce package
   ```

2. Install from VSIX:
   - Open VS Code
   - Command Palette (`Ctrl+Shift+P`)
   - Run: `Extensions: Install from VSIX...`
   - Select the generated `.vsix` file

### First Run Setup

The first time you use the extension, it will:
1. Download rust-analyzer-test repository (~30MB)
2. Build Rust tools (may take 5-10 minutes)
3. Download SCIP analysis data (~several MB)

Subsequent runs will be much faster as tools are cached.
