import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { editorSelectionIntent, filtersHiding } from './editor-selection';
import { parseAndNormalizeGraph } from './graph-loader';
import { defaultFilters } from './url-state';
import { detectProjectLanguage, type FilterOptions } from './types';

// Described in graph-loader.test.ts
const graph = parseAndNormalizeGraph(
  JSON.parse(readFileSync(resolve(__dirname, 'test-data/probe-lean-extract-cut.json'), 'utf8')),
);
const language = detectProjectLanguage(graph);

const hiding = (nodeId: string, over: Partial<FilterOptions> = {}) => {
  const selection = { nodeId, direction: 'both' as const, depth: 3 };
  const filters = { ...defaultFilters(), ...over, intent: editorSelectionIntent(selection, nodeId), maxDepth: 3 };
  return filtersHiding(graph, filters, language, nodeId);
};

describe('filtersHiding', () => {
  it('names the kind filter that hides a structure', () => {
    expect(hiding('probe:oppUniKemCKA.StateB', { showTypes: false })).toEqual(['showTypes']);
  });

  it('names the projection filter for a field', () => {
    expect(hiding('probe:oppUniKemCKA.StateB.t', { showProjections: false })).toEqual(['showProjections']);
  });

  it('names pattern filters', () => {
    expect(hiding('probe:oppUniKemCKA.initA', { excludeNamePatterns: 'init*' })).toEqual(['excludeNamePatterns']);
  });

  it('is empty for a node the filters draw', () => {
    expect(hiding('probe:oppUniKemCKA.initA')).toEqual([]);
  });

  it('names every filter of a set that together hides a node', () => {
    // Neither relaxed alone draws the structure; both together do
    expect(hiding('probe:oppUniKemCKA.StateB', { showTypes: false, excludeNamePatterns: 'State*' }))
      .toEqual(['showTypes', 'excludeNamePatterns']);
  });

  it('leaves out filters that do not block when the set is restored one by one', () => {
    expect(hiding('probe:oppUniKemCKA.StateB', {
      showTypes: false, showProjections: false, excludeNamePatterns: 'State*',
    })).toEqual(['showTypes', 'excludeNamePatterns']);
  });
});

describe('editorSelectionIntent', () => {
  it('maps the direction onto the exact intent', () => {
    const dir = (direction: 'both' | 'callees' | 'callers' | 'none') =>
      editorSelectionIntent({ nodeId: 'probe:x', direction, depth: 1 }, 'x');
    expect(dir('both')).toMatchObject({ kind: 'ids', ids: ['probe:x'], dir: 'both' });
    expect(dir('callees')).toMatchObject({ dir: 'callees' });
    expect(dir('callers')).toMatchObject({ dir: 'callers' });
    expect(dir('none')).toMatchObject({ dir: 'none' });
  });
});
