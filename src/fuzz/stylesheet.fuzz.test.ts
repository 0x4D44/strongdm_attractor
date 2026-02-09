/**
 * Property-based / fuzz tests for the model stylesheet parser.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseStylesheet, SelectorType } from '../attractor/stylesheet.js';
import type { StyleRule } from '../attractor/stylesheet.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParse(input: string): StyleRule[] | null {
  try {
    return parseStylesheet(input);
  } catch (e: unknown) {
    if (e instanceof Error) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Arbitrary generators
// ---------------------------------------------------------------------------

/** Valid identifier (for shape selectors, property names, values). */
const arbIdent = fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz_'.split('')), { minLength: 1, maxLength: 10 })
  .map(arr => arr.join(''));

/** Valid class name (lowercase + hyphens). */
const arbClassName = fc.tuple(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
  fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), { minLength: 0, maxLength: 9 }),
).map(([first, rest]) => first + rest.join(''));

/** Valid node ID for # selector. */
const arbNodeId = fc.tuple(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')),
  fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')), { minLength: 0, maxLength: 9 }),
).map(([first, rest]) => first + rest.join(''));

/** Valid selector. */
const arbSelector = fc.oneof(
  fc.constant('*'),
  arbIdent,                                 // shape selector
  arbClassName.map(cls => `.${cls}`),       // class selector
  arbNodeId.map(id => `#${id}`),            // id selector
);

/** Valid property name (lowercase + underscores). */
const arbPropName = fc.constantFrom('llm_model', 'llm_provider', 'reasoning_effort', 'model', 'provider');

/** Valid property value (unquoted or quoted). */
const arbPropValue = fc.oneof(
  arbIdent,
  fc.string({ minLength: 1, maxLength: 20 }).filter(s => !s.includes('"') && !s.includes(';') && !s.includes('}'))
    .map(s => s.trim()).filter(s => s.length > 0),
  fc.string({ minLength: 0, maxLength: 20 }).filter(s => !s.includes('"') && !s.includes('\\'))
    .map(s => `"${s}"`),
);

/** Valid declaration. */
const arbDeclaration = fc.tuple(
  arbPropName,
  fc.constantFrom('=', ':'),
  arbPropValue,
).map(([prop, sep, val]) => `  ${prop} ${sep} ${val}`);

/** Valid rule. */
const arbRule = fc.tuple(
  arbSelector,
  fc.array(arbDeclaration, { minLength: 1, maxLength: 3 }),
).map(([sel, decls]) => `${sel} {\n${decls.join(';\n')};\n}`);

/** Full valid stylesheet. */
const arbStylesheet = fc.array(arbRule, { minLength: 1, maxLength: 4 }).map(
  rules => rules.join('\n\n'),
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Stylesheet parser fuzz tests', () => {
  it('never crashes on arbitrary input (throws clean Error or returns rules)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 300 }), (input) => {
        try {
          parseStylesheet(input);
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('valid stylesheets always parse into an array of rules', () => {
    fc.assert(
      fc.property(arbStylesheet, (css) => {
        const rules = parseStylesheet(css);
        expect(rules).toBeInstanceOf(Array);
        expect(rules.length).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });

  it('each parsed rule has a valid selector type', () => {
    fc.assert(
      fc.property(arbStylesheet, (css) => {
        const rules = parseStylesheet(css);
        const validTypes = [SelectorType.UNIVERSAL, SelectorType.SHAPE, SelectorType.CLASS, SelectorType.ID];
        for (const rule of rules) {
          expect(validTypes).toContain(rule.selector.type);
          expect(rule.selector.value.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('each rule has at least one declaration', () => {
    fc.assert(
      fc.property(arbStylesheet, (css) => {
        const rules = parseStylesheet(css);
        for (const rule of rules) {
          expect(rule.declarations.length).toBeGreaterThanOrEqual(1);
          for (const decl of rule.declarations) {
            expect(typeof decl.property).toBe('string');
            expect(decl.property.length).toBeGreaterThan(0);
            expect(typeof decl.value).toBe('string');
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('universal selector (*) produces UNIVERSAL type', () => {
    fc.assert(
      fc.property(
        fc.array(arbDeclaration, { minLength: 1, maxLength: 2 }),
        (decls) => {
          const css = `* {\n${decls.join(';\n')};\n}`;
          const rules = safeParse(css);
          if (rules && rules.length > 0) {
            expect(rules[0].selector.type).toBe(SelectorType.UNIVERSAL);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('class selector (.name) produces CLASS type', () => {
    fc.assert(
      fc.property(arbClassName, arbDeclaration, (cls, decl) => {
        const css = `.${cls} {\n${decl};\n}`;
        const rules = safeParse(css);
        if (rules && rules.length > 0) {
          expect(rules[0].selector.type).toBe(SelectorType.CLASS);
          expect(rules[0].selector.value).toBe(cls);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('ID selector (#name) produces ID type', () => {
    fc.assert(
      fc.property(arbNodeId, arbDeclaration, (id, decl) => {
        const css = `#${id} {\n${decl};\n}`;
        const rules = safeParse(css);
        if (rules && rules.length > 0) {
          expect(rules[0].selector.type).toBe(SelectorType.ID);
          expect(rules[0].selector.value).toBe(id);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('shape selector (bare name) produces SHAPE type', () => {
    fc.assert(
      fc.property(arbIdent, arbDeclaration, (shape, decl) => {
        const css = `${shape} {\n${decl};\n}`;
        const rules = safeParse(css);
        if (rules && rules.length > 0) {
          expect(rules[0].selector.type).toBe(SelectorType.SHAPE);
          expect(rules[0].selector.value).toBe(shape);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('rule count matches number of selector blocks', () => {
    fc.assert(
      fc.property(
        fc.array(arbRule, { minLength: 1, maxLength: 5 }),
        (rules) => {
          const css = rules.join('\n\n');
          const parsed = safeParse(css);
          if (parsed) {
            expect(parsed.length).toBe(rules.length);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('handles binary-like input without infinite loops', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 200 }), (bytes) => {
        const input = Buffer.from(bytes).toString('utf-8');
        try {
          parseStylesheet(input);
        } catch {
          // Errors are fine
        }
      }),
      { numRuns: 200 },
    );
  });

  it('empty input returns empty rules array', () => {
    const rules = parseStylesheet('');
    expect(rules).toEqual([]);
  });

  it('whitespace-only input returns empty rules array', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(' ', '\t', '\n'), { minLength: 1, maxLength: 20 })
          .map(arr => arr.join('')),
        (ws) => {
          const rules = parseStylesheet(ws);
          expect(rules).toEqual([]);
        },
      ),
      { numRuns: 50 },
    );
  });
});
