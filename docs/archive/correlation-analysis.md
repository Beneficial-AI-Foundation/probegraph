> **Archived 2026-10: numbers not reproducible.** The input CSV is not
> tracked, the spec metrics predate the `verus_syn` extractor, and
> `compute_proof_metrics` resolves lemma calls nondeterministically, so
> re-running the pipeline gives different proof efforts. Regenerate from a
> committed input before citing any figure here.

# Correlation Analysis: Code, Spec, and Proof Metrics

**Dataset:** curve25519-dalek (Verus-verified), `data/csv/pipeline_FINAL.csv`  
**Functions analyzed:** 212 total, 35 with non-trivial proofs  
**Analysis date:** November 2025 (plots in `data/plots/` generated 2025-11-27)

## Summary

We analyzed correlations between code complexity, specification complexity, and proof difficulty for Verus-verified cryptographic code. The results challenge conventional assumptions about what makes formal verification hard.

**Key Finding:** Neither code complexity nor specification complexity reliably predicts proof difficulty. Verification effort appears to depend on factors not captured by traditional software metrics.

---

## 1. Code Complexity vs Proof Difficulty

### Correlation Results

| Relationship | Correlation (r) | Sample Size | Interpretation |
|--------------|-----------------|-------------|----------------|
| Cyclomatic → Lemmas Count | **0.02** | 23 | No correlation |
| Code Halstead Length → Proof Effort | 0.35 | 29 | Weak-moderate |
| Cognitive → Proof Effort | ~0.1 | 23 | Very weak |

### Conclusion

**Control flow complexity (branches, loops) has virtually no relationship with proof difficulty.**

A function with cyclomatic complexity of 1 can require 100+ lemmas, while a function with cyclomatic complexity of 5 might need only a few. This contradicts the intuition that "complex code is harder to verify."

### Implications

- Cannot use McCabe's cyclomatic complexity to estimate verification effort
- Simple functions may hide verification challenges (e.g., mathematical properties)
- Code review metrics don't translate to formal verification metrics

---

## 2. Specification Complexity vs Proof Difficulty

### Correlation Results

| Relationship | Correlation (r) | Sample Size | Interpretation |
|--------------|-----------------|-------------|----------------|
| Spec Effort → Proof Effort | **-0.27** | 28 | Negative! |
| Spec Length → Direct Lemmas | 0.15 | 22 | Very weak |
| Ensures Count → Proof Depth | ~0.2 | 28 | Weak |

### Conclusion

**Counter-intuitively, simpler specifications sometimes require MORE proof effort.**

The negative correlation suggests that functions with elaborate specifications may actually be easier to prove (perhaps because the spec itself provides proof guidance), while functions with terse specs require more lemma development.

### Implications

- Specification complexity ≠ proof complexity
- Detailed specs may actually help the prover
- "Simple" specs can hide implicit complexity

---

## 3. Absolute Proof Difficulty Ranking

### Top 10 Functions by Transitive Proof Effort

| Rank | Function | Proof Effort | Lemmas | Depth |
|------|----------|--------------|--------|-------|
| 1 | `FieldElement::is_zero` | 26.3M | 104 | 11 |
| 2 | `FieldElement::is_negative` | 26.3M | 104 | 11 |
| 3 | `FieldElement51::as_bytes` | 23.2M | 89 | 10 |
| 4 | `Scalar52::as_bytes` | 10.9M | - | - |
| 5 | `FieldElement51::from_bytes` | 7.7M | 86 | 10 |
| 6 | `FieldElement51::pow2k` | 2.9M | - | - |
| 7 | `is_canonical` | 0.9M | - | - |
| 8 | `Scalar52::sub` | 0.8M | - | - |
| 9 | `FieldElement::pow22501` | 0.4M | - | - |
| 10 | `FieldElement51::reduce` | 0.4M | 33 | 5 |

### Concentration of Effort

```
Top 3 functions:  ~76M effort (60% of total)
Remaining 32:     ~50M effort (40% of total)
```

### Conclusion

**Proof effort is highly concentrated in a few foundational functions.**

Three functions account for 60% of all verification effort. These appear to be "proof infrastructure" - foundational lemmas that other functions reuse.

---

## 4. Proof Overhead Analysis

### Definition

```
Proof Overhead Ratio = Transitive Proof Effort / Code Effort
```

This measures how much more effort verification requires compared to implementation.

Note this is the analysis's own ratio, distinct from two similarly named CSV
columns: `proof_overhead` (transitive / direct proof effort, from
`enrich_csv_with_proof_metrics`) and `proof_overhead_direct`
(`body_length - halstead_length`, from `merge_rca_metrics`; see
[metrics-reference.md](../guides/metrics-reference.md)).

### Results

| Category | Functions | Overhead Range |
|----------|-----------|----------------|
| Extreme | `is_negative`, `is_zero` | 30,000-42,000x |
| Very High | `is_canonical`, `reduce` | 800-3,500x |
| High | `from_bytes`, `pack` | 100-500x |
| Moderate | `add`, `sub`, `mul` | 20-100x |

### Interpretation

**Caution:** High proof overhead does NOT mean "hardest to prove."

Functions with tiny code but moderate proof effort show extreme ratios. For example:
- `is_negative`: 629 code effort, 26.3M proof effort → 41,830x
- `as_bytes`: 188,838 code effort, 23.2M proof effort → 123x

The `as_bytes` function required similar absolute proof effort but has lower overhead because the implementation is larger.

---

## 5. Key Insights

### What We Learned

1. **Traditional metrics fail for verification**
   - Cyclomatic complexity: useless (r ≈ 0)
   - Cognitive complexity: useless
   - Code size: weak predictor at best

2. **Spec complexity is not predictive**
   - Complex specs ≠ hard proofs
   - Simple specs can hide verification challenges

3. **Lemma reuse dominates**
   - First function to prove a property bears the cost
   - Subsequent functions reuse lemmas "for free"
   - This explains why `is_zero`/`is_negative` share identical lemma counts

4. **Foundational proofs are expensive**
   - Byte serialization (`as_bytes`, `from_bytes`)
   - Field element properties (`is_zero`, `is_negative`)
   - These enable higher-level proofs

### What Predicts Proof Difficulty?

Based on our analysis, likely predictors include:
- Mathematical domain (field arithmetic vs. simple logic)
- Novelty (first proof of a property vs. reusing lemmas)
- Semantic gap (distance between code behavior and spec)
- Proof depth (how many layers of lemmas needed)

---

## 6. Recommendations

### For Practitioners

1. **Don't estimate verification effort from code metrics**
   - Budget based on mathematical domain complexity instead
   
2. **Invest heavily in foundational lemmas**
   - Byte conversion, field properties, arithmetic lemmas
   - These pay dividends across the entire codebase

3. **Track lemma reuse**
   - New lemma development is expensive
   - Reusing existing lemmas is cheap

---

## 7. Visualizations

The following plots were generated:

| Plot | Description |
|------|-------------|
| `data/plots/plot1_code_vs_proof.png` | Code complexity vs proof effort scatter |
| `data/plots/plot2_spec_vs_proof.png` | Spec complexity vs proof effort scatter |
| `data/plots/plot3_correlation_heatmap.png` | Full correlation matrix |
| `data/plots/plot4_proof_overhead.png` | Top functions by overhead ratio |
| `data/plots/plot5_proof_distribution.png` | Proof effort distribution |
| `data/plots/plot6_combined_complexity.png` | Combined code+spec vs proof |
| `data/plots/plot7_absolute_proof_difficulty.png` | Top functions by absolute effort |

---

## 8. Limitations

1. **Sample size**: Only 35 functions with non-trivial proofs
2. **Single codebase**: Results may not generalize beyond curve25519-dalek
3. **Transitive counting**: Same lemmas counted multiple times across functions
4. **No temporal data**: Don't know actual developer time spent

---

## 9. Future Work

1. **Lemma novelty metric**: Count only NEW lemmas per function
2. **Developer time correlation**: Compare metrics to actual verification time
3. **Cross-project analysis**: Test findings on other Verus codebases
4. **Predictive model**: Build ML model for verification effort estimation

---

## Appendix: Correlation Matrix

```
                          halstead_length  cyclomatic  ensures_effort  proof_effort  lemmas_count
halstead_length                     1.00        0.45           0.12          0.35          0.28
cyclomatic                          0.45        1.00          -0.08          0.15          0.02
ensures_halstead_effort             0.12       -0.08           1.00         -0.27          0.15
transitive_proof_effort             0.35        0.15          -0.27          1.00          0.82
transitive_lemmas_count             0.28        0.02           0.15          0.82          1.00
```

Note: Strong correlation (0.82) between proof effort and lemma count is expected - more lemmas = more code to analyze.

