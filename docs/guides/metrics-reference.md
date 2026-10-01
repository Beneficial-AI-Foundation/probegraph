# Metrics Reference

Definitions and interpretation guide for the complexity metrics in the CSVs
produced by the metrics pipeline (see `METRICS_PIPELINE.md` for how to run it).

Which binary produces which columns:

| Columns | Produced by |
|---------|-------------|
| Verus spec/proof metrics (`requires_*`, `ensures_*`, `body_length`, `decreases_*`) | `compute_metrics` |
| RCA columns (`cyclomatic`, `cognitive`, `halstead_*`) and `proof_overhead_direct` | `enrich_csv_with_metrics` / `merge_rca_metrics` |
| Proof metrics (`direct_proof_halstead`, `transitive_proof_halstead`, `proof_overhead`) | `compute_proof_metrics` + `enrich_csv_with_proof_metrics` |
| Everything combined | `enrich_csv_complete` / `run_full_pipeline` |

The RCA columns come from Mozilla's
[rust-code-analysis](https://github.com/mozilla/rust-code-analysis), computed
on **vanilla (non-Verus) source** without proofs.

## Metric definitions

### cyclomatic

McCabe's cyclomatic complexity (1976): the number of linearly independent
paths through the code. Counts decision points + 1 (`if`, `while`, `for`,
match arms, `&&`, `||`, `?`).

| 1 | 2-4 | 5-10 | 11-20 | > 20 |
|---|-----|------|-------|------|
| straight-line | simple | moderate | complex | very complex |

Use for: testing burden, bug likelihood, refactoring priority.

### cognitive

Cognitive complexity (SonarSource, 2016): how hard the code is for a human to
follow. Unlike cyclomatic, it penalizes nesting, ignores linear sequences, and
does not count `break`/`continue`.

| 0 | 1-5 | 6-10 | 11-15 | > 15 |
|---|-----|------|-------|------|
| trivial | easy | moderate | hard | very hard |

Use for: readability, maintainability, code review priority.

### halstead_length

Total operators + operands: `N = N1 + N2`. This counts **tokens** (syntactic
elements), not characters or lines, and it is computed on vanilla source — so
it is the implementation size to compare against the Verus `body_length`.

| < 50 | 50-200 | 200-500 | > 500 |
|------|--------|---------|-------|
| small | medium | large | very large |

### halstead_difficulty

`(n1/2) x (N2/n2)` where n1 = unique operators, N2 = total operands, n2 =
unique operands. Measures code density and operand reuse.

| < 5 | 5-15 | 15-50 | > 50 |
|-----|------|-------|------|
| simple | normal | dense | very dense |

High difficulty is not necessarily bad code: optimized cryptographic math is
inherently dense.

### halstead_effort

`difficulty x volume`, where `volume = length x log2(vocabulary)`. The best
single indicator of overall implementation effort, combining size and density.

| < 500 | 500-5K | 5K-50K | > 50K |
|-------|--------|--------|-------|
| easy | moderate | significant | major |

### proof_overhead_direct

`body_length - halstead_length`: the Verus source length minus the vanilla
implementation token count, i.e. how much of the Verus function is proof
rather than implementation. Computed by `merge_rca_metrics`.

### proof_overhead

`transitive_proof_halstead.effort / direct_proof_halstead.effort`: how much of
a function's total proof effort comes from the lemmas it depends on, versus
its own proof code. Computed by `enrich_csv_with_proof_metrics`.

## How the metrics relate

- **Cyclomatic vs cognitive**: usually close. Cognitive far above cyclomatic
  means deep nesting. Cognitive can also be far *below* cyclomatic: a function
  with branches but no nesting (e.g. `FieldElement51::mul`, cyclomatic 2,
  cognitive 0) is long but easy to follow.
- **Difficulty vs length**: independent. Short dense code and long simple code
  both exist; both high means a genuinely complex function.
- **Effort**: use it when you need one number for prioritization.

## Worked comparisons

Numbers from curve25519-dalek 4.1.3, analyzed November 2025.

**Simple function** — `FieldElement51::add_assign`: cyclomatic 2, cognitive 1,
length 29, difficulty 11.1, effort 1,373. Well-scoped and manageable.

**Large but flat** — `FieldElement51::mul`: cyclomatic 2, cognitive 0, length
614, difficulty 82.0, effort 293,777. No control-flow complexity at all; the
effort comes from sheer size and density, which is typical for optimized field
arithmetic. Metrics that only look at branching would call this trivial.

**Nested logic** — `non_adjacent_form`: cyclomatic 5, cognitive 9, length 205,
difficulty 48, effort 56,889. Cognitive well above cyclomatic: complexity here
is nested conditionals, not size.

**Proof overhead** — `FieldElement51::mul`: `body_length` 3,964 (Verus source
with proofs) vs `halstead_length` 614 (vanilla implementation) gives
`proof_overhead_direct` 3,350 — about 85% of the Verus function is proof.

## Empty values

Cells without RCA metrics occur for: build scripts, feature-gated modules RCA
does not analyze (e.g. `lizard`), macro-generated code, trait definitions with
no body, and functions that do not exist in the vanilla (non-Verus) version of
the crate.

## RCA does not inline callees

Halstead metrics are computed on the syntactic source text of each function
only. A call `bar(y)` contributes roughly three tokens (`bar`, `(...)`, `y`)
regardless of how large `bar`'s body is. Demonstration:

```rust
fn bar(a: i32) -> i32 { a + 1 + 2 + 3 + 4 + 5 }
fn baz(b: i32) -> i32 { b * 10 * 20 * 30 }
fn foo(y: i32, z: i32) -> i32 {
    let x = bar(y) + baz(z);
    x
}
```

RCA reports lengths bar = 19, baz = 15, foo = 23. If callees were inlined,
`foo` would be 57+. Reproduce with:

```bash
rust-code-analysis-cli -m -p path/to/file.rs -O json | \
  jq '.spaces[] | {name, length: .metrics.halstead.length}'
```

(Hand-counting individual tokens against RCA can differ by a few tokens —
RCA has its own rules for function names and type tokens — but the no-inlining
conclusion is unaffected.)

## Halstead formula reference

| Metric | Formula |
|--------|---------|
| Length (N) | `N1 + N2` |
| Vocabulary (n) | `n1 + n2` |
| Volume (V) | `N x log2(n)` |
| Difficulty (D) | `(n1/2) x (N2/n2)` |
| Effort (E) | `D x V` |

## Thresholds for action

| Metric | Low | Medium | High | Very high |
|--------|-----|--------|------|-----------|
| cyclomatic | 1-4 | 5-10 | 11-20 | > 20 |
| cognitive | 0-5 | 6-10 | 11-15 | > 15 |
| halstead_difficulty | < 5 | 5-15 | 15-50 | > 50 |
| halstead_effort | < 500 | 500-5K | 5K-50K | > 50K |
| halstead_length | < 50 | 50-200 | 200-500 | > 500 |

Flag for review: cognitive > 10, cyclomatic > 15, effort > 50K. Consider
refactoring: cognitive > 15, cyclomatic > 20, length > 500. For verification:
cyclomatic 1 is ideal, and large length may need proof decomposition — though
note that per `docs/archive/correlation-analysis.md`, none of these metrics
reliably predicts proof difficulty.

## References

1. McCabe, T. J. (1976). "A Complexity Measure". IEEE Transactions on
   Software Engineering.
2. SonarSource (2016). "Cognitive Complexity: A new way of measuring
   understandability". https://www.sonarsource.com/docs/CognitiveComplexity.pdf
3. Halstead, M. H. (1977). "Elements of Software Science". Elsevier.
4. rust-code-analysis: https://github.com/mozilla/rust-code-analysis
