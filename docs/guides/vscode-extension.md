# VS Code extension integration

The web viewer can run inside a VS Code webview panel. There it receives the
graph from the extension by message, opens source in the editor instead of on
GitHub, and talks to the extension in both directions. The viewer detects the
webview by the presence of `acquireVsCodeApi`.

## Building for VS Code

```bash
cd web
npm run build:vscode
```

This writes `web/dist-vscode/` using `vite.config.vscode.js`:

- relative paths (`base: './'`), so the extension can rewrite asset URLs;
- predictable filenames: `assets/main.js`, `assets/main.css`;
- no public folder, so no bundled `graph.json` (the graph comes by message).

JavaScript and CSS are separate files, not inlined; `assetsInlineLimit` only
inlines imported assets under 100 KB. `index.html` loads the Inter font from
Google Fonts, so a webview Content Security Policy must allow
`fonts.googleapis.com` / `fonts.gstatic.com` or the viewer falls back to the
system font.

## Message protocol

### Extension → webview

**`loadGraph`** sends a graph in any format the viewer accepts:

```typescript
panel.webview.postMessage({
  type: 'loadGraph',
  graph,                          // atom dict, envelope or {nodes, links, metadata}
  initialQuery: {                 // optional
    source: 'my_function',
    sink: '',
    depth: 3,                     // 0 = unlimited
  },
  selectedNodeId: 'scip:...',     // optional, exact node ID
});
```

When the message has a `selectedNodeId` or a query, the viewer opens the code
layer (for graphs with a blueprint layer). If `selectedNodeId` is in the
graph, the query is that exact node and the direction follows which
`initialQuery` strings are non-empty:

| `source` | `sink` | Shows |
|---|---|---|
| set | empty | callees of the node |
| empty | set | callers of the node |
| set | set | callers and callees |
| empty | empty | just the node |

The strings only choose the direction; they are not matched. A directional
exact query uses unlimited depth unless `initialQuery.depth` is given. If the
ID is not in the graph (for example a stale index), the viewer falls back to
a text query from the `source` / `sink` strings.

**`setQuery`** replaces the query with a text query and switches to the code
layer:

```typescript
panel.webview.postMessage({ type: 'setQuery', source: 'fn_a', sink: 'fn_b' });
```

An omitted side keeps its previous text only if the current query is a text
query; after an exact-node or other query it becomes empty.

**`refresh`** makes the webview reply with `requestRefresh`.

### Webview → extension

- **`ready`** — sent once the webview has set up its message listener.
- **`navigate`** — sent when the user clicks **Open in Editor**:

  ```typescript
  { type: 'navigate', relativePath: 'src/lib.rs', startLine: 42, endLine: 58, displayName: 'my_function' }
  ```

  For a blueprint entry, `relativePath` is the entry's Lean declaration file
  (`blueprint.sourcePath`), not its chapter. `startLine` and `endLine` are
  1-based (subtract 1 for `vscode.Position`) and may be undefined when the
  graph has no line numbers.
- **`requestRefresh`** — the webview wants fresh graph data.

## Extension side

A minimal host creates the panel with scripts enabled and `dist-vscode/` as a
local resource root, rewrites `./assets/` in `index.html` to
`webview.asWebviewUri(...)`, and handles the messages:

```typescript
panel.webview.onDidReceiveMessage(async (msg) => {
  if (msg.type === 'ready') panel.webview.postMessage({ type: 'loadGraph', graph });
  if (msg.type === 'navigate') await openAt(msg.relativePath, msg.startLine, msg.endLine);
  if (msg.type === 'requestRefresh') panel.webview.postMessage({ type: 'loadGraph', graph: await regenerate() });
});
```

## Differences from the web build

| Feature | Web | VS Code webview |
|---|---|---|
| Graph loading | auto-load, `?json=`, file picker | `loadGraph` message only |
| File input | visible | hidden |
| Source navigation | View on GitHub (new tab) | Open in Editor (`navigate`) |
| Header | SVG logo and "probegraph" | text "Call Graph Explorer" (the logo is replaced) |

For viewer features see [viewer.md](viewer.md); for development see
[web/README.md](../../web/README.md).
