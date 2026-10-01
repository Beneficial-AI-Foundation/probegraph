# Transitive Proof Metrics (`compute_proof_metrics`)

## Overview

`compute_proof_metrics` computes Halstead metrics for `proof { ... }` blocks
in Verus code, including all transitively called lemmas. Direct metrics
measure the proof block itself; transitive metrics add every lemma the proof
reaches, which is the actual verification burden of the function.

```rust
fn verified_function() {
    proof {
        lemma_A();  // calls lemma_B, lemma_C
        lemma_B();  // calls lemma_D
    }
}
```

Direct metrics cover the proof block. Transitive metrics cover the proof
block plus `lemma_A`, `lemma_B`, `lemma_C`, and `lemma_D`.

## Usage

```bash
cargo run -p metrics-cli --bin compute_proof_metrics \
  <input_atoms_json> <output_atoms_json>
```

The tool takes exactly these two positional arguments; there are no flags.
The input is an atoms JSON with function bodies and `deps` (typically the
output of `compute_metrics`); the output is the same atoms with a
`proof_metrics` field added.

## Output Format

```json
{
  "identifier": "...",
  "proof_metrics": {
    "direct_proof_halstead": {
      "n1": 10, "n1_total": 53, "n2": 14, "n2_total": 76,
      "length": 129, "difficulty": 27.14, "volume": 591.46, "effort": 16053.92
    },
    "transitive_proof_halstead": {
      "n1": 10, "n1_total": 73, "n2": 17, "n2_total": 106,
      "length": 179, "difficulty": 31.18, "volume": 851.12, "effort": 26535.07
    },
    "direct_lemmas": ["lemma_pow2_mul_div", "lemma_pow2_pos"],
    "transitive_lemmas": ["lemma_pow2_mul_div", "lemma_pow2_pos", "lemma_pow2_adds"],
    "proof_depth": 2
  }
}
```

A `parse_error` field appears when a body could not be parsed.

## Metrics Explained

### Direct proof Halstead

Only the proof block: `n1`/`n2` unique operators/operands, `n1_total`/
`n2_total` total occurrences, and the derived `length`, `difficulty`,
`volume`, `effort` (standard Halstead formulas).

### Transitive proof Halstead

Proof block plus all reached lemmas, aggregated as:

- **totals (N1, N2): sum** across all proof blocks;
- **uniques (n1, n2): set union** across all proof blocks.

A lemma may use an operator the proof already uses; the union avoids double
counting it in the vocabulary, while the sum still counts every occurrence.
Derived metrics are recomputed from the aggregates.

### Additional fields

- `direct_lemmas`: lemmas called directly in the proof (with duplicates)
- `transitive_lemmas`: all lemmas in the dependency tree (deduplicated)
- `proof_depth`: maximum depth of the lemma call chain

## Implementation Details

**Proof block extraction**: parse the body with `verus_syn`; fall back to a
brace-balanced regex scan for `proof { ... }` when parsing fails.

**Lemma call detection**: regex `\b(lemma_[a-zA-Z0-9_]+)\s*\(` — only
functions named `lemma_*` are recognized as lemmas.

**Transitive traversal**: recursive descent over the atoms map with a
`visited` set for cycle detection and a hardcoded depth cap of 10.

## Limitations

1. Proof-block extraction uses a regex fallback and may miss complex cases.
2. Lemma detection is name-based (`lemma_*`); proof functions named
   otherwise are not followed.
3. `assert(...) by { ... }` blocks are not extracted.
4. Loop invariants are not extracted.

## Measured Results

Dataset-level numbers (overheads, correlations with other metrics) live in
[`docs/archive/correlation-analysis.md`](../archive/correlation-analysis.md),
not here, so there is a single source for them.
