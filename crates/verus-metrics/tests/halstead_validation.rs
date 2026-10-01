//! Hand-verified Halstead token counts for plain and quantified specs. The
//! counting rules are in docs/technical/spec-halstead.md.
//!
//! The counts were originally verified against the pre-verus_syn
//! implementation, which rewrote `forall|x|` to a closure and `==>` to `||`.
//! verus_syn parses both natively, so the operator *identities* differ
//! (`==>` is its own operator now) but the expected counts are unchanged
//! unless noted in a comment.

use verus_metrics::{analyze_spec, SpecHalsteadMetrics};

fn assert_counts(
    spec: &str,
    n1_unique: usize,
    n1_total: usize,
    n2_unique: usize,
    n2_total: usize,
) -> SpecHalsteadMetrics {
    let m = analyze_spec(spec).unwrap_or_else(|e| panic!("failed to analyze '{spec}': {e}"));
    assert_eq!(
        m.n1_unique_operators, n1_unique,
        "n1 (unique operators) for '{spec}': {m:?}"
    );
    assert_eq!(
        m.n1_total_operators, n1_total,
        "N1 (total operators) for '{spec}': {m:?}"
    );
    assert_eq!(
        m.n2_unique_operands, n2_unique,
        "n2 (unique operands) for '{spec}': {m:?}"
    );
    assert_eq!(
        m.n2_total_operands, n2_total,
        "N2 (total operands) for '{spec}': {m:?}"
    );
    assert_eq!(m.halstead_length, n1_total + n2_total, "length for '{spec}'");
    assert_eq!(m.vocabulary, n1_unique + n2_unique, "vocabulary for '{spec}'");
    m
}

fn assert_close(actual: f64, expected: f64, what: &str, spec: &str) {
    assert!(
        (actual - expected).abs() < 0.01,
        "{what} for '{spec}': expected {expected}, got {actual}"
    );
}

// --- Manually counted plain specs ---

#[test]
fn validation_simple_comparison() {
    // Example 1: `x < 10`. Operators: <. Operands: x, 10.
    let spec = "x < 10";
    let m = assert_counts(spec, 1, 1, 2, 2);
    assert_close(m.difficulty, 0.5, "difficulty", spec);
    assert_close(m.volume, 4.755, "volume", spec);
    assert_close(m.effort, 2.377, "effort", spec);
}

#[test]
fn validation_conjunction_with_repeats() {
    // Example 2: `x < FIELD_MODULUS && y < FIELD_MODULUS`.
    // Operators: <, <, && (2 unique). Operands: x, FIELD_MODULUS, y,
    // FIELD_MODULUS (3 unique). Repetition raises N but not n.
    let spec = "x < FIELD_MODULUS && y < FIELD_MODULUS";
    let m = assert_counts(spec, 2, 3, 3, 4);
    assert_close(m.difficulty, 1.333, "difficulty", spec);
    assert_close(m.effort, 21.671, "effort", spec);
}

#[test]
fn validation_tuple_field_access() {
    // Example 3: `result.0 < FIELD_MODULUS`. Field access is an operator;
    // the field name (0) is an operand.
    let spec = "result.0 < FIELD_MODULUS";
    let m = assert_counts(spec, 2, 2, 3, 3);
    assert_close(m.difficulty, 1.0, "difficulty", spec);
    assert_close(m.effort, 11.610, "effort", spec);
}

#[test]
fn validation_arithmetic_with_grouping() {
    // Example 4: `result.0 == (x.0 + y.0) % FIELD_MODULUS`.
    // Operators: . (x3), ==, (), +, % -> 5 unique, 7 total.
    // Operands: result, 0 (x3), x, y, FIELD_MODULUS -> 5 unique, 7 total.
    let spec = "result.0 == (x.0 + y.0) % FIELD_MODULUS";
    let m = assert_counts(spec, 5, 7, 5, 7);
    assert_close(m.difficulty, 3.5, "difficulty", spec);
    assert_close(m.effort, 162.774, "effort", spec);
}

#[test]
fn validation_indexed_byte_comparison() {
    // Example 5: `self.bytes[0] == other.bytes[0] && self.bytes[1] == other.bytes[1]`.
    // Operators: . (x4), [] (x4), == (x2), && -> 4 unique, 11 total.
    // Operands: self, bytes, 0, other, 1 with heavy reuse -> 5 unique, 12 total.
    let spec = "self.bytes[0] == other.bytes[0] && self.bytes[1] == other.bytes[1]";
    let m = assert_counts(spec, 4, 11, 5, 12);
    assert_close(m.difficulty, 4.8, "difficulty", spec);
    assert_close(m.effort, 349.960, "effort", spec);
}

// --- Quantified specs ---
//
// These were first verified under the old preprocessing, which
// rewrote `forall|x|`/`exists|x|` to a bare closure (dropping the binder
// token) and `==>` to `||`. verus_syn parses quantifiers as unary operators
// (UnOp::Forall/Exists/Choose) and `==>` as its own binary operator, so each
// quantifier occurrence now counts as one operator the hand count did not.
// That is consistent with the Halstead classification rules (unary operators
// count, like `!`), so the expectations below assert current behavior; each
// comment records the hand-counted value.

#[test]
fn quantifier_simple_forall() {
    // Test 1. Historical: length 3 (binder dropped). Now `forall` is a unary
    // operator: ops forall, < ; operands i, len.
    let spec = "forall|i: usize| i < len";
    let m = assert_counts(spec, 2, 2, 2, 2);
    assert_close(m.difficulty, 1.0, "difficulty", spec);
}

#[test]
fn quantifier_forall_with_implication() {
    // Test 2. Historical: length 9, difficulty 2.5. Now +1 for the binder:
    // ops forall, ==>, <, [], > ; operands i, len, arr, i, 0.
    let spec = "forall|i: usize| i < len ==> arr[i] > 0";
    let m = assert_counts(spec, 5, 5, 4, 5);
    assert_close(m.difficulty, 3.125, "difficulty", spec);
}

#[test]
fn quantifier_complex_body_with_old() {
    // Test 3. Historical: length 17, difficulty 6.3. old() counts as a call
    // operator plus an `old` operand.
    // Operators: forall, <=, &&, <, ==>, [] (x2), ==, call -> 8 unique, 9 total.
    // Operands: 0, i (x4), len, arr (x2), old -> 5 unique, 9 total.
    let spec = "forall|i: usize| 0 <= i && i < len ==> arr[i] == old(arr)[i]";
    let m = assert_counts(spec, 8, 9, 5, 9);
    assert_close(m.difficulty, 7.2, "difficulty", spec);
}

#[test]
fn quantifier_nested_forall() {
    // Test 4. Historical: length 15, difficulty 2.67. Two binders now add
    // two `forall` occurrences (one unique operator).
    let spec = "forall|i: usize| i < n ==> forall|j: usize| j < m ==> matrix[i][j] == 0";
    let m = assert_counts(spec, 5, 9, 6, 8);
    assert_close(m.difficulty, 3.333, "difficulty", spec);
}

#[test]
fn quantifier_exists() {
    // Test 5. Historical: length 9, difficulty 2.5 — identical to Test 2's
    // forall, and that equivalence still holds: `exists` scores exactly like
    // `forall` (one unary operator).
    let spec = "exists|i: usize| i < len && arr[i] == target";
    let m = assert_counts(spec, 5, 5, 4, 5);
    assert_close(m.difficulty, 3.125, "difficulty", spec);
}

#[test]
fn quantifier_mixed_forall_exists() {
    // Test 6. Historical: length 15, difficulty 5.0. forall and exists are
    // distinct operators, so both raise n1.
    let spec = "forall|x: usize| x < len ==> exists|y: usize| y < len && arr[x] == arr[y]";
    let m = assert_counts(spec, 7, 9, 4, 8);
    assert_close(m.difficulty, 7.0, "difficulty", spec);
}

#[test]
fn quantifier_multiple_bound_variables() {
    // Test 7. Historical: length 15, difficulty 5.0. Two bound variables in
    // ONE quantifier: only one `forall` operator regardless of binder count.
    let spec = "forall|i: usize, j: usize| i < j && j < len ==> arr[i] <= arr[j]";
    let m = assert_counts(spec, 6, 8, 4, 8);
    assert_close(m.difficulty, 6.0, "difficulty", spec);
}

#[test]
fn quantifier_arithmetic_body() {
    // Test 8. Historical: length 16, difficulty 5.33. High operator
    // diversity: forall, ==>, <, [], ==, %, (), +, * -> 9 unique.
    let spec = "forall|i: usize| i < len ==> arr[i] == (i * SCALE + OFFSET) % MODULUS";
    let m = assert_counts(spec, 9, 9, 6, 8);
    assert_close(m.difficulty, 6.0, "difficulty", spec);
}

#[test]
fn quantifier_field_access_and_method_calls() {
    // Test 9. Historical: length 11, difficulty 5.0. Method names (len,
    // is_valid) count as operators; field access is `.`.
    let spec = "forall|i: usize| i < self.len() ==> self.data[i].is_valid()";
    let m = assert_counts(spec, 7, 7, 3, 5);
    assert_close(m.difficulty, 5.833, "difficulty", spec);
}

#[test]
fn quantifier_sorted_array_spec() {
    // Test 10. Historical: length 19, difficulty 5.0. Realistic sortedness
    // spec; high operand reuse keeps difficulty moderate.
    let spec = "forall|i: usize, j: usize| 0 <= i && i < j && j < len ==> arr[i] <= arr[j]";
    let m = assert_counts(spec, 6, 10, 5, 10);
    assert_close(m.difficulty, 6.0, "difficulty", spec);
}
