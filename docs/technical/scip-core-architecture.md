# scip-core Architecture

`crates/scip-core` parses a SCIP JSON index (from `scip print --json`) and
builds the call graph that the `metrics-cli` binaries and the web viewer's
data files are made from. Function-level API docs are in rustdoc
(`cargo doc -p scip-core --open`); this page covers the module layout and the
SCIP behaviour the code depends on.

## Modules

| Module | Purpose |
|--------|---------|
| `types` | Shared data: SCIP index types, `FunctionNode`, `Atom`, `DeclKind`, `FunctionSections`, D3 graph types |
| `parser` | Reads SCIP JSON; extracts display names and paths from symbols |
| `call_graph` | Builds the call graph, Verus section/`DeclKind` detection, `symbol_to_path`, filtered subgraphs |
| `export_d3` | D3/web graph JSON and atoms JSON |
| `export_dot` | DOT/Graphviz output, rendered to SVG/PNG |
| `atoms_to_d3` | Converts probe-verus atoms output to D3 graph format |
| `scip_utils` | `generate_scip_json_index`: runs `verus-analyzer scip` and `scip print --json` (see [cli-tools.md](cli-tools.md)) |
| `scip_reader`, `call_graph_svg` | Older alternative reader and SVG renderer |
| `logging` | `init_logger` and `should_enable_debug` for the binaries |

The common entry points are re-exported from the crate root:

```rust
use scip_core::{parse_scip_json, build_call_graph, export_call_graph_d3};

let scip_data = parse_scip_json("index.scip.json")?;
let call_graph = build_call_graph(&scip_data);
export_call_graph_d3(&call_graph, &scip_data, "graph.json")?;
```

## Logging

Binaries that use `logging` log at `warn` by default. `--debug` / `-d` sets
`debug` level. Without that flag, a set `RUST_LOG` takes over and is parsed
as usual by `env_logger`; the flag wins when both are given.

## How the call graph is built

A SCIP index has documents, symbols and occurrences but no call edges.
`build_call_graph` derives them:

1. A pre-pass maps each symbol to the file holding its definition occurrence
   (`symbol_roles & 1 == 1`).
2. Function-like symbols with a definition become local nodes; symbols with
   none are skipped. Other function-like symbols that are referenced become
   external placeholder nodes.
3. Occurrences in each document are walked in source order. A definition of a
   local function starts the "current function"; each later non-definition
   occurrence of a function symbol becomes an edge from it. Self-references
   are ignored.
4. Bodies are read from the source files by brace matching from the
   definition line, and each call is classified as precondition,
   postcondition or body (`CallLocation`).

## SCIP pitfalls

`doc.symbols[]` lists the symbols visible in a file, not the ones defined in
it. Using it to attribute functions to files puts them in the wrong file and
extracts the wrong bodies; that is why step 1 uses definition occurrences.

The SCIP structs carry `#[serde(default)]` on most fields because
`scip print --json` uses proto3 JSON, which omits any field holding its
default (0, empty string, empty list).

rust-analyzer emitted no occurrences for operator-overload calls before
[rust-lang/rust-analyzer#21187](https://github.com/rust-lang/rust-analyzer/pull/21187)
(December 2025). `a *= b` calls `MulAssign::mul_assign`, but older indexes
record only the operands, so every `+`, `*`, `+=`, `*=` edge is missing.
This matters for arithmetic-heavy crates like curve25519-dalek; regenerate
old indexes with a newer analyzer.
