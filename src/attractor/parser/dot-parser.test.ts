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

  it('subgraph derives class from label', () => {
    const graph = parseDot(`
      digraph G {
        subgraph cluster_phase1 {
          graph [label="Build Phase"]
          A [shape=box]
        }
      }
    `);
    const node = graph.nodes.get('A')!;
    expect(node.attrs.class).toContain('build-phase');
  });

  it('nested subgraphs inherit parent classes', () => {
    const graph = parseDot(`
      digraph G {
        subgraph cluster_outer {
          label = "Outer Phase"
          subgraph cluster_inner {
            label = "Inner Phase"
            A [shape=box]
          }
        }
      }
    `);
    const node = graph.nodes.get('A')!;
    expect(node.attrs.class).toContain('outer-phase');
    expect(node.attrs.class).toContain('inner-phase');
  });

  it('parses quoted string with escaped content', () => {
    const graph = parseDot(`
      digraph G {
        A [label="Hello \\"World\\""]
      }
    `);
    const node = graph.nodes.get('A')!;
    expect(node.attrs.label).toContain('World');
  });

  it('parses semicolons as statement separators', () => {
    const graph = parseDot(`
      digraph G {
        A [shape=box]; B [shape=diamond]; A -> B;
      }
    `);
    expect(graph.nodes.has('A')).toBe(true);
    expect(graph.nodes.has('B')).toBe(true);
    expect(graph.edges.length).toBe(1);
  });

  it('parses duration values in attributes', () => {
    const graph = parseDot(`
      digraph G {
        A [timeout=30s]
      }
    `);
    const node = graph.nodes.get('A')!;
    expect(node.attrs.timeout).toBe('30s');
  });

  it('parses float values in attributes', () => {
    const graph = parseDot(`
      digraph G {
        A [reasoning_effort=0.8]
      }
    `);
    const node = graph.nodes.get('A')!;
    expect(node.attrs.reasoning_effort).toBe('0.8');
  });

  it('parses loop_restart edge attribute', () => {
    const graph = parseDot(`
      digraph G {
        A -> B [loop_restart=true]
      }
    `);
    expect(graph.edges[0].attrs.loop_restart).toBe(true);
  });

  it('parses thread_id on edges', () => {
    const graph = parseDot(`
      digraph G {
        A -> B [thread_id=main]
      }
    `);
    expect(graph.edges[0].attrs.thread_id).toBe('main');
  });

  it('parses fidelity on nodes and edges', () => {
    const graph = parseDot(`
      digraph G {
        A [fidelity=compact]
        A -> B [fidelity=truncate]
      }
    `);
    expect(graph.nodes.get('A')!.attrs.fidelity).toBe('compact');
    expect(graph.edges[0].attrs.fidelity).toBe('truncate');
  });

  it('parses llm_model and llm_provider node attributes', () => {
    const graph = parseDot(`
      digraph G {
        A [llm_model=gpt4, llm_provider=openai]
      }
    `);
    const node = graph.nodes.get('A')!;
    expect(node.attrs.llm_model).toBe('gpt4');
    expect(node.attrs.llm_provider).toBe('openai');
  });

  it('stores arbitrary unknown attributes on nodes', () => {
    const graph = parseDot(`
      digraph G {
        A [custom_key=custom_value]
      }
    `);
    const node = graph.nodes.get('A')!;
    expect((node.attrs as Record<string, unknown>)['custom_key']).toBe('custom_value');
  });

  it('stores arbitrary unknown attributes on edges', () => {
    const graph = parseDot(`
      digraph G {
        A -> B [custom_edge_attr=some_val]
      }
    `);
    expect((graph.edges[0].attrs as Record<string, unknown>)['custom_edge_attr']).toBe('some_val');
  });

  it('stores arbitrary unknown graph attributes', () => {
    const graph = parseDot(`
      digraph G {
        graph [custom_graph_key=custom_graph_val]
      }
    `);
    expect((graph.attrs as Record<string, unknown>)['custom_graph_key']).toBe('custom_graph_val');
  });

  it('handles semicolons as attribute separators inside brackets', () => {
    const graph = parseDot(`
      digraph G {
        A [shape=box; label="Test"]
      }
    `);
    const node = graph.nodes.get('A')!;
    expect(node.attrs.shape).toBe('box');
    expect(node.attrs.label).toBe('Test');
  });

  it('merges explicit attrs into existing node from edge reference', () => {
    const graph = parseDot(`
      digraph G {
        A -> B
        A [shape=box, prompt="Hello"]
      }
    `);
    const node = graph.nodes.get('A')!;
    expect(node.attrs.shape).toBe('box');
    expect(node.attrs.prompt).toBe('Hello');
  });

  it('qualified dot-separated attribute keys in node attrs', () => {
    const graph = parseDot(`
      digraph G {
        A [human.default_choice=yes]
      }
    `);
    const node = graph.nodes.get('A')!;
    expect((node.attrs as Record<string, unknown>)['human.default_choice']).toBe('yes');
  });

  it('parses model_stylesheet graph attribute', () => {
    const graph = parseDot(`
      digraph G {
        model_stylesheet = ".fast { model: gpt-4o-mini; }"
        A [shape=box]
      }
    `);
    expect(graph.attrs.model_stylesheet).toBe('.fast { model: gpt-4o-mini; }');
  });

  it('parses default_fidelity graph attribute', () => {
    const graph = parseDot(`
      digraph G {
        default_fidelity = compact
        A [shape=box]
      }
    `);
    expect(graph.attrs.default_fidelity).toBe('compact');
  });

  it('allows DOT keyword as graph name', () => {
    // 'node', 'edge', 'graph' are keywords but should work as graph names
    const graph = parseDot(`
      digraph node {
        A [shape=box]
      }
    `);
    expect(graph.name).toBe('node');
  });

  it('allows quoted string as graph name', () => {
    const graph = parseDot(`
      digraph "My Pipeline" {
        A [shape=box]
      }
    `);
    expect(graph.name).toBe('My Pipeline');
  });

  it('allows graph/node/edge keywords as node IDs in edge chains', () => {
    // The consumeIdentifier() method allows GRAPH/NODE/EDGE as identifiers
    // When not followed by '[', they parse as node IDs
    const graph = parseDot(`
      digraph G {
        A -> graph
        A -> edge
      }
    `);
    expect(graph.nodes.has('graph')).toBe(true);
    expect(graph.nodes.has('edge')).toBe(true);
  });

  it('throws on malformed input', () => {
    expect(() => parseDot('digraph G +')).toThrow();
  });

  it('subgraph without name', () => {
    const graph = parseDot(`
      digraph G {
        subgraph {
          A [shape=box]
        }
      }
    `);
    expect(graph.nodes.has('A')).toBe(true);
  });

  it('subgraph with graph [...] label attribute', () => {
    const graph = parseDot(`
      digraph G {
        subgraph cluster_x {
          graph [label="X Phase"]
          A [shape=box]
        }
      }
    `);
    expect(graph.nodes.get('A')!.attrs.class).toContain('x-phase');
  });

  it('throws on unexpected token in statement context', () => {
    // A bare '{' at statement level is not a valid statement start
    expect(() => parseDot('digraph G { [ }')).toThrow(/Unexpected token/);
  });

  it('throws on unexpected token in value context', () => {
    // '=' is not a valid value token
    expect(() => parseDot('digraph G { A [shape=[]] }')).toThrow();
  });

  it('allows subgraph keyword as node ID', () => {
    const graph = parseDot(`
      digraph G {
        A -> subgraph
      }
    `);
    expect(graph.nodes.has('subgraph')).toBe(true);
  });

  it('throws on unexpected token in expectIdentifierOrString', () => {
    // A number token where an identifier/string is expected
    expect(() => parseDot('digraph 123 { }')).toThrow();
  });

  it('consumeIdentifier allows SUBGRAPH keyword as identifier (line 535/538)', () => {
    // The SUBGRAPH token type is accepted by consumeIdentifier
    // when it appears where a node ID is expected (not followed by '{')
    const graph = parseDot(`
      digraph G {
        A -> subgraph [label="edge_to_subgraph_id"]
      }
    `);
    expect(graph.nodes.has('subgraph')).toBe(true);
    expect(graph.edges[0].to).toBe('subgraph');
  });

  it('current() returns EOF token when pos exceeds token array (line 574)', () => {
    // Triggers the fallback in current() when tokens[pos] is undefined
    // A minimal valid graph that exhausts tokens
    const graph = parseDot('digraph G { }');
    expect(graph.name).toBe('G');
  });

  it('expect() throws on token type mismatch (line 558-559)', () => {
    // Triggers the error path in expect()
    expect(() => parseDot('digraph G [')).toThrow(/Expected/);
  });

  it('parseAttrBlock with semicolon-separated attributes (line 320)', () => {
    const graph = parseDot(`
      digraph G {
        A [shape=box; label="test"; prompt="hello"]
      }
    `);
    const node = graph.nodes.get('A')!;
    expect(node.attrs.shape).toBe('box');
    expect(node.attrs.label).toBe('test');
    expect(node.attrs.prompt).toBe('hello');
  });

  it('setEdgeAttr default case stores arbitrary edge attribute (line 487-489)', () => {
    const graph = parseDot(`
      digraph G {
        A -> B [custom_attr=custom_val]
      }
    `);
    expect((graph.edges[0].attrs as Record<string, unknown>)['custom_attr']).toBe('custom_val');
  });

  it('setNodeAttr with thread_id attribute (line 464)', () => {
    const graph = parseDot(`
      digraph G {
        A [thread_id=main_thread]
      }
    `);
    expect(graph.nodes.get('A')!.attrs.thread_id).toBe('main_thread');
  });

  it('setEdgeAttr with weight=0 (line 483)', () => {
    const graph = parseDot(`
      digraph G {
        A -> B [weight=0]
      }
    `);
    expect(graph.edges[0].attrs.weight).toBe(0);
  });

  it('node with class attribute from subgraph overrides existing class (line 424)', () => {
    const graph = parseDot(`
      digraph G {
        subgraph cluster_a {
          label = "Phase A"
          X [class=custom]
        }
      }
    `);
    const node = graph.nodes.get('X')!;
    // Should have both custom and derived class
    expect(node.attrs.class).toContain('custom');
    expect(node.attrs.class).toContain('phase-a');
  });
});
