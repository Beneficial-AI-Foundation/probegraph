# Metrics Reference

What the complexity metrics in the metrics-pipeline CSVs mean and how to read
them. How to run the pipeline, which binary produces each column, and why
cells can be empty are in [metrics-pipeline.md](metrics-pipeline.md) (see
[Empty values](metrics-pipeline.md#empty-values)).

The code metrics (`cyclomatic`, `cognitive`, `halstead_*`) come from Mozilla's
[rust-code-analysis](https://github.com/mozilla/rust-code-analysis) (RCA),
run on the vanilla (non-Verus) source, without specs or proofs. The spec and
proof Halstead columns use the same formulas on spec clauses and proof blocks;
their counting rules are in
[spec-halstead.md](../technical/spec-halstead.md) and
[proof-metrics.md](../technical/proof-metrics.md).

## Definitions

**cyclomatic**: McCabe's cyclomatic complexity, the number of linearly
independent paths: decision points plus one (`if`, `while`, `for`, match arms,
`&&`, `||`, `?`). A guide to testing burden.

**cognitive**: SonarSource's cognitive complexity, how hard the code is to
follow. Unlike cyclomatic it penalizes nesting, ignores linear sequences, and
does not count `break`/`continue`.

**Halstead** metrics count tokens (operators and operands), not characters or
lines. With n1/n2 the unique and N1/N2 the total operators/operands:

| Metric | Formula |
|--------|---------|
| Length (N) | `N1 + N2` |
| Vocabulary (n) | `n1 + n2` |
| Volume (V) | `N × log2(n)` |
| Difficulty (D) | `(n1/2) × (N2/n2)` |
| Effort (E) | `D × V` |

Length is size; difficulty is density and operand reuse; effort combines the
two and is the best single number for prioritizing. High difficulty is not
necessarily bad code: optimized field arithmetic is dense by nature.

## Thresholds

Rules of thumb, not calibrated on this data:

| Metric | Low | Medium | High | Very high |
|--------|-----|--------|------|-----------|
| cyclomatic | 1-4 | 5-10 | 11-20 | > 20 |
| cognitive | 0-5 | 6-10 | 11-15 | > 15 |
| halstead_length | < 50 | 50-200 | 200-500 | > 500 |
| halstead_difficulty | < 5 | 5-15 | 15-50 | > 50 |
| halstead_effort | < 500 | 500-5K | 5K-50K | > 50K |

None of these metrics has been shown to predict proof difficulty; the earlier
correlation study is archived as not reproducible
([correlation-analysis.md](../archive/correlation-analysis.md)).

## Reading them together

Cyclomatic and cognitive are usually close. Cognitive well above cyclomatic
means deep nesting; well below means branches without nesting. Difficulty and
length are independent: short dense code and long simple code both exist.
Examples from curve25519-dalek 4.1.3
(`data/csv/functions_to_track_COMPLETE.csv`):

| Function | cyclomatic | cognitive | length | difficulty | effort |
|----------|-----------:|----------:|-------:|-----------:|-------:|
| `FieldElement51::add_assign` | 2 | 1 | 29 | 11.1 | 1,373 |
| `FieldElement51::mul` | 2 | 0 | 614 | 82.0 | 293,777 |
| `non_adjacent_form` | 5 | 9 | 205 | 48.0 | 56,889 |

`add_assign` is small and manageable. `mul` has no control flow to speak of;
its effort comes from size and density, which branch-only metrics would miss.
In `non_adjacent_form` cognitive is well above cyclomatic, so the complexity
is nested conditionals rather than size.

## Derived values

`scripts/visualize_metrics.py` adds `proof_overhead_ratio =
transitive_proof_effort / halstead_effort` and treats a proof as non-trivial
when `has_proof == yes` and `trivial_proof != yes`. Run it on a FINAL CSV
(plots default to `data/plots`):

```bash
uv run --extra viz python scripts/visualize_metrics.py <csv> [out_dir]
```

`proof_overhead_direct = body_length - halstead_length` is written only to the
atoms JSON by `merge_rca_metrics`. It is not reliable: `body_length` counts
characters while `halstead_length` counts RCA tokens
([#59](https://github.com/Beneficial-AI-Foundation/probegraph/issues/59)).

## RCA does not inline callees

Halstead metrics count only the syntactic text of each function. A call
`bar(y)` adds a few tokens however large `bar` is:

```rust
fn bar(a: i32) -> i32 { a + 1 + 2 + 3 + 4 + 5 }
fn baz(b: i32) -> i32 { b * 10 * 20 * 30 }
fn foo(y: i32, z: i32) -> i32 {
    let x = bar(y) + baz(z);
    x
}
```

RCA reports lengths bar = 19, baz = 15, foo = 23; inlined, `foo` would be 57
or more. Hand counts can differ from RCA by a few tokens (it has its own rules
for function names and types), but the conclusion holds. Reproduce with:

```bash
rust-code-analysis-cli -m -p path/to/file.rs -O json | \
  jq '.spaces[] | {name, length: .metrics.halstead.length}'
```

## References

- McCabe, "A Complexity Measure", IEEE TSE, 1976.
- SonarSource, [Cognitive Complexity](https://www.sonarsource.com/docs/CognitiveComplexity.pdf), 2016.
- Halstead, *Elements of Software Science*, Elsevier, 1977.
