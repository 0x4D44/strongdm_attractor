/**
 * DOT lexer: tokenizes DOT input for the Attractor pipeline parser.
 * Handles the strict DOT subset: digraph, identifiers, strings, numbers,
 * booleans, durations, operators, brackets, and comments.
 */

// ---------------------------------------------------------------------------
// Token Types
// ---------------------------------------------------------------------------

export enum TokenType {
  // Keywords
  DIGRAPH = 'DIGRAPH',
  GRAPH = 'GRAPH',
  NODE = 'NODE',
  EDGE = 'EDGE',
  SUBGRAPH = 'SUBGRAPH',
  TRUE = 'TRUE',
  FALSE = 'FALSE',

  // Literals
  IDENTIFIER = 'IDENTIFIER',
  STRING = 'STRING',
  INTEGER = 'INTEGER',
  FLOAT = 'FLOAT',
  DURATION = 'DURATION',

  // Operators and punctuation
  ARROW = 'ARROW',       // ->
  EQUALS = 'EQUALS',     // =
  LBRACE = 'LBRACE',     // {
  RBRACE = 'RBRACE',     // }
  LBRACKET = 'LBRACKET', // [
  RBRACKET = 'RBRACKET', // ]
  COMMA = 'COMMA',       // ,
  SEMICOLON = 'SEMICOLON', // ;
  DOT = 'DOT',           // .

  // End of input
  EOF = 'EOF',
}

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

// ---------------------------------------------------------------------------
// Keywords map
// ---------------------------------------------------------------------------

const KEYWORDS: Record<string, TokenType> = {
  digraph: TokenType.DIGRAPH,
  graph: TokenType.GRAPH,
  node: TokenType.NODE,
  edge: TokenType.EDGE,
  subgraph: TokenType.SUBGRAPH,
  true: TokenType.TRUE,
  false: TokenType.FALSE,
};

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

export function stripComments(input: string): string {
  let result = '';
  let i = 0;
  let inString = false;

  while (i < input.length) {
    // Handle string literals (don't strip inside strings)
    if (input[i] === '"' && !inString) {
      inString = true;
      result += input[i];
      i++;
      continue;
    }
    if (input[i] === '"' && inString) {
      // Count consecutive backslashes before the quote
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && input[j] === '\\') {
        backslashCount++;
        j--;
      }
      // Only treat as escaped if preceded by an odd number of backslashes
      if (backslashCount % 2 === 1) {
        result += input[i];
        i++;
        continue;
      }
      inString = false;
      result += input[i];
      i++;
      continue;
    }
    if (inString) {
      result += input[i];
      i++;
      continue;
    }

    // Line comment
    if (input[i] === '/' && i + 1 < input.length && input[i + 1] === '/') {
      // Skip to end of line
      while (i < input.length && input[i] !== '\n') {
        i++;
      }
      continue;
    }

    // Block comment
    if (input[i] === '/' && i + 1 < input.length && input[i + 1] === '*') {
      i += 2;
      while (i < input.length) {
        if (input[i] === '*' && i + 1 < input.length && input[i + 1] === '/') {
          i += 2;
          break;
        }
        // Preserve newlines for line counting
        if (input[i] === '\n') {
          result += '\n';
        }
        i++;
      }
      continue;
    }

    result += input[i];
    i++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

export class DotLexer {
  private input: string;
  private pos: number = 0;
  private line: number = 1;
  private column: number = 1;

  constructor(input: string) {
    this.input = stripComments(input);
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];

    while (this.pos < this.input.length) {
      this.skipWhitespace();
      if (this.pos >= this.input.length) break;

      const ch = this.input[this.pos];

      // Single-character tokens
      if (ch === '{') {
        tokens.push(this.makeToken(TokenType.LBRACE, '{'));
        this.advance();
        continue;
      }
      if (ch === '}') {
        tokens.push(this.makeToken(TokenType.RBRACE, '}'));
        this.advance();
        continue;
      }
      if (ch === '[') {
        tokens.push(this.makeToken(TokenType.LBRACKET, '['));
        this.advance();
        continue;
      }
      if (ch === ']') {
        tokens.push(this.makeToken(TokenType.RBRACKET, ']'));
        this.advance();
        continue;
      }
      if (ch === ',') {
        tokens.push(this.makeToken(TokenType.COMMA, ','));
        this.advance();
        continue;
      }
      if (ch === ';') {
        tokens.push(this.makeToken(TokenType.SEMICOLON, ';'));
        this.advance();
        continue;
      }
      if (ch === '=') {
        tokens.push(this.makeToken(TokenType.EQUALS, '='));
        this.advance();
        continue;
      }

      // Arrow operator ->
      if (ch === '-' && this.peek(1) === '>') {
        tokens.push(this.makeToken(TokenType.ARROW, '->'));
        this.advance();
        this.advance();
        continue;
      }

      // Undirected edge -- (rejected)
      if (ch === '-' && this.peek(1) === '-') {
        throw new Error(
          `Lexer error at line ${this.line}, column ${this.column}: ` +
          `Undirected edges (--) are not supported. Use -> for directed edges.`
        );
      }

      // String literal
      if (ch === '"') {
        tokens.push(this.readString());
        continue;
      }

      // Number or negative number or duration
      if (this.isDigit(ch) || (ch === '-' && this.pos + 1 < this.input.length && this.isDigit(this.input[this.pos + 1]))) {
        tokens.push(this.readNumber());
        continue;
      }

      // Dot (qualified ID separator)
      if (ch === '.') {
        tokens.push(this.makeToken(TokenType.DOT, '.'));
        this.advance();
        continue;
      }

      // Identifier or keyword
      if (this.isIdentStart(ch)) {
        tokens.push(this.readIdentifier());
        continue;
      }

      throw new Error(
        `Lexer error at line ${this.line}, column ${this.column}: ` +
        `Unexpected character '${ch}'`
      );
    }

    tokens.push(this.makeToken(TokenType.EOF, ''));
    return tokens;
  }

  private makeToken(type: TokenType, value: string): Token {
    return { type, value, line: this.line, column: this.column };
  }

  private advance(): void {
    if (this.input[this.pos] === '\n') {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    this.pos++;
  }

  private peek(offset: number = 0): string {
    const idx = this.pos + offset;
    if (idx < this.input.length) return this.input[idx];
    return '';
  }

  private skipWhitespace(): void {
    while (this.pos < this.input.length && /\s/.test(this.input[this.pos])) {
      this.advance();
    }
  }

  private isDigit(ch: string): boolean {
    return ch >= '0' && ch <= '9';
  }

  private isIdentStart(ch: string): boolean {
    return /[A-Za-z_]/.test(ch);
  }

  private isIdentChar(ch: string): boolean {
    return /[A-Za-z0-9_]/.test(ch);
  }

  private readString(): Token {
    const startLine = this.line;
    const startCol = this.column;
    this.advance(); // skip opening "

    let value = '';
    while (this.pos < this.input.length && this.input[this.pos] !== '"') {
      if (this.input[this.pos] === '\\') {
        this.advance();
        if (this.pos >= this.input.length) break;
        const escaped = this.input[this.pos];
        switch (escaped) {
          case 'n': value += '\n'; break;
          case 't': value += '\t'; break;
          case '\\': value += '\\'; break;
          case '"': value += '"'; break;
          default: value += '\\' + escaped; break;
        }
        this.advance();
      } else {
        value += this.input[this.pos];
        this.advance();
      }
    }

    if (this.pos >= this.input.length) {
      throw new Error(
        `Lexer error at line ${startLine}, column ${startCol}: Unterminated string literal`
      );
    }

    this.advance(); // skip closing "
    return { type: TokenType.STRING, value, line: startLine, column: startCol };
  }

  private readNumber(): Token {
    const startLine = this.line;
    const startCol = this.column;
    let value = '';
    let isFloat = false;

    // Optional negative sign
    if (this.input[this.pos] === '-') {
      value += '-';
      this.advance();
    }

    // Integer part
    while (this.pos < this.input.length && this.isDigit(this.input[this.pos])) {
      value += this.input[this.pos];
      this.advance();
    }

    // Check for float
    if (this.pos < this.input.length && this.input[this.pos] === '.' &&
        this.pos + 1 < this.input.length && this.isDigit(this.input[this.pos + 1])) {
      isFloat = true;
      value += '.';
      this.advance();
      while (this.pos < this.input.length && this.isDigit(this.input[this.pos])) {
        value += this.input[this.pos];
        this.advance();
      }
    }

    // Check for duration suffix (ms, s, m, h, d)
    if (!isFloat && this.pos < this.input.length) {
      const remaining = this.input.substring(this.pos);
      const durationMatch = remaining.match(/^(ms|[smhd])(?![A-Za-z0-9_])/);
      if (durationMatch) {
        value += durationMatch[1];
        for (let i = 0; i < durationMatch[1].length; i++) {
          this.advance();
        }
        return { type: TokenType.DURATION, value, line: startLine, column: startCol };
      }
    }

    return {
      type: isFloat ? TokenType.FLOAT : TokenType.INTEGER,
      value,
      line: startLine,
      column: startCol,
    };
  }

  private readIdentifier(): Token {
    const startLine = this.line;
    const startCol = this.column;
    let value = '';

    while (this.pos < this.input.length && this.isIdentChar(this.input[this.pos])) {
      value += this.input[this.pos];
      this.advance();
    }

    // Check for keywords (case-insensitive for DOT keywords)
    const lower = value.toLowerCase();
    if (lower in KEYWORDS) {
      return { type: KEYWORDS[lower], value, line: startLine, column: startCol };
    }

    return { type: TokenType.IDENTIFIER, value, line: startLine, column: startCol };
  }
}
