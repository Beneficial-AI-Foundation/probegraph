import { D3Graph, D3Node, FilterOptions, ProjectLanguage } from './types';
import { compileQuery, executeQuery } from './query';

/**
 * Convert a glob pattern to a regex
 * - * matches any characters (including empty)
 * - ? matches a single character
 * - Other regex special chars are escaped
 * - Pattern is anchored: p_* matches "p_foo" but not "step_1"
 * - Use *pattern* for substring matching
 * 
 * @public Exported for testing
 */
export function globToRegex(pattern: string): RegExp {
  let regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  regexStr = regexStr.replace(/\*/g, '.*');
  regexStr = regexStr.replace(/\?/g, '.');
  regexStr = '^' + regexStr + '$';
  return new RegExp(regexStr, 'i');
}

/**
 * If the pattern has no glob wildcards (* or ?), wrap it with * on both sides
 * so that globToRegex produces a substring match instead of an exact match.
 * Patterns that already contain wildcards are returned unchanged.
 *
 * @public Exported for testing
 */
export function asSubstringGlob(pattern: string): string {
  if (pattern.includes('*') || pattern.includes('?')) {
    return pattern;
  }
  return `*${pattern}*`;
}

/**
 * Convert a path pattern to a regex that matches against relative_path
 * 
 * Unlike globToRegex (which anchors with ^...$), this handles partial paths:
 * - "ifma/edwards.rs" - matches paths ENDING with "/ifma/edwards.rs" or equal to "ifma/edwards.rs"
 * - "** /ifma/edwards.rs" - matches any path ending with "/ifma/edwards.rs"
 * - "curve25519-dalek/ **" - matches paths starting with "curve25519-dalek/"
 * 
 * @public Exported for testing
 */
export function pathPatternToRegex(pattern: string): RegExp {
  let regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  regexStr = regexStr.replace(/\*\*/g, '<<<GLOBSTAR>>>');
  regexStr = regexStr.replace(/\*/g, '[^/]*');
  regexStr = regexStr.replace(/\?/g, '[^/]');
  regexStr = regexStr.replace(/<<<GLOBSTAR>>>/g, '.*');

  if (pattern.startsWith('**/')) {
    regexStr = regexStr.replace(/^\.\*\//, '');
    regexStr = '(^|.*/)' + regexStr + '$';
  } else if (!pattern.startsWith('**')) {
    regexStr = '(^|/)' + regexStr + '$';
  } else {
    regexStr = regexStr + '$';
  }
  return new RegExp(regexStr, 'i');
}

/**
 * Check if a node matches a search query
 * 
 * Supports two modes:
 * - Substring match (default): "foo" matches anything containing "foo" in display_name.
 *   Glob wildcards (* and ?) opt into anchored matching instead (e.g. "p_*" matches
 *   only names starting with "p_").
 * - Path-qualified match: "path::function" matches functions in files/paths matching
 *   "path" whose display_name contains "function".
 *   Examples:
 *   - "edwards::decompress" -> decompress in edwards.rs
 *   - "ristretto::*compress*" -> explicit glob in path-qualified mode
 *
 * @public Exported for testing
 */
export function matchesQuery(node: D3Node, query: string): boolean {
  if (query.startsWith('crate:')) {
    const crateName = query.slice(6);
    const crateRegex = globToRegex(asSubstringGlob(crateName));
    return crateRegex.test(node.crate_name);
  }

  const doubleColonIndex = query.indexOf('::');
  if (doubleColonIndex > 0 && doubleColonIndex < query.length - 2) {
    const pathPart = query.slice(0, doubleColonIndex);
    const funcPart = query.slice(doubleColonIndex + 2);

    const fileNameWithoutExt = node.file_name.replace(/\.(rs|lean)$/, '');
    const pathRegex = globToRegex(pathPart);
    const pathMatches =
      pathRegex.test(fileNameWithoutExt) ||
      pathRegex.test(node.parent_folder);

    if (pathMatches) {
      const funcRegex = globToRegex(asSubstringGlob(funcPart));
      if (funcRegex.test(node.display_name)) {
        return true;
      }
    }
    // Fall through: the query may contain "::" as part of the display_name
  }

  // Substring match against display_name
  const regex = globToRegex(asSubstringGlob(query));
  if (regex.test(node.display_name)) {
    return true;
  }

  // When the query contains a "." (Lean module separator), also try matching
  // against the full node ID.  This lets "Scalar52.add_spec" resolve to
  // "probe:...Scalar52.add_spec" without broadening plain queries like
  // "decompress" (which would over-match SCIP symbol paths).
  if (query.includes('.')) {
    return regex.test(node.id);
  }

  return false;
}

/**
 * Apply filters to a graph, returning a filtered D3Graph.
 *
 * This is the public entry point used by the rest of the application.
 * Internally it delegates to the composable query pipeline:
 *   compileQuery -> executeQuery
 */
export function applyFilters(
  fullGraph: D3Graph,
  filters: FilterOptions,
  projectLanguage: ProjectLanguage = 'unknown',
): D3Graph {
  const compiled = compileQuery(filters, projectLanguage);
  return executeQuery(compiled, fullGraph);
}

/**
 * Get immediate callers of a node
 */
export function getCallers(graph: D3Graph, nodeId: string): D3Node[] {
  const callers: D3Node[] = [];
  const nodeMap = new Map(graph.nodes.map(node => [node.id, node]));

  for (const link of graph.links) {
    const targetId = typeof link.target === 'string' ? link.target : link.target.id;
    if (targetId === nodeId) {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      const caller = nodeMap.get(sourceId);
      if (caller) callers.push(caller);
    }
  }

  return callers;
}

/**
 * Get immediate callees of a node
 */
export function getCallees(graph: D3Graph, nodeId: string): D3Node[] {
  const callees: D3Node[] = [];
  const nodeMap = new Map(graph.nodes.map(node => [node.id, node]));

  for (const link of graph.links) {
    const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
    if (sourceId === nodeId) {
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
      const callee = nodeMap.get(targetId);
      if (callee) callees.push(callee);
    }
  }

  return callees;
}
