# View Algorithms

Formal specifications of the three visualization views, each with a
"Relationship to Known Algorithms" section mapping the implementation to the
graph-drawing literature.

| Document | View | Core technique |
|----------|------|----------------|
| [CALL_GRAPH_ALGORITHM.md](CALL_GRAPH_ALGORITHM.md) | Call Graph | Hybrid layout: Sugiyama-style layering + barycenter crossing minimization for initialization, then constrained D3 force simulation; auto-fit camera |
| [FILE_MAP_ALGORITHM.md](FILE_MAP_ALGORITHM.md) | File Map | Transitive reduction, dagre compound layout grouped by file, dual-channel (border/fill) verification encoding |
| [CRATE_MAP_ALGORITHM.md](CRATE_MAP_ALGORITHM.md) | Crate Map (Lean: Namespace Map) | Quotient-graph aggregation with three semantic-zoom modes: collapsed, expanded edge, crate boundary |

Implementation: `web/src/graph.ts`, `web/src/file-map.ts`,
`web/src/crate-map.ts`. System-level context: [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md).
