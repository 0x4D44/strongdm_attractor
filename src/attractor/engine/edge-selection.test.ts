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
});
