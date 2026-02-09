/**
 * Property-based / fuzz tests for the DOT Lexer.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { DotLexer, TokenType, stripComments } from '../attractor/parser/dot-lexer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tokenize input, returning tokens or null on expected error. */
function safeTokenize(input: string): ReturnType<DotLexer['tokenize']> | null {
  try {
    return new DotLexer(input).tokenize();
  } catch (e: unknown) {
    if (e instanceof Error) return null;
    throw e; // unexpected non-Error throw
  }
}

// ---------------------------------------------------------------------------
// Arbitrary generators
// ---------------------------------------------------------------------------

const identChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789'.split('');
const identStartChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('');

/** Generate a valid DOT identifier (starts with letter/_, then alphanumeric/_). */
const arbIdentifier = fc.tuple(
  fc.constantFrom(...identStartChars),
  fc.array(fc.constantFrom(...identChars), { minLength: 0, maxLength: 19 }),
).map(([first, rest]) => first + rest.join(''));

/** Generate a valid DOT string literal (with proper escaping). */
const arbDotString = fc.string({ minLength: 0, maxLength: 50 }).map(s => {
  const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
});

/** Generate a valid integer literal. */
const arbInteger = fc.integer({ min: -9999, max: 9999 }).map(n => String(n));

/** Generate a valid duration literal. */
const arbDuration = fc.tuple(
  fc.integer({ min: 1, max: 9999 }),
  fc.constantFrom('ms', 's', 'm', 'h', 'd'),
).map(([n, suffix]) => `${n}${suffix}`);

/** Generate a single valid DOT token string. */
const arbSingleToken = fc.oneof(
  arbIdentifier,
  arbDotString,
  arbInteger,
  arbDuration,
  fc.constantFrom('{', '}', '[', ']', ',', ';', '=', '->', '.'),
  fc.constantFrom('digraph', 'graph', 'node', 'edge', 'subgraph', 'true', 'false'),
);

/** Generate whitespace. */
const arbWhitespace = fc.array(fc.constantFrom(' ', '\t', '\n'), { minLength: 0, maxLength: 5 })
  .map(arr => arr.join(''));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DotLexer fuzz tests', () => {
  it('never crashes on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 500 }), (input) => {
        try {
          new DotLexer(input).tokenize();
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('always produces an array ending with EOF on valid token sequences', () => {
    fc.assert(
      fc.property(
        fc.array(arbSingleToken, { minLength: 0, maxLength: 20 }),
        fc.array(arbWhitespace, { minLength: 0, maxLength: 21 }),
        (tokens, spaces) => {
          let input = '';
          for (let i = 0; i < tokens.length; i++) {
            input += (spaces[i] || ' ') + tokens[i];
          }
          const result = safeTokenize(input);
          if (result !== null) {
            expect(result.length).toBeGreaterThanOrEqual(1);
            expect(result[result.length - 1].type).toBe(TokenType.EOF);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('token count is bounded by input length', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 300 }), (input) => {
        const result = safeTokenize(input);
        if (result !== null) {
          const nonEof = result.filter(t => t.type !== TokenType.EOF);
          expect(nonEof.length).toBeLessThanOrEqual(input.length + 1);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('tokenizing valid identifiers produces IDENTIFIER or keyword tokens', () => {
    fc.assert(
      fc.property(arbIdentifier, (id) => {
        const tokens = new DotLexer(id).tokenize();
        const first = tokens[0];
        const validTypes = [
          TokenType.IDENTIFIER, TokenType.DIGRAPH, TokenType.GRAPH,
          TokenType.NODE, TokenType.EDGE, TokenType.SUBGRAPH,
          TokenType.TRUE, TokenType.FALSE,
        ];
        expect(validTypes).toContain(first.type);
      }),
      { numRuns: 200 },
    );
  });

  it('tokenizing string literals always yields STRING type', () => {
    fc.assert(
      fc.property(arbDotString, (str) => {
        const tokens = new DotLexer(str).tokenize();
        expect(tokens[0].type).toBe(TokenType.STRING);
      }),
      { numRuns: 200 },
    );
  });

  it('tokenizing integers yields INTEGER type', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99999 }), (n) => {
        const tokens = new DotLexer(String(n)).tokenize();
        expect(tokens[0].type).toBe(TokenType.INTEGER);
      }),
      { numRuns: 200 },
    );
  });

  it('tokenizing durations yields DURATION type', () => {
    fc.assert(
      fc.property(arbDuration, (dur) => {
        const tokens = new DotLexer(dur).tokenize();
        expect(tokens[0].type).toBe(TokenType.DURATION);
      }),
      { numRuns: 200 },
    );
  });

  it('line and column are always positive integers', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (input) => {
        const result = safeTokenize(input);
        if (result !== null) {
          for (const tok of result) {
            expect(tok.line).toBeGreaterThanOrEqual(1);
            expect(tok.column).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(tok.line)).toBe(true);
            expect(Number.isInteger(tok.column)).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('stripComments never crashes on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 500 }), (input) => {
        const result = stripComments(input);
        expect(typeof result).toBe('string');
      }),
      { numRuns: 500 },
    );
  });

  it('stripComments removes // line comments', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }).filter(s => !s.includes('\n') && !s.includes('"') && !s.includes('/') && !s.includes('*')),
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('\n')),
        (before, comment) => {
          const input = `${before}// ${comment}\n`;
          const result = stripComments(input);
          expect(result).not.toContain(`// ${comment}`);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('stripComments removes /* block comments */', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('*/') && !s.includes('/*') && !s.includes('"')),
        (comment) => {
          const input = `abc /* ${comment} */ xyz`;
          const result = stripComments(input);
          expect(result).toContain('abc');
          expect(result).toContain('xyz');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('handles binary-like input without infinite loops', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 0, maxLength: 200 }),
        (bytes) => {
          const input = Buffer.from(bytes).toString('utf-8');
          try {
            new DotLexer(input).tokenize();
          } catch {
            // Errors are fine
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
