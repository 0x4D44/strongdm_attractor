import { describe, it, expect } from 'vitest';
import { VariableExpansionTransform, applyTransforms } from './transforms.js';
import type { Graph, Transform } from './types.js';
import { DEFAULT_NODE_ATTRIBUTES, DEFAULT_GRAPH_ATTRIBUTES, DEFAULT_EDGE_ATTRIBUTES } from './types.js';

function makeGraph(goal: string, nodes: Array<{ id: string; prompt?: string }> = []): Graph {
  const nodeMap = new Map<string, { id: string; attrs: typeof DEFAULT_NODE_ATTRIBUTES }>();
  for (const n of nodes) {
    nodeMap.set(n.id, {
      id: n.id,
      attrs: { ...DEFAULT_NODE_ATTRIBUTES, prompt: n.prompt ?? '' },
    });
  }
  return {
    name: 'test',
    attrs: { ...DEFAULT_GRAPH_ATTRIBUTES, goal },
    nodes: nodeMap,
    edges: [],
  };
}

describe('VariableExpansionTransform', () => {
  it('replaces $goal in prompts', () => {
    const graph = makeGraph('Build a web app', [
      { id: 'A', prompt: 'Complete the task: $goal' },
      { id: 'B', prompt: 'No variable here' },
    ]);

    const transform = new VariableExpansionTransform();
    const result = transform.apply(graph);

    expect(result.nodes.get('A')!.attrs.prompt).toBe('Complete the task: Build a web app');
    expect(result.nodes.get('B')!.attrs.prompt).toBe('No variable here');
  });

  it('replaces multiple occurrences of $goal', () => {
    const graph = makeGraph('test', [
      { id: 'A', prompt: '$goal and also $goal' },
    ]);

    const transform = new VariableExpansionTransform();
    const result = transform.apply(graph);

    expect(result.nodes.get('A')!.attrs.prompt).toBe('test and also test');
  });

  it('handles empty goal', () => {
    const graph = makeGraph('', [
      { id: 'A', prompt: 'Goal: $goal' },
    ]);

    const transform = new VariableExpansionTransform();
    const result = transform.apply(graph);

    expect(result.nodes.get('A')!.attrs.prompt).toBe('Goal: ');
  });
});

describe('applyTransforms', () => {
  it('runs transforms in order', () => {
    const graph = makeGraph('my goal', [
      { id: 'A', prompt: '$goal' },
    ]);

    const result = applyTransforms(graph);
    // Built-in transforms run (stylesheet + variable expansion)
    expect(result.nodes.get('A')!.attrs.prompt).toBe('my goal');
  });

  it('custom transform modifies graph', () => {
    const graph = makeGraph('test', [
      { id: 'A', prompt: 'original' },
    ]);

    const customTransform: Transform = {
      apply(g: Graph): Graph {
        for (const [_id, node] of g.nodes) {
          if (node.attrs.prompt === 'original') {
            node.attrs.prompt = 'modified';
          }
        }
        return g;
      },
    };

    const result = applyTransforms(graph, [customTransform]);
    expect(result.nodes.get('A')!.attrs.prompt).toBe('modified');
  });

  it('custom transforms run after built-in transforms', () => {
    const graph = makeGraph('my goal', [
      { id: 'A', prompt: '$goal' },
    ]);

    const executionOrder: string[] = [];
    const customTransform: Transform = {
      apply(g: Graph): Graph {
        // At this point, $goal should already be expanded by the built-in transform
        executionOrder.push(g.nodes.get('A')!.attrs.prompt);
        return g;
      },
    };

    applyTransforms(graph, [customTransform]);
    expect(executionOrder[0]).toBe('my goal');
  });
});
