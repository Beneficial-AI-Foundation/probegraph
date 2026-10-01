# Data for find_dalek_called_by_signal.py

`scripts/find_dalek_called_by_signal.py` reads its inputs from this folder.
The JSON files are gitignored, so regenerate them before running the script.

| File | Contents | Source |
|------|----------|--------|
| `graph.json` | Call graph of libsignal and curve25519-dalek | probegraph `pipeline` on [libsignal_focus_dalek_lite](https://github.com/Beneficial-AI-Foundation/libsignal_focus_dalek_lite) |
| `atoms.json` | Atoms with dependencies and locations | `probe-verus atomize` on [dalek-lite](https://github.com/Beneficial-AI-Foundation/dalek-lite) |
| `specs.json` | Verus `requires`/`ensures` clauses | `probe-verus specify` on dalek-lite |

## Regenerating

From the probegraph root, with both repos cloned next to it:

```bash
DATA=data/for_find_dalek_called_by_signal_script

cargo run --release --bin pipeline -- ../libsignal_focus_dalek_lite \
  --skip-verification --skip-similar-lemmas --use-rust-analyzer \
  -o $DATA/graph.json

probe-verus atomize ../dalek-lite --with-locations --regenerate-scip \
  -o $DATA/atoms.json

probe-verus specify ../dalek-lite --with-atoms $DATA/atoms.json --with-spec-text \
  -o $DATA/specs.json
```

`specify` needs the atoms file, so run `atomize` first. Without `-o`, both
probe-verus commands write under the project's `.verilib/probes/` instead.
The flags match the probe-verus revision pinned in `Cargo.lock`; check
`probe-verus --help` if yours differs.
