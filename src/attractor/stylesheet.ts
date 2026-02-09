/**
 * Model stylesheet parser and applicator.
 * CSS-like syntax for setting LLM model/provider/reasoning defaults on nodes.
 *
 * Grammar:
 *   Stylesheet    ::= Rule+
 *   Rule          ::= Selector '{' Declaration ( ';' Declaration )* ';'? '}'
 *   Selector      ::= '*' | ShapeName | '#' Identifier | '.' ClassName
 *   Declaration   ::= Property '=' PropertyValue
 */

import type { Graph, Node } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export enum SelectorType {
  UNIVERSAL = 'universal',   // *
  SHAPE = 'shape',           // shape name (e.g., box)
  CLASS = 'class',           // .class_name
  ID = 'id',                 // #node_id
}

export interface StyleSelector {
  type: SelectorType;
  value: string; // The selector value (shape name, class name, or node ID)
}

export interface StyleDeclaration {
  property: string;
  value: string;
}

export interface StyleRule {
  selector: StyleSelector;
  declarations: StyleDeclaration[];
}

// ---------------------------------------------------------------------------
// Specificity
// ---------------------------------------------------------------------------

function specificity(selector: StyleSelector): number {
  switch (selector.type) {
    case SelectorType.UNIVERSAL: return 0;
    case SelectorType.SHAPE: return 1;
    case SelectorType.CLASS: return 1;
    case SelectorType.ID: return 2;
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseStylesheet(source: string): StyleRule[] {
  const rules: StyleRule[] = [];
  let pos = 0;

  function skipWhitespace(): void {
    while (pos < source.length && /\s/.test(source[pos])) pos++;
  }

  function readSelector(): StyleSelector {
    skipWhitespace();
    if (pos >= source.length) throw new Error('Expected selector');

    // Universal selector
    if (source[pos] === '*') {
      pos++;
      return { type: SelectorType.UNIVERSAL, value: '*' };
    }

    // ID selector
    if (source[pos] === '#') {
      pos++;
      const id = readIdentifier();
      return { type: SelectorType.ID, value: id };
    }

    // Class selector
    if (source[pos] === '.') {
      pos++;
      const cls = readClassName();
      return { type: SelectorType.CLASS, value: cls };
    }

    // Shape selector (bare identifier)
    const name = readIdentifier();
    return { type: SelectorType.SHAPE, value: name };
  }

  function readIdentifier(): string {
    skipWhitespace();
    let id = '';
    while (pos < source.length && /[A-Za-z0-9_]/.test(source[pos])) {
      id += source[pos];
      pos++;
    }
    if (!id) throw new Error(`Expected identifier at position ${pos}`);
    return id;
  }

  function readClassName(): string {
    let cls = '';
    while (pos < source.length && /[a-z0-9-]/.test(source[pos])) {
      cls += source[pos];
      pos++;
    }
    if (!cls) throw new Error(`Expected class name at position ${pos}`);
    return cls;
  }

  function readDeclarations(): StyleDeclaration[] {
    const declarations: StyleDeclaration[] = [];

    skipWhitespace();
    while (pos < source.length && source[pos] !== '}') {
      skipWhitespace();
      if (pos >= source.length || source[pos] === '}') break;

      // Property name
      const property = readPropertyName();
      skipWhitespace();

      // Accept both = and : as separators
      if (pos < source.length && (source[pos] === '=' || source[pos] === ':')) {
        pos++;
      } else {
        throw new Error(`Expected '=' or ':' after property '${property}' at position ${pos}`);
      }

      skipWhitespace();

      // Property value
      const value = readPropertyValue();

      declarations.push({ property, value });

      // Optional semicolon
      skipWhitespace();
      if (pos < source.length && source[pos] === ';') {
        pos++;
      }
    }

    return declarations;
  }

  function readPropertyName(): string {
    let name = '';
    while (pos < source.length && /[a-z_]/.test(source[pos])) {
      name += source[pos];
      pos++;
    }
    if (!name) throw new Error(`Expected property name at position ${pos}`);
    return name;
  }

  function readPropertyValue(): string {
    skipWhitespace();
    let value = '';

    // Quoted string
    if (pos < source.length && source[pos] === '"') {
      pos++; // skip opening quote
      while (pos < source.length && source[pos] !== '"') {
        if (source[pos] === '\\') {
          pos++;
          if (pos < source.length) {
            value += source[pos];
            pos++;
          }
        } else {
          value += source[pos];
          pos++;
        }
      }
      if (pos < source.length) pos++; // skip closing quote
      return value;
    }

    // Unquoted value (read until ; or })
    while (pos < source.length && source[pos] !== ';' && source[pos] !== '}') {
      value += source[pos];
      pos++;
    }
    return value.trim();
  }

  // Main parse loop
  skipWhitespace();
  while (pos < source.length) {
    skipWhitespace();
    if (pos >= source.length) break;

    const selector = readSelector();
    skipWhitespace();

    if (pos >= source.length || source[pos] !== '{') {
      throw new Error(`Expected '{' at position ${pos}`);
    }
    pos++; // skip {

    const declarations = readDeclarations();

    skipWhitespace();
    if (pos >= source.length || source[pos] !== '}') {
      throw new Error(`Expected '}' at position ${pos}`);
    }
    pos++; // skip }

    rules.push({ selector, declarations });
    skipWhitespace();
  }

  return rules;
}

// ---------------------------------------------------------------------------
// Stylesheet Application
// ---------------------------------------------------------------------------

function selectorMatches(selector: StyleSelector, node: Node): boolean {
  switch (selector.type) {
    case SelectorType.UNIVERSAL:
      return true;
    case SelectorType.SHAPE:
      return node.attrs.shape === selector.value;
    case SelectorType.CLASS: {
      const nodeClasses = node.attrs.class
        ? node.attrs.class.split(',').map(c => c.trim())
        : [];
      return nodeClasses.includes(selector.value);
    }
    case SelectorType.ID:
      return node.id === selector.value;
  }
}

const STYLESHEET_PROPERTIES = new Set([
  'llm_model', 'llm_provider', 'reasoning_effort',
  // Also accept the shorthand 'model' and 'provider'
  'model', 'provider',
]);

const PROPERTY_MAP: Record<string, string> = {
  model: 'llm_model',
  provider: 'llm_provider',
  llm_model: 'llm_model',
  llm_provider: 'llm_provider',
  reasoning_effort: 'reasoning_effort',
};

export function applyStylesheet(graph: Graph): Graph {
  if (!graph.attrs.model_stylesheet) return graph;

  const rules = parseStylesheet(graph.attrs.model_stylesheet);

  // Sort rules by specificity (lower first, later rules of same specificity override)
  // We process all rules in order, letting higher specificity override lower
  for (const [_id, node] of graph.nodes) {
    // Collect applicable properties with specificity tracking
    const appliedProps = new Map<string, { value: string; specificity: number; ruleIndex: number }>();

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (!selectorMatches(rule.selector, node)) continue;

      const spec = specificity(rule.selector);
      for (const decl of rule.declarations) {
        const canonicalProp = PROPERTY_MAP[decl.property] || decl.property;
        const existing = appliedProps.get(canonicalProp);

        if (!existing || spec > existing.specificity ||
            (spec === existing.specificity && i > existing.ruleIndex)) {
          appliedProps.set(canonicalProp, {
            value: decl.value,
            specificity: spec,
            ruleIndex: i,
          });
        }
      }
    }

    // Apply collected properties, but only if node doesn't have explicit overrides
    for (const [prop, { value }] of appliedProps) {
      const nodeAttrs = node.attrs as Record<string, unknown>;
      // Only set if the node doesn't already have an explicit value
      if (!nodeAttrs[prop] || nodeAttrs[prop] === '') {
        nodeAttrs[prop] = value;
      }
    }
  }

  return graph;
}
