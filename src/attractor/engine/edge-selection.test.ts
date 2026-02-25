import { describe, it, expect } from 'vitest';
import { selectEdge, normalizeLabel } from './edge-selection.js';
import { Context } from './context.js';
import type { Graph, Edge, Outcome } from '../types.js';
import {
  StageStatus,
  makeOutcome,
  DEFAULT_NODE_ATTRIBUTES,
  DEFAULT_EDGE_ATTRIBUTES,
  DEFAULT_GRAPH_ATTRIBUTES,
} from '../types.js';

function makeGraph(edges: Edge[], nodes?: Map<string, { id: string; attrs: typeof DEFAULT_NODE_ATTRIBUTES }>): Graph {
  const nodeMap = nodes ?? new Map();
  // Ensure all edge endpoints exist
  for (const e of edges) {
    if (!nodeMap.has(e.from)) {
      nodeMap.set(e.from, { id: e.from, attrs: { ...DEFAULT_NODE_ATTRIBUTES } });
    }
    if (!nodeMap.has(e.to)) {
      nodeMap.set(e.to, { id: e.to, attrs: { ...DEFAULT_NODE_ATTRIBUTES } });
    }
  }
  return {
    name: 'test',
    attrs: { ...DEFAULT_GRAPH_ATTRIBUTES },
    nodes: nodeMap,
    edges,
  };
}

function edge(from: string, to: string, attrs: Partial<typeof DEFAULT_EDGE_ATTRIBUTES> = {}): Edge {
  return { from, to, attrs: { ...DEFAULT_EDGE_ATTRIBUTES, ...attrs } };
}

describe('selectEdge', () => {
  it('Step 1: condition match wins over everything', () => {
    const edges = [
      edge('A', 'B', { label: 'fail', condition: 'outcome=fail' }),
      edge('A', 'C', { label: 'success', condition: 'outcome=success' }),
      edge('A', 'D', { label: 'default', weight: 100 }),
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({ status: StageStatus.SUCCESS });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected!.to).toBe('C');
  });

  it('Step 2: preferred label match when no condition matches', () => {
    const edges = [
      edge('A', 'B', { label: 'option1' }),
      edge('A', 'C', { label: 'option2' }),
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({ status: StageStatus.SUCCESS, preferred_label: 'option2' });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected!.to).toBe('C');
  });

  it('Step 3: suggested IDs when no label match', () => {
    const edges = [
      edge('A', 'B', {}),
      edge('A', 'C', {}),
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({
      status: StageStatus.SUCCESS,
      suggested_next_ids: ['C'],
    });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected!.to).toBe('C');
  });

  it('Step 4: weight breaks ties for unconditional edges (higher wins)', () => {
    const edges = [
      edge('A', 'B', { weight: 1 }),
      edge('A', 'C', { weight: 10 }),
      edge('A', 'D', { weight: 5 }),
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({ status: StageStatus.SUCCESS });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected!.to).toBe('C');
  });

  it('Step 5: lexical tiebreak as final fallback', () => {
    const edges = [
      edge('A', 'C', { weight: 0 }),
      edge('A', 'B', { weight: 0 }),
      edge('A', 'D', { weight: 0 }),
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({ status: StageStatus.SUCCESS });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected!.to).toBe('B'); // lexically first
  });

  it('condition match + weight: highest weight among condition-matched edges wins', () => {
    const edges = [
      edge('A', 'B', { condition: 'outcome=success', weight: 5 }),
      edge('A', 'C', { condition: 'outcome=success', weight: 10 }),
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({ status: StageStatus.SUCCESS });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected!.to).toBe('C');
  });

  it('no outgoing edges: returns undefined', () => {
    const graph = makeGraph([]);
    const outcome = makeOutcome({ status: StageStatus.SUCCESS });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected).toBeUndefined();
  });
});

describe('normalizeLabel', () => {
  it('strips [K] Label accelerator', () => {
    expect(normalizeLabel('[K] My Label')).toBe('my label');
  });

  it('strips K) Label accelerator', () => {
    expect(normalizeLabel('K) My Label')).toBe('my label');
  });

  it('strips K - Label accelerator', () => {
    expect(normalizeLabel('K - My Label')).toBe('my label');
  });

  it('lowercases and trims', () => {
    expect(normalizeLabel('  Hello World  ')).toBe('hello world');
  });

  it('handles plain label without accelerator', () => {
    expect(normalizeLabel('plain label')).toBe('plain label');
  });

  it('handles empty string', () => {
    expect(normalizeLabel('')).toBe('');
  });

  it('normalizes case-sensitive labels', () => {
    expect(normalizeLabel('HELLO')).toBe('hello');
    expect(normalizeLabel('Hello')).toBe('hello');
  });

  it('K) with multi-char prefix', () => {
    expect(normalizeLabel('a) Some Label')).toBe('some label');
    expect(normalizeLabel('9) Other')).toBe('other');
  });

  it('K - with various chars', () => {
    expect(normalizeLabel('a - Test')).toBe('test');
    expect(normalizeLabel('Z - Zeta')).toBe('zeta');
  });

  it('[K] with complex bracket content', () => {
    expect(normalizeLabel('[abc] content')).toBe('content');
  });
});

describe('selectEdge - additional coverage', () => {
  it('fallback to all edges when only conditional edges exist and none match', () => {
    const edges = [
      edge('A', 'B', { condition: 'outcome=fail', weight: 5 }),
      edge('A', 'C', { condition: 'outcome=fail', weight: 10 }),
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({ status: StageStatus.SUCCESS });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    // Falls through to bestByWeightThenLexical(edges) since no unconditional edges
    expect(selected!.to).toBe('C'); // highest weight
  });

  it('preferred label with accelerator prefix matches normalized edge label', () => {
    const edges = [
      edge('A', 'B', { label: '[K] Yes' }),
      edge('A', 'C', { label: 'No' }),
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({
      status: StageStatus.SUCCESS,
      preferred_label: 'yes',
    });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected!.to).toBe('B');
  });

  it('suggested_next_ids respects order', () => {
    const edges = [
      edge('A', 'B', {}),
      edge('A', 'C', {}),
      edge('A', 'D', {}),
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({
      status: StageStatus.SUCCESS,
      suggested_next_ids: ['D', 'B'],
    });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected!.to).toBe('D'); // first match in suggested IDs wins
  });

  it('suggested_next_ids skipped when empty array', () => {
    const edges = [
      edge('A', 'B', { weight: 1 }),
      edge('A', 'C', { weight: 5 }),
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({
      status: StageStatus.SUCCESS,
      suggested_next_ids: [],
    });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected!.to).toBe('C'); // falls through to weight
  });

  it('unconditional edges preferred over conditional in fallback (step 4)', () => {
    const edges = [
      edge('A', 'B', { condition: 'outcome=retry', weight: 100 }),
      edge('A', 'C', { weight: 1 }),
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({ status: StageStatus.SUCCESS });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    // Condition doesn't match, so step 1 skipped
    // No preferred label or suggested IDs
    // Step 4: only unconditional edges (C)
    expect(selected!.to).toBe('C');
  });

  it('weight tiebreak: equal weight uses lexical order', () => {
    const edges = [
      edge('A', 'Z', { weight: 5 }),
      edge('A', 'M', { weight: 5 }),
      edge('A', 'A_target', { weight: 5 }),
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({ status: StageStatus.SUCCESS });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected!.to).toBe('A_target'); // lexically first
  });

  it('edges from different nodes are filtered', () => {
    const edges = [
      edge('A', 'B', { weight: 1 }),
      edge('X', 'C', { weight: 100 }), // different source node
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({ status: StageStatus.SUCCESS });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected!.to).toBe('B');
  });

  it('no edges from the given node returns undefined', () => {
    const edges = [
      edge('X', 'Y', {}),
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({ status: StageStatus.SUCCESS });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected).toBeUndefined();
  });

  it('empty preferred_label skips label matching step', () => {
    const edges = [
      edge('A', 'B', { label: 'opt1', weight: 1 }),
      edge('A', 'C', { label: 'opt2', weight: 10 }),
    ];
    const graph = makeGraph(edges);
    // preferred_label is empty string - should skip step 2 and go to step 4 (weight)
    const outcome = makeOutcome({
      status: StageStatus.SUCCESS,
      preferred_label: '',
    });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected!.to).toBe('C'); // by weight, not by label
  });

  it('empty suggested_next_ids skips to weight fallback', () => {
    const edges = [
      edge('A', 'B', { weight: 1 }),
      edge('A', 'C', { weight: 10 }),
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({
      status: StageStatus.SUCCESS,
      suggested_next_ids: [],
      preferred_label: '',
    });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected!.to).toBe('C'); // weight, not suggested ID
  });

  it('single edge returns that edge regardless of conditions', () => {
    const edges = [
      edge('A', 'B', {}),
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({ status: StageStatus.SUCCESS });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected!.to).toBe('B');
  });

  it('suggested_next_ids with non-matching ID falls through to weight', () => {
    const edges = [
      edge('A', 'B', { weight: 1 }),
      edge('A', 'C', { weight: 10 }),
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({
      status: StageStatus.SUCCESS,
      suggested_next_ids: ['Z'], // Z doesn't exist
    });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected!.to).toBe('C'); // falls through to weight
  });

  it('suggested_next_ids picks first matching edge', () => {
    const edges = [
      edge('A', 'B', {}),
      edge('A', 'C', {}),
      edge('A', 'D', {}),
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({
      status: StageStatus.SUCCESS,
      suggested_next_ids: ['C', 'B'],
    });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected!.to).toBe('C');
  });

  it('weight tiebreaker with three edges of same weight', () => {
    const edges = [
      edge('A', 'Y', { weight: 3 }),
      edge('A', 'X', { weight: 3 }),
      edge('A', 'Z', { weight: 3 }),
    ];
    const graph = makeGraph(edges);
    const outcome = makeOutcome({ status: StageStatus.SUCCESS });
    const ctx = new Context();

    const selected = selectEdge('A', outcome, ctx, graph);
    expect(selected!.to).toBe('X'); // lexically first
  });
});

describe('normalizeLabel - regex and trim mutant killers', () => {
  it('trims trailing whitespace after initial toLowerCase', () => {
    // Tests that .trim() on line 18 matters
    expect(normalizeLabel('hello  ')).toBe('hello');
    expect(normalizeLabel('  hello')).toBe('hello');
  });

  it('final trim() removes whitespace after stripping', () => {
    // After stripping accelerator prefix, any leftover whitespace should be trimmed
    // [K]  has trailing space that toLowerCase().trim() handles but
    // the final return normalized.trim() handles edge cases
    expect(normalizeLabel('[K]  spaced ')).toBe('spaced');
  });

  it('[K] bracket only strips at start of label', () => {
    // ^ anchor in regex means only leading [K] is stripped
    // Without ^ anchor, inner brackets would also be stripped
    expect(normalizeLabel('text [K] more')).toBe('text [k] more');
  });

  it('K) only strips at start of label', () => {
    // ^ anchor ensures only leading K) is stripped
    expect(normalizeLabel('text a) more')).toBe('text a) more');
  });

  it('K - only strips at start of label', () => {
    // ^ anchor ensures only leading K - is stripped
    expect(normalizeLabel('text a - more')).toBe('text a - more');
  });

  it('[K] with no space after bracket', () => {
    // \s* means 0 or more spaces after ]
    expect(normalizeLabel('[K]nospace')).toBe('nospace');
  });

  it('K) with no space after paren', () => {
    // \s* means 0 or more spaces after )
    expect(normalizeLabel('a)nospace')).toBe('nospace');
  });

  it('K - with no space around dash', () => {
    // \s*-\s* means 0 or more spaces around -
    expect(normalizeLabel('a-nospace')).toBe('nospace');
  });

  it('[K] with multiple spaces after bracket', () => {
    expect(normalizeLabel('[X]   lots of space')).toBe('lots of space');
  });

  it('K) with multiple spaces', () => {
    expect(normalizeLabel('b)   lots of space')).toBe('lots of space');
  });

  it('K - with multiple spaces', () => {
    expect(normalizeLabel('c -   lots of space')).toBe('lots of space');
    expect(normalizeLabel('c   - lots of space')).toBe('lots of space');
  });
});
