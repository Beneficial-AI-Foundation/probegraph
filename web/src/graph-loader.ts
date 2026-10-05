import {
  D3Graph, D3Node, D3Link, LinkRole, SimplifiedNode, ProbeAtom, SourceConfig, BlueprintInfo, BLUEPRINT_LANGUAGE,
  Schema2Envelope, Schema2Source,
  isSimplifiedFormat, isD3GraphFormat, isAtomDictFormat, isSchema2Envelope,
  VerificationStatus,
} from './types';

/**
 * Convert simplified JSON format (array of nodes with deps) to D3Graph format.
 */
export function convertSimplifiedToD3Graph(nodes: SimplifiedNode[]): D3Graph {
  const knownIds = new Set(nodes.map(n => n.identifier));

  const dependentsMap = new Map<string, string[]>();
  for (const node of nodes) {
    if (!dependentsMap.has(node.identifier)) {
      dependentsMap.set(node.identifier, []);
    }
    for (const dep of node.deps) {
      if (!dependentsMap.has(dep)) {
        dependentsMap.set(dep, []);
      }
      dependentsMap.get(dep)!.push(node.identifier);
    }
  }

  const d3Nodes: D3Node[] = nodes.map(node => {
    let fullPath = node.full_path;
    if (fullPath.startsWith('file://')) {
      fullPath = fullPath.substring(7);
    }
    const filteredDeps = node.deps.filter(dep => knownIds.has(dep));
    const dependents = dependentsMap.get(node.identifier) || [];

    return {
      id: node.identifier,
      display_name: node.display_name,
      symbol: node.identifier,
      full_path: fullPath,
      relative_path: node.relative_path,
      file_name: node.file_name,
      parent_folder: node.parent_folder,
      crate_name: '',
      start_line: undefined,
      end_line: undefined,
      is_libsignal: false,
      dependencies: filteredDeps,
      dependents: dependents.filter(dep => knownIds.has(dep)),
      kind: 'exec' as const,
    };
  });

  const links: D3Link[] = [];
  for (const node of d3Nodes) {
    for (const dep of node.dependencies) {
      links.push({ source: node.id, target: dep, type: 'inner' });
    }
  }

  return {
    nodes: d3Nodes,
    links,
    metadata: {
      total_nodes: d3Nodes.length,
      total_edges: links.length,
      project_root: 'Simplified JSON (no project root)',
      generated_at: new Date().toISOString(),
    },
  };
}

/**
 * Dependencies the extractor recorded as outside its project (probe-lean's
 * `*-dependencies-external`) that resolve to atoms in the loaded graph — this
 * happens after a cross-project `probe merge`. Unresolved externals and names
 * already in `dependencies` are dropped.
 */
function resolvedExternalDeps(atom: ProbeAtom, knownIds: Set<string>): string[] {
  const external = [
    ...(atom["type-dependencies-external"] ?? []),
    ...(atom["term-dependencies-external"] ?? []),
  ];
  return [...new Set(external)].filter(
    dep => knownIds.has(dep) && !atom.dependencies.includes(dep)
  );
}

/**
 * Role lookup for one atom's dependencies from its statement / body-or-proof
 * split. Both arrays must be present: an absent array means the extractor
 * recorded no split (no role), an empty one means no edges of that role.
 */
function roleClassifier(
  typeDeps: string[] | undefined,
  termDeps: string[] | undefined,
): (dep: string) => LinkRole | undefined {
  if (!typeDeps || !termDeps) return () => undefined;
  const inType = new Set(typeDeps);
  const inTerm = new Set(termDeps);
  return dep => {
    if (inType.has(dep)) return inTerm.has(dep) ? 'both' : 'type';
    return inTerm.has(dep) ? 'term' : undefined;
  };
}

/**
 * Role of any of the atom's dependencies: in-project ones from the internal
 * split, resolved externals from the external split, combined if a name is
 * in both.
 */
function atomRoleClassifier(atom: ProbeAtom): (dep: string) => LinkRole | undefined {
  const internal = roleClassifier(atom["type-dependencies"], atom["term-dependencies"]);
  // probe-lean omits an external array when it is empty
  const external = roleClassifier(
    atom["type-dependencies-external"] ?? [], atom["term-dependencies-external"] ?? [],
  );
  return dep => {
    const a = internal(dep);
    const b = external(dep);
    // A name in both splits (not expected from one extraction) keeps both roles
    return a && b && a !== b ? 'both' : a ?? b;
  };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;

/**
 * The probe-leanblueprint fields of an atom, or undefined when it has no
 * `blueprint-label`. Values of the wrong type are dropped: the extract is
 * third-party input. `bindings` is left to the caller.
 */
function blueprintInfo(atom: ProbeAtom): BlueprintInfo | undefined {
  const label = str(atom["blueprint-label"]);
  if (label === undefined) return undefined;
  const lines = atom["blueprint-source-lines"];
  const info: BlueprintInfo = {
    label,
    kind: str(atom["blueprint-kind"]),
    title: str(atom["blueprint-title"]),
    chapter: str(atom["blueprint-chapter"]),
    group: str(atom["blueprint-group"]),
    statementStatus: str(atom["blueprint-statement-status"]),
    proofStatus: str(atom["blueprint-proof-status"]),
    statusSource: str(atom["blueprint-status-source"]),
    mismatch: str(atom["blueprint-status-mismatch"]),
    missingDecls: strList(atom["blueprint-missing-decls"]),
    upstreamDecls: strList(atom["blueprint-upstream-decls"]),
    githubIssue: str(atom["blueprint-github-issue"]),
    nodeClass: str(atom["blueprint-node-class"]),
    statementText: str(atom["blueprint-statement-text"]),
    statementFormat: str(atom["blueprint-statement-format"]),
    sourcePath: str(atom["blueprint-source-path"]),
    sourceLines: lines && typeof lines["lines-start"] === 'number' && typeof lines["lines-end"] === 'number'
      ? { start: lines["lines-start"], end: lines["lines-end"] }
      : undefined,
  };
  // Drop absent fields so node objects stay small
  for (const k of Object.keys(info) as (keyof BlueprintInfo)[]) {
    if (info[k] === undefined) delete info[k];
  }
  return info;
}

/**
 * Build the blueprint layer from probe-leanblueprint node atoms. Edges come
 * from the node-to-node uses fields: statement uses have role `type`, proof
 * uses role `term`, a name in both `both`. A bound node atom's
 * `dependencies` are its Lean bindings, kept in `blueprint.bindings` and
 * never turned into edges.
 */
function convertBlueprintNodes(
  nodeAtoms: Record<string, ProbeAtom>,
  codeIds: Set<string>,
): D3Graph {
  const nodeIds = new Set(Object.keys(nodeAtoms));
  const links: D3Link[] = [];
  const depsOf = new Map<string, string[]>();
  const dependentsOf = new Map<string, string[]>([...nodeIds].map(id => [id, []]));

  for (const [id, atom] of Object.entries(nodeAtoms)) {
    const statementUses = new Set(strList(atom["blueprint-statement-uses"]) ?? []);
    const proofUses = new Set(strList(atom["blueprint-proof-uses"]) ?? []);
    const targets = [...new Set([...statementUses, ...proofUses])].filter(t => nodeIds.has(t));
    depsOf.set(id, targets);
    for (const target of targets) {
      const role: LinkRole = statementUses.has(target)
        ? (proofUses.has(target) ? 'both' : 'type')
        : 'term';
      links.push({ source: id, target, type: 'inner', role });
      dependentsOf.get(target)!.push(id);
    }
  }

  const nodes: D3Node[] = Object.entries(nodeAtoms).map(([id, atom]) => {
    const codePath = atom["code-path"] || '';
    const parts = codePath.split('/');
    const info = blueprintInfo(atom) ?? { label: atom["display-name"] };
    const bindings = (strList(atom.dependencies) ?? []).filter(d => codeIds.has(d));
    if (bindings.length > 0) info.bindings = [...new Set(bindings)];
    return {
      id,
      display_name: atom["display-name"],
      symbol: id,
      full_path: codePath,
      relative_path: codePath,
      file_name: parts[parts.length - 1] || 'unknown',
      parent_folder: parts.length >= 2 ? parts[parts.length - 2] : 'unknown',
      crate_name: '',
      is_libsignal: false,
      dependencies: depsOf.get(id)!,
      dependents: dependentsOf.get(id)!,
      kind: atom.kind || 'blueprint-definition',
      verification_status: atom["verification-status"] as VerificationStatus | undefined,
      language: BLUEPRINT_LANGUAGE,
      blueprint: info,
    };
  });

  return {
    nodes,
    links,
    metadata: {
      total_nodes: nodes.length,
      total_edges: links.length,
      project_root: 'Blueprint layer',
      generated_at: new Date().toISOString(),
    },
  };
}

/**
 * The language an edge is judged cross-language against. probe-verus tags
 * exec atoms `rust` and spec/proof atoms `verus`, so an exec function's
 * requires/ensures edges are not translations and must keep their location.
 */
function languageFamily(language: string | undefined): string | undefined {
  return language === 'verus' ? 'rust' : language;
}

/**
 * Convert probe atom dict format (probe-verus / probe-lean atoms.json) to D3Graph format.
 * probe-leanblueprint node atoms (`language: "blueprint"`) are left out of
 * the result and returned as its `blueprintLayer`.
 */
export function convertAtomDictToD3Graph(input: Record<string, ProbeAtom>): D3Graph {
  const atoms: Record<string, ProbeAtom> = {};
  const nodeAtoms: Record<string, ProbeAtom> = {};
  for (const [name, atom] of Object.entries(input)) {
    if (atom.language === BLUEPRINT_LANGUAGE) nodeAtoms[name] = atom;
    else atoms[name] = atom;
  }
  const graph = convertCodeAtoms(atoms);
  if (Object.keys(nodeAtoms).length > 0) {
    graph.blueprintLayer = convertBlueprintNodes(nodeAtoms, new Set(Object.keys(atoms)));
  }
  return graph;
}

function convertCodeAtoms(atoms: Record<string, ProbeAtom>): D3Graph {
  const knownIds = new Set(Object.keys(atoms));

  // Explicit entry points, used as the preferred seed tier for the seeded
  // initial view on large graphs:
  // - Rust/Verus atoms marked `is-public-api` (probe-rust/probe-verus).
  // - Their Lean translation targets (Aeneas mapping join): the public-API
  //   translations have in-project callers (spec theorems), so in-degree-based
  //   seeding would hide them.
  // - Lean atoms carrying the `blueprint` attribute (@[blueprint]) or bound
  //   by a probe-leanblueprint node (`blueprint-label`).
  const entryPointIds = new Set<string>();
  for (const [atomName, atom] of Object.entries(atoms)) {
    if (atom["is-public-api"] === true) {
      entryPointIds.add(atomName);
      const translation = atom["translation-name"];
      if (translation && knownIds.has(translation)) entryPointIds.add(translation);
    }
    if (Array.isArray(atom.attributes) && atom.attributes.includes('blueprint')) {
      entryPointIds.add(atomName);
    }
    if (typeof atom["blueprint-label"] === 'string') entryPointIds.add(atomName);
  }

  const dependentsMap = new Map<string, string[]>();
  for (const [atomName, atom] of Object.entries(atoms)) {
    if (!dependentsMap.has(atomName)) {
      dependentsMap.set(atomName, []);
    }
    for (const dep of new Set([...atom.dependencies, ...resolvedExternalDeps(atom, knownIds)])) {
      if (!dependentsMap.has(dep)) {
        dependentsMap.set(dep, []);
      }
      dependentsMap.get(dep)!.push(atomName);
    }
  }

  const d3Nodes: D3Node[] = Object.entries(atoms).map(([atomName, atom]) => {
    const codePath = atom["code-path"] || '';
    const parts = codePath.split('/');
    const fileName = parts[parts.length - 1] || 'unknown';
    const parentFolder = parts.length >= 2 ? parts[parts.length - 2] : 'unknown';

    const filteredDeps = [...new Set([
      ...atom.dependencies.filter(dep => knownIds.has(dep)),
      ...resolvedExternalDeps(atom, knownIds),
    ])];
    const dependents = (dependentsMap.get(atomName) || []).filter(dep => knownIds.has(dep));

    const codeText = atom["code-text"];

    const mappingText = atom["translation-text"];

    return {
      id: atomName,
      display_name: atom["display-name"],
      symbol: atomName,
      full_path: codePath,
      relative_path: codePath,
      file_name: fileName,
      parent_folder: parentFolder,
      crate_name: '',
      start_line: codeText ? codeText["lines-start"] : undefined,
      end_line: codeText ? codeText["lines-end"] : undefined,
      is_libsignal: false,
      dependencies: filteredDeps,
      dependents,
      kind: atom.kind || 'exec',
      verification_status: atom["verification-status"] as VerificationStatus | undefined,
      language: atom.language,
      mapping_id: atom["translation-name"],
      mapping_path: atom["translation-path"],
      mapping_lines: mappingText
        ? { start: mappingText["lines-start"], end: mappingText["lines-end"] }
        : undefined,
      specs: atom.specs?.filter(s => knownIds.has(s)),
      rust_source: atom["rust-source"] ?? undefined,
      is_public_api: atom["is-public-api"],
      attributes: atom.attributes,
      is_entry_point: entryPointIds.has(atomName) || undefined,
      blueprint: blueprintInfo(atom),
      is_hidden: atom["is-hidden"] === true || undefined,
      is_generated: atom["is-lean-generated"] === true || atom["is-aeneas-generated"] === true || undefined,
    };
  });

  const roleOf = new Map(Object.entries(atoms).map(([name, a]) => [name, atomRoleClassifier(a)]));
  const links: D3Link[] = [];
  for (const [atomName, atom] of Object.entries(atoms)) {
    const srcLang = languageFamily(atom.language);
    const depRole = roleOf.get(atomName)!;
    const isCrossLang = (dep: string) => {
      const tgtLang = languageFamily(atoms[dep]?.language);
      return Boolean(srcLang && tgtLang && srcLang !== tgtLang);
    };

    if (atom["dependencies-with-locations"] && atom["dependencies-with-locations"].length > 0) {
      // One entry per call site; D3Link has no line, so keep one link per (target, type)
      const seen = new Set<string>();
      for (const dep of atom["dependencies-with-locations"]) {
        const target = dep["code-name"];
        if (!knownIds.has(target)) continue;
        const type = isCrossLang(target) ? 'mapping' : (dep.location || 'inner');
        const key = `${target}\0${type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Only inner links carry a role; pre/postcondition links do not
        const role = type === 'inner' ? depRole(target) : undefined;
        links.push({ source: atomName, target, type, ...(role && { role }) });
      }
    } else {
      // One inner link per target; its role comes from the split arrays
      const seen = new Set<string>();
      for (const dep of atom.dependencies) {
        if (!knownIds.has(dep) || seen.has(dep)) continue;
        seen.add(dep);
        if (isCrossLang(dep)) {
          links.push({ source: atomName, target: dep, type: 'mapping' });
          continue;
        }
        const role = depRole(dep);
        links.push({ source: atomName, target: dep, type: 'inner', ...(role && { role }) });
      }
    }

    // Cross-project edges: externals that resolve after a merge
    for (const dep of resolvedExternalDeps(atom, knownIds)) {
      if (isCrossLang(dep)) {
        links.push({ source: atomName, target: dep, type: 'mapping' });
        continue;
      }
      const role = depRole(dep);
      links.push({ source: atomName, target: dep, type: 'inner', ...(role && { role }) });
    }

    // Rust -> Lean mapping link
    if (atom["translation-name"] && knownIds.has(atom["translation-name"])) {
      links.push({
        source: atomName,
        target: atom["translation-name"],
        type: 'mapping',
      });
    }

    // Lean def -> spec theorem links (spec *specifies* the def). A spec link
    // takes the role of the theorem's inner link to the def, so the role
    // boxes cannot be bypassed through it.
    if (atom.specs) {
      for (const specId of atom.specs) {
        if (knownIds.has(specId)) {
          const role = roleOf.get(specId)!(atomName);
          links.push({ source: specId, target: atomName, type: 'spec', ...(role && { role }) });
        }
      }
    }
  }

  return {
    nodes: d3Nodes,
    links,
    metadata: {
      total_nodes: d3Nodes.length,
      total_edges: links.length,
      project_root: 'Probe atom dict',
      generated_at: new Date().toISOString(),
    },
  };
}

/**
 * Parse JSON data and convert to D3Graph format if needed.
 * Supports D3Graph format, simplified format, probe atom dict format,
 * and Schema 2.0 envelopes.
 */
/**
 * Directory of a source's package inside its repo, prepended to atom paths
 * when linking to GitHub. The envelope's `package-path` is authoritative.
 * Without it, a Rust package is assumed to be a workspace member named
 * after itself (`curve25519-dalek/src/...`); that guess is wrong for a
 * crate at the repo root or in a differently named directory, so producers
 * should emit `package-path`. Lean paths are relative to the Lake root,
 * which is taken to be the repo root.
 */
export function sourcePathPrefix(src: Schema2Source): string {
  const declared = src['package-path'];
  if (typeof declared === 'string') return declared.replace(/^\/|\/$/g, '');
  return src.language === 'rust' ? src.package : '';
}

/**
 * Extract per-language GitHub source configs from a Schema 2.0 envelope.
 * Uses the commit hash as the git ref (always valid on GitHub).
 */
function extractSourceConfigs(envelope: Schema2Envelope): SourceConfig[] {
  const entries: Schema2Source[] = [];
  if (envelope.inputs) {
    for (const input of envelope.inputs) entries.push(input.source);
  } else if (envelope.source) {
    entries.push(envelope.source);
  }

  return entries.map(src => ({
    github_url: src.repo.replace(/\.git$/, ''),
    ref: src.commit,
    path_prefix: sourcePathPrefix(src),
    language: src.language,
    package: src.package,
  }));
}

/**
 * Pick the source config for a node. Language must match; when several
 * same-language inputs exist (a cross-project merge), prefer the config whose
 * package matches the node's root path segment (e.g.
 * `SecureMessaging/ErasureCode/Defs.lean` → `SecureMessaging`), falling back
 * to the first language match.
 */
export function pickSourceConfig(
  configs: SourceConfig[],
  language: string | undefined,
  relativePath: string,
): SourceConfig | undefined {
  if (!language) return undefined;
  const candidates = configs.filter(c => c.language === language);
  const root = relativePath.split('/')[0].replace(/\.lean$/, '');
  return candidates.find(c => c.package === root) ?? candidates[0];
}

export function parseAndNormalizeGraph(data: unknown): D3Graph {
  if (isSchema2Envelope(data)) {
    const sourceConfigs = extractSourceConfigs(data);
    const graph = parseAndNormalizeGraph(data.data);
    // A merge's timestamp is when it merged, and it has one commit per input
    const single = !data.inputs;
    const provenance = {
      ...(sourceConfigs.length > 0 && { source_configs: sourceConfigs }),
      ...(single && typeof data.timestamp === 'string' && { extracted_at: data.timestamp }),
      ...(single && typeof data.source?.commit === 'string' && { source_commit: data.source.commit }),
    };
    if (graph.metadata) Object.assign(graph.metadata, provenance);
    if (graph.blueprintLayer) Object.assign(graph.blueprintLayer.metadata, provenance);
    return graph;
  }
  if (isD3GraphFormat(data)) {
    return data;
  }
  if (isAtomDictFormat(data)) {
    return convertAtomDictToD3Graph(data);
  }
  if (isSimplifiedFormat(data)) {
    return convertSimplifiedToD3Graph(data);
  }
  console.warn('Unknown JSON format, attempting to use as D3Graph');
  return data as D3Graph;
}

/** Above this share of links with an unknown endpoint, a graph is rejected. */
const MAX_DANGLING_LINK_SHARE = 0.1;

/**
 * Structural problems that make a normalized graph unusable, empty when there
 * are none. parseAndNormalizeGraph passes unknown input through as a D3Graph,
 * so this is what tells a graph from arbitrary JSON.
 */
export function validateGraph(graph: unknown): string[] {
  if (typeof graph !== 'object' || graph === null) return ['not an object'];
  const { nodes, links } = graph as { nodes?: unknown; links?: unknown };
  if (!Array.isArray(nodes)) return ['no nodes array: not a format probegraph reads'];
  if (!Array.isArray(links)) return ['no links array'];

  const problems: string[] = [];
  const ids = new Set<string>();
  nodes.forEach((n, i) => {
    const node = n as Partial<D3Node> | null;
    if (typeof node?.id !== 'string' || node.id === '') problems.push(`node ${i} has no id`);
    else if (ids.has(node.id)) problems.push(`duplicate node id ${node.id}`);
    else ids.add(node.id);
    if (typeof node?.display_name !== 'string') problems.push(`node ${i} has no display_name`);
  });

  const endpoint = (e: unknown) =>
    typeof e === 'string' ? e : typeof e === 'object' && e !== null ? (e as { id?: unknown }).id : undefined;
  const dangling = links.filter(l => {
    const link = l as Partial<D3Link> | null;
    return !ids.has(endpoint(link?.source) as string) || !ids.has(endpoint(link?.target) as string);
  }).length;
  if (dangling > links.length * MAX_DANGLING_LINK_SHARE) {
    problems.push(`${dangling} of ${links.length} links have an unknown endpoint`);
  }
  return problems.slice(0, 10);
}
