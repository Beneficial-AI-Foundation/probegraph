# File Map Algorithm

## Input

A directed graph $G = (V, E)$ where:

- $V$ is a set of nodes, each with attributes:
  - $\text{name}(v) \in \Sigma^*$ — display name (string)
  - $\text{file}(v) \in \Sigma^*$ — file path
  - $\text{kind}(v) \in \Sigma^*$ — declaration kind, an open set: `exec` / `proof` / `spec` for Verus, `def` / `theorem` / `axiom` / `structure` / … for Lean
  - $\text{border}(v) \in \{\text{verified}, \text{ready}, \text{blocked}, \text{not-ready}, \text{unknown}\}$
  - $\text{fill}(v) \in \{\text{fully-verified}, \text{verified}, \text{ready}, \text{none}\}$

- $E \subseteq V \times V \times T$ where $T = \{\text{inner}, \text{pre}, \text{post}, \text{mapping}, \text{spec}\}$ — typed directed edges

## Output

A visual embedding $\mathcal{R}$ consisting of:

- A position function $\text{pos}: V \to \mathbb{R}^2$
- A set of rendered shapes $S = \{s_v \mid v \in V\}$
- A set of rendered curves $C = \{c_e \mid e \in E'\}$ where $E' \subseteq E$
- A set of group rectangles $B = \{b_f \mid f \in \mathcal{F}\}$ where $\mathcal{F}$ is the set of file groups
- Interaction handlers $\mathcal{I}$ (click, hover, leave)

## Algorithm

### Step 1. Transitive Reduction

Compute $E' = \text{TR}(G)$, the transitive reduction of $G$.

$$
E' = \{ (u, v, t) \in E \mid \neg \exists \text{ path } u \to w_1 \to \cdots \to w_k \to v \text{ in } G \text{ with } k \geq 1 \text{ avoiding the direct } (u,v) \text{ edge} \}
$$

This yields a graph $G' = (V, E')$ with the same reachability as $G$ but with minimum edges.

### Step 2. File Partitioning

Define the partition $\mathcal{F}$ of $V$ induced by the file attribute:

$$
\mathcal{F} = \{ V_f \mid f \in \text{Im}(\text{file}) \}, \quad V_f = \{ v \in V \mid \text{file}(v) = f \}
$$

This is a partition: $\bigsqcup_{f} V_f = V$.

### Step 3. Node Sizing

Define a width function $w: V \to \mathbb{R}^+$:

$$
w(v) = \max(120, \; |\text{name}(v)| \cdot 6.5 + 24)
$$

Height is constant: $h = 36$ for all nodes.

### Step 4. Compound DAG Layout

This is the core computational step. We solve a constrained optimization problem.

Given the compound graph $\mathcal{G} = (V, E', \mathcal{F})$ — a DAG with hierarchical clustering — find:

$$
\text{pos}: V \to \mathbb{R}^2, \quad \text{bbox}: \mathcal{F} \to \mathbb{R}^2 \times \mathbb{R}^2
$$

subject to:

1. **Rank ordering** (left-to-right): for every $(u, v, t) \in E'$:

$$
\text{pos}(u)_x < \text{pos}(v)_x
$$

2. **Cluster containment**: for every $f \in \mathcal{F}$ and $v \in V_f$:

$$
v \text{ is geometrically inside } \text{bbox}(f)
$$

3. **Non-overlap**: for all $u \neq v \in V$, the bounding boxes of $u$ and $v$ (defined by $w(u) \times h$ centered at $\text{pos}(u)$) do not overlap.

4. **Minimize edge crossings**: among valid layouts, prefer those minimizing $|\{(e_1, e_2) \in E' \times E' \mid e_1 \text{ crosses } e_2\}|$.

5. **Compactness**: minimize total area, with spacing constraints:
   - Vertical separation between nodes $\geq 30\text{px}$
   - Horizontal separation between ranks $\geq 160\text{px}$
   - Margins $\geq 40\text{px}$

This is solved by the dagre library (a Sugiyama-style layered graph drawing algorithm). It is NP-hard in general; dagre uses heuristics.

If the compound layout fails (throws), fall back to a flat layout: solve the same problem on $(V, E')$ without the clustering constraints. In that case, $\text{bbox}$ is undefined and group backgrounds are not drawn.

### Step 5. Visual Encoding

Define three mapping functions from data attributes to visual properties.

**Shape function** $\sigma: \text{Kind} \to \{\text{rounded-rect}, \text{ellipse}, \text{diamond}\}$, defined over language-aware kind *sets* (`getKindSetsForLanguage` in `types.ts`, applied in `appendShape` in `file-map.ts`):

$$
\sigma(k) = \begin{cases}
\text{ellipse} & \text{if } k \in \text{proofKinds} \; (\text{Verus: proof; Lean: theorem}) \\
\text{diamond} & \text{if } k \in \text{specKinds} \cup \text{axiomKinds} \\
\text{rounded-rect} & \text{otherwise (the default, exec/definition bucket)}
\end{cases}
$$

Axioms deliberately reuse the spec diamond even though they filter
separately. The legend labels flip with the project language: "Exec function
/ Proof / lemma / Spec function" for Verus, "Definition / Theorem / Axiom"
for Lean.

**Border color function** $\beta: \text{BorderStatus} \to \text{Color}$:

$$
\beta(s) = \begin{cases}
\text{green} & \text{if } s = \text{verified} \\
\text{blue} & \text{if } s = \text{ready} \\
\text{red} & \text{if } s = \text{blocked} \\
\text{amber} & \text{if } s = \text{not-ready} \\
\text{gray} & \text{if } s = \text{unknown}
\end{cases}
$$

**Fill color function** $\phi: \text{FillStatus} \to \text{Color}$:

$$
\phi(s) = \begin{cases}
\text{dark green} & \text{if } s = \text{fully-verified} \\
\text{light green} & \text{if } s = \text{verified} \\
\text{light blue} & \text{if } s = \text{ready} \\
\text{white} & \text{if } s = \text{none}
\end{cases}
$$

**Group color function** $\gamma: \mathcal{F} \to \text{Color}$, cycling through an 8-color palette:

$$
\gamma(f_i) = \text{palette}[i \bmod 8]
$$

### Step 6. Edge Geometry

Each edge $(u, v, t) \in E'$ is rendered as a cubic Bézier curve $\mathbf{B}(\tau)$ for $\tau \in [0, 1]$.

Let $(x_u, y_u) = \text{pos}(u)$, $(x_v, y_v) = \text{pos}(v)$, $\delta = x_v - x_u$.

$$
\mathbf{B}(\tau) = (1-\tau)^3 P_0 + 3(1-\tau)^2 \tau \, P_1 + 3(1-\tau) \tau^2 \, P_2 + \tau^3 P_3
$$

where:

$$
P_0 = \left(x_u + \frac{w(u)}{2}, \; y_u\right) \quad \text{(right edge of source)}
$$

$$
P_1 = \left(x_u + \frac{w(u)}{2} + 0.4\delta, \; y_u\right)
$$

$$
P_2 = \left(x_v - \frac{w(v)}{2} - 0.4\delta, \; y_v\right)
$$

$$
P_3 = \left(x_v - \frac{w(v)}{2}, \; y_v\right) \quad \text{(left edge of target)}
$$

Edge style depends on type:

$$
\text{style}(t) = \begin{cases}
\text{solid gray} & \text{if } t = \text{inner} \\
\text{dashed orange} & \text{if } t = \text{pre} \\
\text{dashed pink} & \text{if } t = \text{post}
\end{cases}
$$

### Step 7. Interaction Model

Define the interaction state as $\mathcal{S} = (\text{selected} \subseteq V, \; \text{hovered} \in V \cup \{\bot\})$.

**Click on node $v$**:

$$
\text{selected}' = \begin{cases}
\text{selected} \setminus \{v\} & \text{if } v \in \text{selected} \\
\text{selected} \cup \{v\} & \text{otherwise}
\end{cases}
$$

**Shift+click on node $v$**:

$$
V' = V \setminus \{v\}, \quad E' \leftarrow E' \setminus \{(u,w,t) \mid u = v \lor w = v\}
$$

(Remove node from graph, trigger re-render.)

**Hover on node $v$**:

Define the 1-neighborhood:

$$
N(v) = \{v\} \cup \{u \mid (u,v,\_) \in E' \lor (v,u,\_) \in E'\}
$$

Apply opacity:

$$
\text{opacity}(u) = \begin{cases}
1.0 & \text{if } u \in N(v) \\
0.2 & \text{otherwise}
\end{cases}
$$

**Leave**:

$$
\forall u \in V: \text{opacity}(u) = 1.0
$$

## Summary: Pipeline Composition

The whole algorithm is a pipeline of transformations:

$$
G \xrightarrow{\text{TR}} G' \xrightarrow{\Pi_{\text{file}}} (G', \mathcal{F}) \xrightarrow{\text{dagre}} (\text{pos}, \text{bbox}) \xrightarrow{\sigma, \beta, \phi, \gamma, \mathbf{B}} \mathcal{R}
$$

Or more compactly:

$$
\text{Blueprint} = \text{Render} \circ \text{Layout} \circ \text{Partition} \circ \text{Reduce}
$$

where:

| Stage | Function | Description | Complexity |
|-------|----------|-------------|------------|
| Reduce | $(V, E) \to (V, E')$ | Transitive reduction | Graph algorithm (BFS per edge) |
| Partition | $(V, E') \to (V, E', \mathcal{F})$ | File grouping | Trivial set partition, $O(|V|)$ |
| Layout | $(V, E', \mathcal{F}) \to (\text{pos}, \text{bbox})$ | Constrained DAG placement | NP-hard, solved by heuristic (dagre/Sugiyama) |
| Render | $(\text{pos}, \text{bbox}, \sigma, \beta, \phi, \gamma, \mathbf{B}) \to \mathcal{R}$ | Visual encoding + interaction | Mapping functions + Bézier computation |

A declarative config can parameterize **Partition** — choosing which attribute induces $\mathcal{F}$. That is one function in a four-stage pipeline, and it is the only stage that is a trivial set operation. The other three stages are algorithms that require code.

## Relationship to Known Algorithms and Techniques

### Compound DAG Layout (Sugiyama Framework)

**References.**
- Sugiyama, Tagawa & Toda, "Methods for Visual Understanding of Hierarchical System Structures," *IEEE Trans. Systems, Man, and Cybernetics* 11(2), 1981. — The foundational four-phase layered graph drawing framework.
- Gansner, Koutsofios, North & Vo, "A Technique for Drawing Directed Graphs," *IEEE Trans. Software Engineering* 19(3), 1993. — The basis of Graphviz's `dot` layout engine; dagre is a JavaScript reimplementation of this.
- Sander, "Layout of Compound Directed Graphs," Technical Report, Universität des Saarlandes, 1996. — Extension of Sugiyama to compound (clustered) graphs.

**Relationship: instantiation with compound extension.** The Sugiyama framework has four phases:

1. **Cycle removal** — make the graph acyclic (dagre reverses back-edges)
2. **Layer assignment** — assign each node to a horizontal rank (longest-path or network-simplex method)
3. **Crossing minimization** — reorder nodes within each layer to minimize edge crossings (NP-hard; dagre uses the barycenter heuristic)
4. **Coordinate assignment** — compute final $(x, y)$ positions (Brandes-Köpf algorithm in dagre)

Our usage is an **instantiation** of this framework via the dagre library, with the **compound graph extension** from Sander: nodes are grouped into file clusters, and the layout must respect cluster containment constraints. The `rankdir: 'LR'` parameter selects a left-to-right variant (transposing the standard top-to-bottom Sugiyama layout).

### Overall Pipeline — Compound Graph Visualization

**Reference.** Sugiyama & Misue, "Visualization of Structural Information: Automatic Drawing of Compound Digraphs," *IEEE Trans. Systems, Man, and Cybernetics* 21(4), 1991.

**Relationship: instantiation.** The full pipeline — transitive reduction, partition into clusters, compound DAG layout, visual encoding — is an instance of the compound digraph visualization problem defined by Sugiyama & Misue. The input is a directed graph with a hierarchical grouping structure; the output is a drawing that respects the grouping while minimizing visual clutter. Our specific contribution is the domain-specific visual encoding (shape = declaration kind, color = verification status), which layers a formal-verification semantics onto the standard compound graph framework.
