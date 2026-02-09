import { describe, it, expect } from 'vitest';
import { validate, validateOrRaise } from './validator.js';
import { parseDot } from './dot-parser.js';
import { LintSeverity } from '../types.js';

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
