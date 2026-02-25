import { describe, it, expect } from 'vitest';
import { parseStylesheet, applyStylesheet, SelectorType } from './stylesheet.js';
import type { Graph } from './types.js';
import { DEFAULT_NODE_ATTRIBUTES, DEFAULT_GRAPH_ATTRIBUTES } from './types.js';

describe('parseStylesheet', () => {
  it('parses universal selector *', () => {
    const rules = parseStylesheet('* { model = "gpt-4" }');
    expect(rules).toHaveLength(1);
    expect(rules[0].selector.type).toBe(SelectorType.UNIVERSAL);
    expect(rules[0].selector.value).toBe('*');
    expect(rules[0].declarations[0].value).toBe('gpt-4');
  });

  it('handles trailing whitespace after last rule', () => {
    const rules = parseStylesheet('box { model = "claude" }   \n  ');
    expect(rules).toHaveLength(1);
  });

  it('passes through unknown property names unchanged', () => {
    const rules = parseStylesheet('box { custom_prop = "val" }');
    expect(rules[0].declarations[0].property).toBe('custom_prop');
  });

  it('parses shape selector', () => {
    const rules = parseStylesheet('box { model = "claude" }');
    expect(rules).toHaveLength(1);
    expect(rules[0].selector.type).toBe(SelectorType.SHAPE);
    expect(rules[0].selector.value).toBe('box');
    expect(rules[0].declarations).toHaveLength(1);
    expect(rules[0].declarations[0].property).toBe('model');
    expect(rules[0].declarations[0].value).toBe('claude');
  });

  it('parses class selector', () => {
    const rules = parseStylesheet('.fast { model = "gemini" }');
    expect(rules).toHaveLength(1);
    expect(rules[0].selector.type).toBe(SelectorType.CLASS);
    expect(rules[0].selector.value).toBe('fast');
    expect(rules[0].declarations[0].value).toBe('gemini');
  });

  it('parses ID selector', () => {
    const rules = parseStylesheet('#review { reasoning_effort = "high" }');
    expect(rules).toHaveLength(1);
    expect(rules[0].selector.type).toBe(SelectorType.ID);
    expect(rules[0].selector.value).toBe('review');
    expect(rules[0].declarations[0].property).toBe('reasoning_effort');
    expect(rules[0].declarations[0].value).toBe('high');
  });

  it('parses universal selector', () => {
    const rules = parseStylesheet('* { model = "default" }');
    expect(rules).toHaveLength(1);
    expect(rules[0].selector.type).toBe(SelectorType.UNIVERSAL);
  });

  it('multiple rules parsed correctly', () => {
    const rules = parseStylesheet(`
      box { model = "claude" }
      .fast { model = "gemini" }
      #review { reasoning_effort = "high" }
    `);
    expect(rules).toHaveLength(3);
  });

  it('both = and : as declaration separators', () => {
    const rules = parseStylesheet('box { model = "a"; provider : "b" }');
    expect(rules[0].declarations).toHaveLength(2);
    expect(rules[0].declarations[0].value).toBe('a');
    expect(rules[0].declarations[1].value).toBe('b');
  });

  it('multiple declarations with semicolons', () => {
    const rules = parseStylesheet('box { model = "claude"; provider = "anthropic"; reasoning_effort = "high" }');
    expect(rules[0].declarations).toHaveLength(3);
  });
});

describe('applyStylesheet', () => {
  function makeGraphWithStylesheet(stylesheet: string, nodes: Array<{ id: string; shape?: string; class?: string; llm_model?: string }>): Graph {
    const graph: Graph = {
      name: 'test',
      attrs: { ...DEFAULT_GRAPH_ATTRIBUTES, model_stylesheet: stylesheet },
      nodes: new Map(),
      edges: [],
    };
    for (const n of nodes) {
      graph.nodes.set(n.id, {
        id: n.id,
        attrs: {
          ...DEFAULT_NODE_ATTRIBUTES,
          shape: n.shape ?? 'box',
          class: n.class ?? '',
          llm_model: n.llm_model ?? '',
        },
      });
    }
    return graph;
  }

  it('shape selector applies to matching nodes', () => {
    const graph = makeGraphWithStylesheet(
      'box { model = "claude" }',
      [
        { id: 'A', shape: 'box' },
        { id: 'B', shape: 'hexagon' },
      ]
    );
    const result = applyStylesheet(graph);
    expect((result.nodes.get('A')!.attrs as Record<string, unknown>).llm_model).toBe('claude');
    // hexagon should not match
    expect(result.nodes.get('B')!.attrs.llm_model).toBe('');
  });

  it('class selector applies to nodes with matching class', () => {
    const graph = makeGraphWithStylesheet(
      '.fast { model = "gemini" }',
      [
        { id: 'A', class: 'fast' },
        { id: 'B', class: 'slow' },
      ]
    );
    const result = applyStylesheet(graph);
    expect((result.nodes.get('A')!.attrs as Record<string, unknown>).llm_model).toBe('gemini');
    expect(result.nodes.get('B')!.attrs.llm_model).toBe('');
  });

  it('ID selector applies to node with matching ID', () => {
    const graph = makeGraphWithStylesheet(
      '#review { reasoning_effort = "high" }',
      [
        { id: 'review' },
        { id: 'other' },
      ]
    );
    const result = applyStylesheet(graph);
    expect((result.nodes.get('review')!.attrs as Record<string, unknown>).reasoning_effort).toBe('high');
  });

  it('specificity: ID overrides shape', () => {
    const graph = makeGraphWithStylesheet(
      'box { model = "default" }\n#special { model = "override" }',
      [{ id: 'special', shape: 'box' }]
    );
    const result = applyStylesheet(graph);
    expect((result.nodes.get('special')!.attrs as Record<string, unknown>).llm_model).toBe('override');
  });

  it('explicit node attributes override stylesheet', () => {
    const graph = makeGraphWithStylesheet(
      'box { model = "from-stylesheet" }',
      [{ id: 'A', shape: 'box', llm_model: 'explicit-model' }]
    );
    const result = applyStylesheet(graph);
    expect(result.nodes.get('A')!.attrs.llm_model).toBe('explicit-model');
  });

  it('returns graph unchanged when no stylesheet', () => {
    const graph: Graph = {
      name: 'test',
      attrs: { ...DEFAULT_GRAPH_ATTRIBUTES },
      nodes: new Map(),
      edges: [],
    };
    const result = applyStylesheet(graph);
    expect(result).toBe(graph);
  });

  it('universal selector applies to all nodes', () => {
    const graph = makeGraphWithStylesheet(
      '* { model = "universal-model" }',
      [
        { id: 'A', shape: 'box' },
        { id: 'B', shape: 'hexagon' },
      ]
    );
    const result = applyStylesheet(graph);
    expect((result.nodes.get('A')!.attrs as Record<string, unknown>).llm_model).toBe('universal-model');
    expect((result.nodes.get('B')!.attrs as Record<string, unknown>).llm_model).toBe('universal-model');
  });

  it('class selector does not match node with no class', () => {
    const graph = makeGraphWithStylesheet(
      '.fast { model = "gemini" }',
      [{ id: 'A', class: '' }]
    );
    const result = applyStylesheet(graph);
    expect(result.nodes.get('A')!.attrs.llm_model).toBe('');
  });
});

describe('parseStylesheet - edge cases', () => {
  it('quoted values with escaped characters', () => {
    const rules = parseStylesheet('box { model = "claude\\"opus" }');
    expect(rules).toHaveLength(1);
    expect(rules[0].declarations[0].value).toBe('claude"opus');
  });

  it('throws on missing closing brace', () => {
    expect(() => parseStylesheet('box { model = "test"')).toThrow(/Expected '}'/);
  });

  it('throws on missing opening brace', () => {
    expect(() => parseStylesheet('box model = "test" }')).toThrow(/Expected '{'/);
  });

  it('unquoted property values read until ; or }', () => {
    const rules = parseStylesheet('box { model = gpt-4o-mini }');
    expect(rules[0].declarations[0].value).toBe('gpt-4o-mini');
  });

  it('throws on missing declaration separator', () => {
    expect(() => parseStylesheet('box { model "test" }')).toThrow(/Expected '=' or ':'/);
  });

  it('throws on empty class name', () => {
    expect(() => parseStylesheet('. { model = "test" }')).toThrow(/Expected class name/);
  });

  it('throws on empty identifier', () => {
    expect(() => parseStylesheet('{ model = "test" }')).toThrow();
  });

  it('property name with underscores', () => {
    const rules = parseStylesheet('box { reasoning_effort = high }');
    expect(rules[0].declarations[0].property).toBe('reasoning_effort');
    expect(rules[0].declarations[0].value).toBe('high');
  });

  it('parses empty stylesheet (whitespace only)', () => {
    const rules = parseStylesheet('   \n   ');
    expect(rules).toHaveLength(0);
  });

  it('parses stylesheet with trailing whitespace after rules', () => {
    const rules = parseStylesheet('box { model = "test" }   \n  ');
    expect(rules).toHaveLength(1);
  });

  it('throws on missing property name', () => {
    expect(() => parseStylesheet('box { = "test" }')).toThrow(/Expected property name/);
  });
});

describe('applyStylesheet - specificity', () => {
  function makeGraphWithStylesheet(stylesheet: string, nodes: Array<{ id: string; shape?: string; class?: string; llm_model?: string }>): Graph {
    const graph: Graph = {
      name: 'test',
      attrs: { ...DEFAULT_GRAPH_ATTRIBUTES, model_stylesheet: stylesheet },
      nodes: new Map(),
      edges: [],
    };
    for (const n of nodes) {
      graph.nodes.set(n.id, {
        id: n.id,
        attrs: {
          ...DEFAULT_NODE_ATTRIBUTES,
          shape: n.shape ?? 'box',
          class: n.class ?? '',
          llm_model: n.llm_model ?? '',
        },
      });
    }
    return graph;
  }

  it('later rule of same specificity overrides earlier', () => {
    const graph = makeGraphWithStylesheet(
      'box { model = "first" }\nbox { model = "second" }',
      [{ id: 'A', shape: 'box' }]
    );
    const result = applyStylesheet(graph);
    expect((result.nodes.get('A')!.attrs as Record<string, unknown>).llm_model).toBe('second');
  });

  it('higher specificity overrides lower regardless of order', () => {
    const graph = makeGraphWithStylesheet(
      '#specific { model = "id-model" }\nbox { model = "shape-model" }',
      [{ id: 'specific', shape: 'box' }]
    );
    const result = applyStylesheet(graph);
    expect((result.nodes.get('specific')!.attrs as Record<string, unknown>).llm_model).toBe('id-model');
  });

  it('canonical property mapping: model -> llm_model, provider -> llm_provider', () => {
    const graph = makeGraphWithStylesheet(
      'box { model = "test-model"; provider = "test-provider" }',
      [{ id: 'A', shape: 'box' }]
    );
    const result = applyStylesheet(graph);
    expect((result.nodes.get('A')!.attrs as Record<string, unknown>).llm_model).toBe('test-model');
    expect((result.nodes.get('A')!.attrs as Record<string, unknown>).llm_provider).toBe('test-provider');
  });

  it('unknown property falls through PROPERTY_MAP to itself', () => {
    const graph = makeGraphWithStylesheet(
      'box { some_custom_prop = "custom_val" }',
      [{ id: 'A', shape: 'box' }]
    );
    const result = applyStylesheet(graph);
    // Property not in PROPERTY_MAP should use the property name as-is
    expect((result.nodes.get('A')!.attrs as Record<string, unknown>).some_custom_prop).toBe('custom_val');
  });
});
