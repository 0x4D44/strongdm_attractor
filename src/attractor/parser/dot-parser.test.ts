import { describe, it, expect } from 'vitest';
import { DotParser, parseDot } from './dot-parser.js';

describe('DotParser', () => {
  it('parses simple linear pipeline: start -> A -> done', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        A [shape=box]
        done [shape=Msquare]
        start -> A -> done
      }
    `);
    expect(graph.name).toBe('G');
    expect(graph.nodes.size).toBe(3);
    expect(graph.edges.length).toBe(2);
    expect(graph.edges[0].from).toBe('start');
    expect(graph.edges[0].to).toBe('A');
    expect(graph.edges[1].from).toBe('A');
    expect(graph.edges[1].to).toBe('done');
  });

  it('parses pipeline with graph attributes', () => {
    const graph = parseDot(`
      digraph Pipeline {
        goal = "Build a web app"
        label = "Web App Pipeline"
        start [shape=Mdiamond]
        done [shape=Msquare]
        start -> done
      }
    `);
    expect(graph.attrs.goal).toBe('Build a web app');
    expect(graph.attrs.label).toBe('Web App Pipeline');
  });

  it('parses multi-line node attributes', () => {
    const graph = parseDot(`
      digraph G {
        mynode [
          shape=box,
          label="My Node",
          prompt="Do something",
          max_retries=3,
          goal_gate=true
        ]
      }
    `);
    const node = graph.nodes.get('mynode')!;
    expect(node.attrs.shape).toBe('box');
    expect(node.attrs.label).toBe('My Node');
    expect(node.attrs.prompt).toBe('Do something');
    expect(node.attrs.max_retries).toBe(3);
    expect(node.attrs.goal_gate).toBe(true);
  });

  it('chained edges produce individual edges: A -> B -> C = 2 edges', () => {
    const graph = parseDot(`
      digraph G {
        A -> B -> C
      }
    `);
    expect(graph.edges.length).toBe(2);
    expect(graph.edges[0]).toMatchObject({ from: 'A', to: 'B' });
    expect(graph.edges[1]).toMatchObject({ from: 'B', to: 'C' });
  });

  it('node defaults apply to subsequent nodes', () => {
    const graph = parseDot(`
      digraph G {
        node [shape=hexagon]
        A
        B
      }
    `);
    expect(graph.nodes.get('A')!.attrs.shape).toBe('hexagon');
    expect(graph.nodes.get('B')!.attrs.shape).toBe('hexagon');
  });

  it('edge defaults apply to subsequent edges', () => {
    const graph = parseDot(`
      digraph G {
        edge [weight=5]
        A -> B
        C -> D
      }
    `);
    expect(graph.edges[0].attrs.weight).toBe(5);
    expect(graph.edges[1].attrs.weight).toBe(5);
  });

  it('subgraph flattening: contents kept, wrapper removed', () => {
    const graph = parseDot(`
      digraph G {
        subgraph cluster_test {
          label = "Test Phase"
          A [shape=box]
          B [shape=box]
          A -> B
        }
      }
    `);
    // Nodes should be in the top-level graph
    expect(graph.nodes.has('A')).toBe(true);
    expect(graph.nodes.has('B')).toBe(true);
    expect(graph.edges.length).toBe(1);
    // Subgraph label should derive a class
    expect(graph.nodes.get('A')!.attrs.class).toContain('test-phase');
  });

  it('quoted and unquoted attribute values both work', () => {
    const graph = parseDot(`
      digraph G {
        A [shape="box", label=hello]
      }
    `);
    const node = graph.nodes.get('A')!;
    expect(node.attrs.shape).toBe('box');
    expect(node.attrs.label).toBe('hello');
  });

  it('errors on undirected graph (using --)', () => {
    expect(() => parseDot('digraph G { A -- B }')).toThrow(/Undirected edges/);
  });

  it('errors on multiple digraph declarations', () => {
    expect(() => parseDot(`
      digraph A { }
      digraph B { }
    `)).toThrow();
  });

  it('empty labels default to node ID', () => {
    const graph = parseDot(`
      digraph G {
        mynode [shape=box]
      }
    `);
    expect(graph.nodes.get('mynode')!.attrs.label).toBe('mynode');
  });

  it('parses graph attributes via graph [...] block', () => {
    const graph = parseDot(`
      digraph G {
        graph [goal="Build it", default_max_retry=3]
        start [shape=Mdiamond]
        done [shape=Msquare]
        start -> done
      }
    `);
    expect(graph.attrs.goal).toBe('Build it');
    expect(graph.attrs.default_max_retry).toBe(3);
  });

  it('parses edge attributes', () => {
    const graph = parseDot(`
      digraph G {
        A -> B [label="success", condition="outcome=success", weight=10]
      }
    `);
    const edge = graph.edges[0];
    expect(edge.attrs.label).toBe('success');
    expect(edge.attrs.condition).toBe('outcome=success');
    expect(edge.attrs.weight).toBe(10);
  });

  it('parses boolean node attributes', () => {
    const graph = parseDot(`
      digraph G {
        A [auto_status=true, allow_partial=false]
      }
    `);
    const node = graph.nodes.get('A')!;
    expect(node.attrs.auto_status).toBe(true);
    expect(node.attrs.allow_partial).toBe(false);
  });

  it('ensures nodes exist when referenced in edges', () => {
    const graph = parseDot(`
      digraph G {
        A -> B
      }
    `);
    expect(graph.nodes.has('A')).toBe(true);
    expect(graph.nodes.has('B')).toBe(true);
  });
});
