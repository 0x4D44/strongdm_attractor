import { describe, it, expect } from 'vitest';
import { validate, validateOrRaise } from './validator.js';
import { parseDot } from './dot-parser.js';
import type { Graph, LintRule } from '../types.js';
import { LintSeverity, DEFAULT_NODE_ATTRIBUTES, DEFAULT_EDGE_ATTRIBUTES, DEFAULT_GRAPH_ATTRIBUTES } from '../types.js';

function makeValidGraph() {
  return parseDot(`
    digraph G {
      start [shape=Mdiamond]
      work [shape=box, prompt="Do something"]
      done [shape=Msquare]
      start -> work -> done
    }
  `);
}

describe('validate', () => {
  it('valid pipeline: no errors', () => {
    const graph = makeValidGraph();
    const results = validate(graph);
    const errors = results.filter(r => r.severity === LintSeverity.ERROR);
    expect(errors).toHaveLength(0);
  });

  it('missing start node -> error', () => {
    const graph = parseDot(`
      digraph G {
        work [shape=box]
        done [shape=Msquare]
        work -> done
      }
    `);
    const results = validate(graph);
    const errors = results.filter(r => r.rule === 'start_node' && r.severity === LintSeverity.ERROR);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('missing exit node -> error', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        work [shape=box]
        start -> work
      }
    `);
    const results = validate(graph);
    const errors = results.filter(r => r.rule === 'terminal_node' && r.severity === LintSeverity.ERROR);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('multiple start nodes -> error', () => {
    const graph = parseDot(`
      digraph G {
        s1 [shape=Mdiamond]
        s2 [shape=Mdiamond]
        done [shape=Msquare]
        s1 -> done
        s2 -> done
      }
    `);
    const results = validate(graph);
    const errors = results.filter(r => r.rule === 'start_node' && r.severity === LintSeverity.ERROR);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('multiple exit nodes -> error', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        e1 [shape=Msquare]
        e2 [shape=Msquare]
        start -> e1
        start -> e2
      }
    `);
    const results = validate(graph);
    const errors = results.filter(r => r.rule === 'terminal_node' && r.severity === LintSeverity.ERROR);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('start with incoming edges -> error', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        work [shape=box]
        done [shape=Msquare]
        start -> work -> done
        work -> start
      }
    `);
    const results = validate(graph);
    const errors = results.filter(r => r.rule === 'start_no_incoming');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('exit with outgoing edges -> error', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        done [shape=Msquare]
        work [shape=box]
        start -> done -> work
      }
    `);
    const results = validate(graph);
    const errors = results.filter(r => r.rule === 'exit_no_outgoing');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('orphan node (unreachable from start) -> error', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        done [shape=Msquare]
        orphan [shape=box]
        start -> done
      }
    `);
    const results = validate(graph);
    const reachability = results.filter(r => r.rule === 'reachability');
    expect(reachability.length).toBeGreaterThan(0);
    expect(reachability[0].message).toContain('orphan');
  });

  it('all edges reference valid node IDs', () => {
    // The parser auto-creates nodes for edge references, so this should pass
    const graph = makeValidGraph();
    const results = validate(graph);
    const edgeErrors = results.filter(r => r.rule === 'edge_target_exists');
    expect(edgeErrors).toHaveLength(0);
  });

  it('codergen node without prompt -> warning', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        work [shape=box]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    const results = validate(graph);
    const promptWarnings = results.filter(r => r.rule === 'prompt_on_llm_nodes');
    expect(promptWarnings.length).toBeGreaterThan(0);
  });
});

describe('validateOrRaise', () => {
  it('does not throw on valid graph', () => {
    const graph = makeValidGraph();
    expect(() => validateOrRaise(graph)).not.toThrow();
  });

  it('throws on error-severity issues', () => {
    const graph = parseDot(`
      digraph G {
        work [shape=box]
      }
    `);
    expect(() => validateOrRaise(graph)).toThrow(/Validation failed/);
  });

  it('returns warnings without throwing', () => {
    const graph = makeValidGraph();
    const results = validateOrRaise(graph);
    // Should return results (which may include warnings) without throwing
    expect(Array.isArray(results)).toBe(true);
  });
});

describe('conditionSyntaxRule', () => {
  it('reports error for condition with multiple = signs (a=b=c)', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        done [shape=Msquare]
        start -> done [condition="a=b=c"]
      }
    `);
    const results = validate(graph);
    const condErrors = results.filter(r => r.rule === 'condition_syntax' && r.severity === LintSeverity.ERROR);
    expect(condErrors.length).toBeGreaterThan(0);
    expect(condErrors[0].message).toContain('Invalid condition');
  });

  it('reports error for condition with missing key (=value)', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        done [shape=Msquare]
        start -> done [condition="=value"]
      }
    `);
    const results = validate(graph);
    const condErrors = results.filter(r => r.rule === 'condition_syntax' && r.severity === LintSeverity.ERROR);
    expect(condErrors.length).toBeGreaterThan(0);
    expect(condErrors[0].message).toContain('Missing key');
  });

  it('reports error for != with missing key (!=value)', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        done [shape=Msquare]
        start -> done [condition="!=value"]
      }
    `);
    const results = validate(graph);
    const condErrors = results.filter(r => r.rule === 'condition_syntax' && r.severity === LintSeverity.ERROR);
    expect(condErrors.length).toBeGreaterThan(0);
  });

  it('reports error for multiple != operators (a!=b!=c)', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        done [shape=Msquare]
        start -> done [condition="a!=b!=c"]
      }
    `);
    const results = validate(graph);
    const condErrors = results.filter(r => r.rule === 'condition_syntax' && r.severity === LintSeverity.ERROR);
    expect(condErrors.length).toBeGreaterThan(0);
  });

  it('accepts valid condition syntax', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        done [shape=Msquare]
        start -> done [condition="outcome=success && context.x!=fail"]
      }
    `);
    const results = validate(graph);
    const condErrors = results.filter(r => r.rule === 'condition_syntax' && r.severity === LintSeverity.ERROR);
    expect(condErrors).toHaveLength(0);
  });

  it('accepts bare key as truthy check', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        done [shape=Msquare]
        start -> done [condition="some_flag"]
      }
    `);
    const results = validate(graph);
    const condErrors = results.filter(r => r.rule === 'condition_syntax' && r.severity === LintSeverity.ERROR);
    expect(condErrors).toHaveLength(0);
  });

  it('empty clause after && is skipped (not an error)', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        done [shape=Msquare]
        start -> done [condition="outcome=success && "]
      }
    `);
    const results = validate(graph);
    const condErrors = results.filter(r => r.rule === 'condition_syntax' && r.severity === LintSeverity.ERROR);
    expect(condErrors).toHaveLength(0);
  });
});

describe('validate with extraRules', () => {
  it('applies custom extra rules in addition to built-in rules', () => {
    const graph = makeValidGraph();
    const customRule = {
      name: 'custom_test_rule',
      apply(_graph: ReturnType<typeof parseDot>) {
        return [{
          rule: 'custom_test_rule',
          severity: LintSeverity.WARNING,
          message: 'Custom rule fired',
        }];
      },
    };
    const results = validate(graph, [customRule]);
    const customResults = results.filter(r => r.rule === 'custom_test_rule');
    expect(customResults).toHaveLength(1);
    expect(customResults[0].message).toBe('Custom rule fired');
  });

  it('validateOrRaise passes extraRules and does not throw on warnings-only', () => {
    const graph = makeValidGraph();
    const customRule = {
      name: 'warn_rule',
      apply() {
        return [{
          rule: 'warn_rule',
          severity: LintSeverity.WARNING,
          message: 'Just a warning',
        }];
      },
    };
    const results = validateOrRaise(graph, [customRule]);
    const warns = results.filter(r => r.rule === 'warn_rule');
    expect(warns).toHaveLength(1);
  });
});

describe('stylesheetSyntaxRule', () => {
  it('reports error for malformed model_stylesheet', () => {
    const graph = parseDot(`
      digraph G {
        model_stylesheet = "this is {{ not valid css"
        start [shape=Mdiamond]
        done [shape=Msquare]
        start -> done
      }
    `);
    const results = validate(graph);
    const ssErrors = results.filter(r => r.rule === 'stylesheet_syntax' && r.severity === LintSeverity.ERROR);
    expect(ssErrors.length).toBeGreaterThan(0);
  });
});

describe('typeKnownRule', () => {
  it('warns on unknown handler type', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        work [type=unknown_handler]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    const results = validate(graph);
    const typeWarns = results.filter(r => r.rule === 'type_known');
    expect(typeWarns.length).toBeGreaterThan(0);
    expect(typeWarns[0].message).toContain('unknown_handler');
  });
});

describe('fidelityValidRule', () => {
  it('warns on invalid fidelity on node', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        work [shape=box, prompt="x", fidelity=invalid_mode]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    const results = validate(graph);
    const fidWarns = results.filter(r => r.rule === 'fidelity_valid');
    expect(fidWarns.length).toBeGreaterThan(0);
  });

  it('warns on invalid fidelity on edge', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        done [shape=Msquare]
        start -> done [fidelity=bad_value]
      }
    `);
    const results = validate(graph);
    const fidWarns = results.filter(r => r.rule === 'fidelity_valid');
    expect(fidWarns.length).toBeGreaterThan(0);
  });
});

describe('retryTargetExistsRule', () => {
  it('warns when node retry_target references non-existent node', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        work [shape=box, prompt="x", retry_target=nonexistent]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    const results = validate(graph);
    const warns = results.filter(r => r.rule === 'retry_target_exists');
    expect(warns.length).toBeGreaterThan(0);
  });

  it('warns when node fallback_retry_target references non-existent node', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        work [shape=box, prompt="x", fallback_retry_target=nonexistent]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    const results = validate(graph);
    const warns = results.filter(r => r.rule === 'retry_target_exists');
    expect(warns.length).toBeGreaterThan(0);
  });

  it('warns when graph retry_target references non-existent node', () => {
    const graph = parseDot(`
      digraph G {
        retry_target = nonexistent
        start [shape=Mdiamond]
        done [shape=Msquare]
        start -> done
      }
    `);
    const results = validate(graph);
    const warns = results.filter(r => r.rule === 'retry_target_exists');
    expect(warns.length).toBeGreaterThan(0);
  });

  it('warns when graph fallback_retry_target references non-existent node', () => {
    const graph = parseDot(`
      digraph G {
        fallback_retry_target = nonexistent
        start [shape=Mdiamond]
        done [shape=Msquare]
        start -> done
      }
    `);
    const results = validate(graph);
    const warns = results.filter(r => r.rule === 'retry_target_exists');
    expect(warns.length).toBeGreaterThan(0);
  });
});

describe('edgeTargetExistsRule', () => {
  it('reports error when edge references unknown source node', () => {
    // Manually construct graph since parser auto-creates nodes
    const graph: Graph = {
      name: 'test',
      attrs: { ...DEFAULT_GRAPH_ATTRIBUTES },
      nodes: new Map([
        ['start', { id: 'start', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'Mdiamond' } }],
        ['done', { id: 'done', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'Msquare' } }],
      ]),
      edges: [
        { from: 'ghost', to: 'done', attrs: { ...DEFAULT_EDGE_ATTRIBUTES } },
        { from: 'start', to: 'done', attrs: { ...DEFAULT_EDGE_ATTRIBUTES } },
      ],
    };
    const results = validate(graph);
    const edgeErrors = results.filter(r => r.rule === 'edge_target_exists');
    expect(edgeErrors.length).toBeGreaterThan(0);
    expect(edgeErrors[0].message).toContain('ghost');
  });

  it('reports error when edge references unknown target node', () => {
    const graph: Graph = {
      name: 'test',
      attrs: { ...DEFAULT_GRAPH_ATTRIBUTES },
      nodes: new Map([
        ['start', { id: 'start', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'Mdiamond' } }],
        ['done', { id: 'done', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'Msquare' } }],
      ]),
      edges: [
        { from: 'start', to: 'phantom', attrs: { ...DEFAULT_EDGE_ATTRIBUTES } },
        { from: 'start', to: 'done', attrs: { ...DEFAULT_EDGE_ATTRIBUTES } },
      ],
    };
    const results = validate(graph);
    const edgeErrors = results.filter(r => r.rule === 'edge_target_exists');
    expect(edgeErrors.length).toBeGreaterThan(0);
    expect(edgeErrors[0].message).toContain('phantom');
  });
});

describe('findStartNodeId / findExitNodeId fallbacks', () => {
  it('no Mdiamond: findStartNodeId finds "start" by ID', () => {
    const graph: Graph = {
      name: 'test',
      attrs: { ...DEFAULT_GRAPH_ATTRIBUTES },
      nodes: new Map([
        ['start', { id: 'start', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'box' } }],
        ['done', { id: 'done', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'Msquare' } }],
      ]),
      edges: [{ from: 'start', to: 'done', attrs: { ...DEFAULT_EDGE_ATTRIBUTES } }],
    };
    const results = validate(graph);
    // Should NOT have start_node error since 'start' ID exists
    const startErrors = results.filter(r => r.rule === 'start_node' && r.severity === LintSeverity.ERROR);
    expect(startErrors).toHaveLength(0);
  });

  it('no Mdiamond: findStartNodeId finds "Start" by ID', () => {
    const graph: Graph = {
      name: 'test',
      attrs: { ...DEFAULT_GRAPH_ATTRIBUTES },
      nodes: new Map([
        ['Start', { id: 'Start', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'box' } }],
        ['done', { id: 'done', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'Msquare' } }],
      ]),
      edges: [{ from: 'Start', to: 'done', attrs: { ...DEFAULT_EDGE_ATTRIBUTES } }],
    };
    const results = validate(graph);
    const startErrors = results.filter(r => r.rule === 'start_node' && r.severity === LintSeverity.ERROR);
    expect(startErrors).toHaveLength(0);
  });

  it('no Msquare: findExitNodeId finds "exit" by ID', () => {
    const graph: Graph = {
      name: 'test',
      attrs: { ...DEFAULT_GRAPH_ATTRIBUTES },
      nodes: new Map([
        ['start', { id: 'start', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'Mdiamond' } }],
        ['exit', { id: 'exit', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'box' } }],
      ]),
      edges: [{ from: 'start', to: 'exit', attrs: { ...DEFAULT_EDGE_ATTRIBUTES } }],
    };
    const results = validate(graph);
    const exitErrors = results.filter(r => r.rule === 'terminal_node' && r.severity === LintSeverity.ERROR);
    expect(exitErrors).toHaveLength(0);
  });

  it('no Msquare: findExitNodeId finds "end" by ID', () => {
    const graph: Graph = {
      name: 'test',
      attrs: { ...DEFAULT_GRAPH_ATTRIBUTES },
      nodes: new Map([
        ['start', { id: 'start', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'Mdiamond' } }],
        ['end', { id: 'end', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'box' } }],
      ]),
      edges: [{ from: 'start', to: 'end', attrs: { ...DEFAULT_EDGE_ATTRIBUTES } }],
    };
    const results = validate(graph);
    const exitErrors = results.filter(r => r.rule === 'terminal_node' && r.severity === LintSeverity.ERROR);
    expect(exitErrors).toHaveLength(0);
  });

  it('no Msquare: findExitNodeId finds "Exit" by ID', () => {
    const graph: Graph = {
      name: 'test',
      attrs: { ...DEFAULT_GRAPH_ATTRIBUTES },
      nodes: new Map([
        ['start', { id: 'start', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'Mdiamond' } }],
        ['Exit', { id: 'Exit', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'box' } }],
      ]),
      edges: [{ from: 'start', to: 'Exit', attrs: { ...DEFAULT_EDGE_ATTRIBUTES } }],
    };
    const results = validate(graph);
    const exitErrors = results.filter(r => r.rule === 'terminal_node' && r.severity === LintSeverity.ERROR);
    expect(exitErrors).toHaveLength(0);
  });

  it('no Msquare: findExitNodeId finds "End" by ID', () => {
    const graph: Graph = {
      name: 'test',
      attrs: { ...DEFAULT_GRAPH_ATTRIBUTES },
      nodes: new Map([
        ['start', { id: 'start', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'Mdiamond' } }],
        ['End', { id: 'End', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'box' } }],
      ]),
      edges: [{ from: 'start', to: 'End', attrs: { ...DEFAULT_EDGE_ATTRIBUTES } }],
    };
    const results = validate(graph);
    const exitErrors = results.filter(r => r.rule === 'terminal_node' && r.severity === LintSeverity.ERROR);
    expect(exitErrors).toHaveLength(0);
  });
});

describe('goalGateHasRetryRule', () => {
  it('warns when goal_gate node has no retry target at any level', () => {
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        work [shape=box, prompt="x", goal_gate=true]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    const results = validate(graph);
    const warns = results.filter(r => r.rule === 'goal_gate_has_retry');
    expect(warns.length).toBeGreaterThan(0);
  });

  it('no warning when goal_gate node has graph-level retry_target', () => {
    const graph = parseDot(`
      digraph G {
        retry_target = start
        start [shape=Mdiamond]
        work [shape=box, prompt="x", goal_gate=true]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    const results = validate(graph);
    const warns = results.filter(r => r.rule === 'goal_gate_has_retry');
    expect(warns).toHaveLength(0);
  });
});
