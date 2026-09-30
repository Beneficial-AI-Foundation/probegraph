import {
  D3Graph, D3Node, D3Link, LinkRole, SimplifiedNode, ProbeAtom, SourceConfig,
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

/**
 * Convert probe atom dict format (probe-verus / probe-lean atoms.json) to D3Graph format.
 */
export function convertAtomDictToD3Graph(atoms: Record<string, ProbeAtom>): D3Graph {
  const knownIds = new Set(Object.keys(atoms));

  // Explicit entry points, used as the preferred seed tier for the seeded
  // initial view on large graphs:
  // - Rust/Verus atoms marked `is-public-api` (probe-rust/probe-verus).
  // - Their Lean translation targets (Aeneas mapping join): the public-API
  //   translations have in-project callers (spec theorems), so in-degree-based
  //   seeding would hide them.
  // - Lean atoms carrying the `blueprint` attribute (@[blueprint]).
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
    };
  });

  const roleOf = new Map(Object.entries(atoms).map(([name, a]) => [name, atomRoleClassifier(a)]));
  const links: D3Link[] = [];
  for (const [atomName, atom] of Object.entries(atoms)) {
    const srcLang = atom.language;
    const depRole = roleOf.get(atomName)!;
    const isCrossLang = (dep: string) => {
      const tgtLang = atoms[dep]?.language;
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
 * Extract per-language GitHub source configs from a Schema 2.0 envelope.
 * Uses the commit hash as the git ref (always valid on GitHub).
 * For Rust workspace crates the package name becomes the path prefix.
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
    path_prefix: src.language === 'rust' ? src.package : '',
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
    if (sourceConfigs.length > 0) {
      graph.metadata.source_configs = sourceConfigs;
    }
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
