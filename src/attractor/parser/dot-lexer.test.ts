import { describe, it, expect } from 'vitest';
import { DotLexer, TokenType, stripComments } from './dot-lexer.js';

function tokenTypes(input: string): TokenType[] {
  return new DotLexer(input).tokenize().map(t => t.type);
}

function tokenValues(input: string): string[] {
  return new DotLexer(input).tokenize().map(t => t.value);
}

describe('DotLexer', () => {
  it('tokenizes simple digraph', () => {
    const tokens = new DotLexer('digraph G { }').tokenize();
    expect(tokens.map(t => t.type)).toEqual([
      TokenType.DIGRAPH,
      TokenType.IDENTIFIER,
      TokenType.LBRACE,
      TokenType.RBRACE,
      TokenType.EOF,
    ]);
    expect(tokens[1].value).toBe('G');
  });

  it('tokenizes node with attributes', () => {
    const tokens = new DotLexer('node_id [shape=box, label="Hello"]').tokenize();
    expect(tokens.map(t => t.type)).toEqual([
      TokenType.IDENTIFIER,
      TokenType.LBRACKET,
      TokenType.IDENTIFIER,
      TokenType.EQUALS,
      TokenType.IDENTIFIER,
      TokenType.COMMA,
      TokenType.IDENTIFIER,
      TokenType.EQUALS,
      TokenType.STRING,
      TokenType.RBRACKET,
      TokenType.EOF,
    ]);
    expect(tokens[0].value).toBe('node_id');
    expect(tokens[8].value).toBe('Hello');
  });

  it('tokenizes edge', () => {
    const tokens = new DotLexer('A -> B [label="next"]').tokenize();
    expect(tokens.map(t => t.type)).toEqual([
      TokenType.IDENTIFIER,
      TokenType.ARROW,
      TokenType.IDENTIFIER,
      TokenType.LBRACKET,
      TokenType.IDENTIFIER,
      TokenType.EQUALS,
      TokenType.STRING,
      TokenType.RBRACKET,
      TokenType.EOF,
    ]);
    expect(tokens[0].value).toBe('A');
    expect(tokens[2].value).toBe('B');
    expect(tokens[6].value).toBe('next');
  });

  it('tokenizes all value types: strings', () => {
    const tokens = new DotLexer('"hello world"').tokenize();
    expect(tokens[0].type).toBe(TokenType.STRING);
    expect(tokens[0].value).toBe('hello world');
  });

  it('tokenizes all value types: integers', () => {
    const tokens = new DotLexer('42').tokenize();
    expect(tokens[0].type).toBe(TokenType.INTEGER);
    expect(tokens[0].value).toBe('42');
  });

  it('tokenizes all value types: negative integers', () => {
    const tokens = new DotLexer('-7').tokenize();
    expect(tokens[0].type).toBe(TokenType.INTEGER);
    expect(tokens[0].value).toBe('-7');
  });

  it('tokenizes all value types: floats', () => {
    const tokens = new DotLexer('3.14').tokenize();
    expect(tokens[0].type).toBe(TokenType.FLOAT);
    expect(tokens[0].value).toBe('3.14');
  });

  it('tokenizes all value types: booleans', () => {
    const tokens = new DotLexer('true false').tokenize();
    expect(tokens[0].type).toBe(TokenType.TRUE);
    expect(tokens[1].type).toBe(TokenType.FALSE);
  });

  it('tokenizes all value types: durations', () => {
    for (const [input, expected] of [
      ['100ms', '100ms'],
      ['30s', '30s'],
      ['5m', '5m'],
      ['2h', '2h'],
      ['1d', '1d'],
    ]) {
      const tokens = new DotLexer(input).tokenize();
      expect(tokens[0].type).toBe(TokenType.DURATION);
      expect(tokens[0].value).toBe(expected);
    }
  });

  it('tokenizes chained edges', () => {
    const tokens = new DotLexer('A -> B -> C').tokenize();
    expect(tokens.map(t => t.type)).toEqual([
      TokenType.IDENTIFIER,
      TokenType.ARROW,
      TokenType.IDENTIFIER,
      TokenType.ARROW,
      TokenType.IDENTIFIER,
      TokenType.EOF,
    ]);
  });

  it('tokenizes graph/node/edge default keywords', () => {
    const tokens = new DotLexer('graph node edge subgraph').tokenize();
    expect(tokens.map(t => t.type)).toEqual([
      TokenType.GRAPH,
      TokenType.NODE,
      TokenType.EDGE,
      TokenType.SUBGRAPH,
      TokenType.EOF,
    ]);
  });

  it('is case-insensitive for DOT keywords', () => {
    const tokens = new DotLexer('DIGRAPH Digraph').tokenize();
    expect(tokens[0].type).toBe(TokenType.DIGRAPH);
    expect(tokens[1].type).toBe(TokenType.DIGRAPH);
  });

  it('throws on undirected edge (--)', () => {
    expect(() => new DotLexer('A -- B').tokenize()).toThrow(/Undirected edges/);
  });

  it('throws on unterminated string', () => {
    expect(() => new DotLexer('"hello').tokenize()).toThrow(/Unterminated string/);
  });

  it('handles dot separator for qualified IDs', () => {
    const tokens = new DotLexer('foo.bar').tokenize();
    expect(tokens.map(t => t.type)).toEqual([
      TokenType.IDENTIFIER,
      TokenType.DOT,
      TokenType.IDENTIFIER,
      TokenType.EOF,
    ]);
  });

  it('handles semicolons', () => {
    const tokens = new DotLexer('A; B;').tokenize();
    expect(tokens.map(t => t.type)).toEqual([
      TokenType.IDENTIFIER,
      TokenType.SEMICOLON,
      TokenType.IDENTIFIER,
      TokenType.SEMICOLON,
      TokenType.EOF,
    ]);
  });
});

describe('stripComments', () => {
  it('strips line comments', () => {
    const result = stripComments('hello // this is a comment\nworld');
    expect(result).toBe('hello \nworld');
  });

  it('strips block comments', () => {
    const result = stripComments('hello /* block */ world');
    expect(result).toBe('hello  world');
  });

  it('preserves newlines in block comments for line counting', () => {
    const result = stripComments('hello /* block\ncomment */ world');
    expect(result).toBe('hello \n world');
  });

  it('does not strip inside strings', () => {
    const result = stripComments('"hello // world"');
    expect(result).toBe('"hello // world"');
  });

  it('handles escaped quotes in strings', () => {
    const result = stripComments('"hello \\"world\\""');
    expect(result).toBe('"hello \\"world\\""');
  });

  it('handles escaped backslash before closing quote (the bug fix)', () => {
    // A string ending with \\", the \\\\ is an escaped backslash, then " closes the string
    const result = stripComments('"path\\\\" // comment');
    expect(result).toBe('"path\\\\" ');
  });

  it('does not treat single backslash before quote as end of string', () => {
    const result = stripComments('"hello \\" still inside"');
    expect(result).toBe('"hello \\" still inside"');
  });
});

describe('DotLexer string escaping', () => {
  it('handles escaped quotes in strings', () => {
    const tokens = new DotLexer('"hello \\"world\\""').tokenize();
    expect(tokens[0].type).toBe(TokenType.STRING);
    expect(tokens[0].value).toBe('hello "world"');
  });

  it('handles escaped backslashes', () => {
    const tokens = new DotLexer('"path\\\\"').tokenize();
    expect(tokens[0].type).toBe(TokenType.STRING);
    expect(tokens[0].value).toBe('path\\');
  });

  it('handles escaped newlines and tabs', () => {
    const tokens = new DotLexer('"line1\\nline2\\ttab"').tokenize();
    expect(tokens[0].value).toBe('line1\nline2\ttab');
  });

  it('preserves unknown escape sequences with backslash', () => {
    const tokens = new DotLexer('"\\x"').tokenize();
    expect(tokens[0].value).toBe('\\x');
  });
});

describe('DotLexer - mutant-killing tests', () => {
  it('token values for single-char tokens are correct', () => {
    const tokens = new DotLexer('{ } [ ] , ; =').tokenize();
    expect(tokens[0].value).toBe('{');
    expect(tokens[1].value).toBe('}');
    expect(tokens[2].value).toBe('[');
    expect(tokens[3].value).toBe(']');
    expect(tokens[4].value).toBe(',');
    expect(tokens[5].value).toBe(';');
    expect(tokens[6].value).toBe('=');
  });

  it('arrow value is "->"', () => {
    const tokens = new DotLexer('A -> B').tokenize();
    expect(tokens[1].value).toBe('->');
  });

  it('dot value is "."', () => {
    const tokens = new DotLexer('foo.bar').tokenize();
    expect(tokens[1].value).toBe('.');
  });

  it('EOF value is empty string', () => {
    const tokens = new DotLexer('x').tokenize();
    const eof = tokens[tokens.length - 1];
    expect(eof.type).toBe(TokenType.EOF);
    expect(eof.value).toBe('');
  });

  it('tracks line and column correctly', () => {
    const tokens = new DotLexer('A\nB\nC').tokenize();
    expect(tokens[0].line).toBe(1);
    expect(tokens[0].column).toBe(1);
    expect(tokens[1].line).toBe(2);
    expect(tokens[1].column).toBe(1);
    expect(tokens[2].line).toBe(3);
    expect(tokens[2].column).toBe(1);
  });

  it('tracks column correctly within a line', () => {
    const tokens = new DotLexer('A B C').tokenize();
    expect(tokens[0].column).toBe(1);
    expect(tokens[1].column).toBe(3);
    expect(tokens[2].column).toBe(5);
  });

  it('line tracking across multiple newlines', () => {
    const tokens = new DotLexer('A\n\n\nB').tokenize();
    expect(tokens[0].line).toBe(1);
    expect(tokens[1].line).toBe(4);
  });

  it('throws on unexpected character', () => {
    expect(() => new DotLexer('@').tokenize()).toThrow(/Unexpected character/);
  });

  it('error message includes line and column info', () => {
    expect(() => new DotLexer('A\n@').tokenize()).toThrow(/line 2/);
  });

  it('undirected edge error has line info', () => {
    expect(() => new DotLexer('A -- B').tokenize()).toThrow(/line 1/);
  });

  it('digit 9 is recognized as a digit', () => {
    const tokens = new DotLexer('9').tokenize();
    expect(tokens[0].type).toBe(TokenType.INTEGER);
    expect(tokens[0].value).toBe('9');
  });

  it('negative number at end of input', () => {
    const tokens = new DotLexer('-42').tokenize();
    expect(tokens[0].type).toBe(TokenType.INTEGER);
    expect(tokens[0].value).toBe('-42');
  });

  it('float decimal digits parsed completely', () => {
    const tokens = new DotLexer('1.23').tokenize();
    expect(tokens[0].type).toBe(TokenType.FLOAT);
    expect(tokens[0].value).toBe('1.23');
  });

  it('integer followed by dot (not a float)', () => {
    // "42." where there's no digit after the dot
    const tokens = new DotLexer('42.x').tokenize();
    expect(tokens[0].type).toBe(TokenType.INTEGER);
    expect(tokens[0].value).toBe('42');
    expect(tokens[1].type).toBe(TokenType.DOT);
    expect(tokens[2].type).toBe(TokenType.IDENTIFIER);
  });

  it('duration suffix advances position correctly', () => {
    // After duration "100ms", the next token should be separate
    const tokens = new DotLexer('100ms x').tokenize();
    expect(tokens[0].type).toBe(TokenType.DURATION);
    expect(tokens[0].value).toBe('100ms');
    expect(tokens[1].type).toBe(TokenType.IDENTIFIER);
    expect(tokens[1].value).toBe('x');
  });

  it('duration suffix ms not confused with identifier', () => {
    // "100msg" - "ms" followed by "g" should NOT be a duration
    const tokens = new DotLexer('100msg').tokenize();
    // The regex has a word boundary check, so "msg" doesn't match
    expect(tokens[0].type).toBe(TokenType.INTEGER);
    expect(tokens[0].value).toBe('100');
    expect(tokens[1].type).toBe(TokenType.IDENTIFIER);
    expect(tokens[1].value).toBe('msg');
  });

  it('float number is not treated as duration', () => {
    const tokens = new DotLexer('1.5').tokenize();
    expect(tokens[0].type).toBe(TokenType.FLOAT);
    // floats should not have duration suffix applied
  });

  it('peek returns empty string past end of input', () => {
    // A '-' at end of input (not followed by anything)
    // should hit the 'peek' boundary -> '' which is not '>' so not arrow
    expect(() => new DotLexer('A -').tokenize()).toThrow();
  });

  it('escape at end of string body', () => {
    // Backslash right before end of input inside a string
    expect(() => new DotLexer('"hello\\').tokenize()).toThrow(/Unterminated/);
  });

  it('handles empty input', () => {
    const tokens = new DotLexer('').tokenize();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe(TokenType.EOF);
  });

  it('handles whitespace-only input', () => {
    const tokens = new DotLexer('   \n\t  ').tokenize();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe(TokenType.EOF);
  });
});

describe('stripComments - mutant-killing tests', () => {
  it('line comment at end of file (no trailing newline)', () => {
    const result = stripComments('hello // comment at end');
    expect(result).toBe('hello ');
  });

  it('block comment with * but not followed by /', () => {
    const result = stripComments('a /* b * c */ d');
    expect(result).toBe('a  d');
  });

  it('slash not followed by slash or star is preserved', () => {
    const result = stripComments('a / b');
    expect(result).toBe('a / b');
  });

  it('block comment preserves correct number of newlines', () => {
    const result = stripComments('a /* line1\nline2\nline3 */ b');
    expect(result).toBe('a \n\n b');
  });

  it('handles block comment at end of file (unterminated)', () => {
    const result = stripComments('hello /* unclosed');
    expect(result).toBe('hello ');
  });

  it('block comment with star at end of content', () => {
    const result = stripComments('/* star* */ rest');
    expect(result).toBe(' rest');
  });
});
