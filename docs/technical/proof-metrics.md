# Proof Metrics (`compute_proof_metrics`)

`compute_proof_metrics` computes Halstead metrics for the `proof { ... }`
blocks of each function, directly and including every lemma those blocks
reach. The CSV columns built from it are listed in
[metrics-pipeline.md](../guides/metrics-pipeline.md); the Halstead formulas
are in [metrics-reference.md](../guides/metrics-reference.md).

The results are not yet reproducible: the same input gives different
transitive numbers on different runs
([#58](https://github.com/Beneficial-AI-Foundation/probegraph/issues/58)).

## Usage

```bash
cargo run -p metrics-cli --bin compute_proof_metrics -- <input_atoms_json> <output_atoms_json>
```

The input is the atoms JSON written by `compute_metrics`. Every atom must
have the body-format fields (see [cli-tools.md](cli-tools.md#atoms-formats))
plus a `metrics` field, which may be `null`; a missing `metrics` is a parse
error. The output repeats every atom and adds `proof_metrics`, which is
`null` when no proof block was found:

```json
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
  "transitive_lemmas": ["lemma_pow2_adds", "lemma_pow2_mul_div", "lemma_pow2_pos"],
  "proof_depth": 2
}
```

`n1`/`n2` are unique operators/operands and `n1_total`/`n2_total` their
occurrence counts. `direct_lemmas` keeps duplicates; `transitive_lemmas` is
sorted and deduplicated, and includes names that matched no atom. The struct
also has a `parse_error` field, but nothing sets it, so it never appears.

## Algorithm

1. **Proof blocks.** The body is scanned as text for `proof ` or `proof{`
   followed by a brace-balanced block. There is no word-boundary or comment
   check, so `proof fn` signatures and comments mentioning "proof " also
   match. The body is first parsed with `verus_syn`, but the result is
   discarded and the text scan always runs.
2. **Counting.** Each block is wrapped in `fn dummy() { ... }` and parsed;
   blocks that fail to parse contribute no counts. Operators are binary and
   unary operators, `call` and `method_call`; operands are paths and
   literals. This is a narrower set than the spec metrics (no `.`, `[]`,
   `()`, `as`, `&`; see [spec-halstead.md](spec-halstead.md)), so proof and
   spec numbers are not comparable
   ([#59](https://github.com/Beneficial-AI-Foundation/probegraph/issues/59)).
3. **Lemma calls.** The regex `\b(lemma_[a-zA-Z0-9_]+)\s*\(` finds calls in
   each block; functions not named `lemma_*` are never followed.
4. **Lookup.** For each call, the atoms map is iterated in `HashMap` order and
   the first atom whose `display_name` or `identifier` contains the name as a
   substring, and whose `display_name` starts with `lemma_`, is taken (it
   also accepts a `statement_type` containing `proof`, but atoms from
   `write_atoms` are all `function`). The
   order changes between runs and `lemma_pow2` also matches `lemma_pow2_adds`,
   so the chosen lemma, and everything below it, varies
   ([#58](https://github.com/Beneficial-AI-Foundation/probegraph/issues/58)).
5. **Transitive aggregate.** The function's own blocks and those of every
   reached lemma are combined: totals (`n1_total`, `n2_total`) are summed,
   unique sets (`n1`, `n2`) are unioned, and the derived values recomputed.
   A `visited` set stops cycles.
6. **Depth.** `proof_depth` is the deepest recursion level reached. A call to
   an already-visited lemma still counts one level, so the depth can be one
   too high, and the recursion stops past depth 10, so `11` means the chain
   was truncated
   ([#58](https://github.com/Beneficial-AI-Foundation/probegraph/issues/58)).

`assert(...) by { ... }` blocks and loop invariants are not extraction roots
of their own: they are counted only when they sit inside a block captured in
step 1, such as a `proof fn` body.
