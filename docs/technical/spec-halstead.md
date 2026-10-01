# Spec Halstead Metrics

This page documents the `verus-metrics` library
(`crates/verus-metrics/src/spec_halstead.rs`), which scores a single Verus
spec clause by parsing it with `verus_syn` and counting operators and
operands in the AST. The formulas and how to read the numbers are in
[metrics-reference.md](../guides/metrics-reference.md).

The pipeline does not call this library yet. `compute_metrics` has its own
copy of the visitor and never calls `analyze_spec` or `is_prose`, so the
tests here do not cover the `requires_*` / `ensures_*` CSV columns
([#59](https://github.com/Beneficial-AI-Foundation/probegraph/issues/59)).
The copy uses the same counting rules below.

## API

```rust
use verus_metrics::{analyze_spec, is_prose, SpecHalsteadMetrics};

let m = analyze_spec("x < FIELD_MODULUS && y < FIELD_MODULUS")?;
println!("{} {}", m.halstead_length, m.effort);
```

`SpecHalsteadMetrics` holds `halstead_length`, `vocabulary`, `difficulty`,
`volume`, `effort` and the raw counts `n1_unique_operators`,
`n2_unique_operands`, `n1_total_operators`, `n2_total_operands`.

`analyze_spec` checks for prose, strips `//` comments, then parses the text
as one expression. Verus syntax (`forall|..|`, `exists|..|`, `==>`, `@`,
`&&&`, `=~=`, `old()`, `#[trigger]`, chained comparisons, `as int`) is
parsed natively; nothing is rewritten.

## Counting rules

Operators:

- binary and unary operators (`+`, `==`, `&&`, `==>`, `!`, `*` deref, ...);
  `verus_syn` parses `forall`, `exists` and `choose` as unary operators, and
  their bound variables are not counted;
- `.` for field access, `[]` for indexing, `()` for parentheses, `&` for
  references, `as` for casts;
- `call` for a function call; for a method call, the method name itself.

Operands:

- paths, joined with `::` (`x`, `result`, `i32::MAX`, `FIELD_MODULUS`);
- literals (`10`, `"text"`, `true`);
- field names, including tuple indices (`0` in `x.0`);
- the callee of a function call (`f` in `f(x)`).

Anything else is traversed for its children. Calls are counted
syntactically and the callee is never expanded: `f(g(x)) == y` has
3 operators (`call`, `call`, `==`) and 4 operands (`f`, `g`, `x`, `y`). Types
in specs are not scored.

## Worked example

`x.0 < FIELD_MODULUS && y.0 < FIELD_MODULUS`

- Operators: `&&`, `<`, `.`, `<`, `.`: N1 = 5, n1 = 3.
- Operands: `x`, `0`, `FIELD_MODULUS`, `y`, `0`, `FIELD_MODULUS`: N2 = 6,
  n2 = 4.

```
length     = 5 + 6               = 11
vocabulary = 3 + 4               = 7
difficulty = (3/2) × (6/4)       = 2.25
volume     = 11 × log2(7)        = 30.88
effort     = 2.25 × 30.88        = 69.48
```

The hand-verified oracle for plain and quantified specs is
`crates/verus-metrics/tests/halstead_validation.rs`.

## Prose detection

Text-extracted clauses sometimes contain doc comments or English sentences.
`analyze_spec` rejects these instead of scoring them, and `is_prose` is
exported so callers can tell "skip quietly" from a real parse failure.
Trimmed strings under 10 characters are never prose. Longer ones are prose if
any of these holds:

- they start with `///` or `//!`;
- they contain a phrase indicator (`"However,"`, `"i.e."`, `"must be clear"`,
  `"is equivalent to"`, ...);
- they start with an English starter (`"The "`, `"We "`, `"Given"`, ...) and
  contain none of `==`, `!=`, `<=`, `>=`;
- they end with `*/` without starting with `/*`;
- they have more than 50 letters and fewer than 3 operator characters.

`compute_metrics` takes its clauses from the parsed `requires` / `ensures` /
`decreases` AST nodes, so prose cannot reach it; the heuristic matters only
for callers that pass raw text.

## Errors

- Empty string: `Ok` with all-zero metrics.
- Prose: `Err("Skipped prose/documentation: ...")`.
- Nothing left after comment stripping, or text ending in `(`:
  `Err("Skipped non-expression clause: ...")`.
- Anything `verus_syn` cannot parse as an expression, including a bare
  `decreases i`: `Err` with the parse message.

Tests: `cargo test -p verus-metrics`. Demo:
`cargo run -p metrics-cli --bin demo_spec_halstead`.
