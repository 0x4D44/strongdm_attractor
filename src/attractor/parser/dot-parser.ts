/**
 * DOT parser: recursive descent parser producing a Graph AST.
 * Parses the strict DOT subset defined by the Attractor spec.
 */

import { DotLexer, TokenType } from './dot-lexer.js';
import type { Token } from './dot-lexer.js';
import type {
  Graph,
  Node,
  Edge,
  GraphAttributes,
  NodeAttributes,
  EdgeAttributes,
} from '../types.js';
import {
  DEFAULT_GRAPH_ATTRIBUTES,
  DEFAULT_NODE_ATTRIBUTES,
  DEFAULT_EDGE_ATTRIBUTES,
} from '../types.js';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export class DotParser {
  private tokens: Token[] = [];
  private pos: number = 0;

  parse(input: string): Graph {
    const lexer = new DotLexer(input);
    this.tokens = lexer.tokenize();
    this.pos = 0;

    return this.parseGraph();
  }

  // -----------------------------------------------------------------------
  // Grammar: Graph ::= 'digraph' Identifier '{' Statement* '}'
  // -----------------------------------------------------------------------

  private parseGraph(): Graph {
    this.expect(TokenType.DIGRAPH);
    const name = this.expectIdentifierOrString();
    this.expect(TokenType.LBRACE);

    const graph: Graph = {
      name,
      attrs: { ...DEFAULT_GRAPH_ATTRIBUTES },
      nodes: new Map(),
      edges: [],
    };

    const nodeDefaults: Partial<NodeAttributes> = {};
    const edgeDefaults: Partial<EdgeAttributes> = {};

    this.parseStatements(graph, nodeDefaults, edgeDefaults, null);

    this.expect(TokenType.RBRACE);

    // Ensure trailing EOF
    if (this.current().type !== TokenType.EOF) {
      throw this.error('Expected end of input after closing brace');
    }

    // Set labels to node IDs for nodes with empty labels
    for (const [id, node] of graph.nodes) {
      if (!node.attrs.label) {
        node.attrs.label = id;
      }
    }

    return graph;
  }

  // -----------------------------------------------------------------------
  // Statements
  // -----------------------------------------------------------------------

  private parseStatements(
    graph: Graph,
    nodeDefaults: Partial<NodeAttributes>,
    edgeDefaults: Partial<EdgeAttributes>,
    subgraphClasses: string[] | null,
  ): void {
    while (this.current().type !== TokenType.RBRACE && this.current().type !== TokenType.EOF) {
      this.parseStatement(graph, nodeDefaults, edgeDefaults, subgraphClasses);
      this.consumeOptional(TokenType.SEMICOLON);
    }
  }

  private parseStatement(
    graph: Graph,
    nodeDefaults: Partial<NodeAttributes>,
    edgeDefaults: Partial<EdgeAttributes>,
    subgraphClasses: string[] | null,
  ): void {
    const tok = this.current();

    // graph [ ... ]
    if (tok.type === TokenType.GRAPH && this.peek().type === TokenType.LBRACKET) {
      this.advance(); // consume 'graph'
      const attrs = this.parseAttrBlock();
      this.mergeGraphAttrs(graph.attrs, attrs);
      return;
    }

    // node [ ... ]
    if (tok.type === TokenType.NODE && this.peek().type === TokenType.LBRACKET) {
      this.advance(); // consume 'node'
      const attrs = this.parseAttrBlock();
      Object.assign(nodeDefaults, attrs);
      return;
    }

    // edge [ ... ]
    if (tok.type === TokenType.EDGE && this.peek().type === TokenType.LBRACKET) {
      this.advance(); // consume 'edge'
      const attrs = this.parseAttrBlock();
      Object.assign(edgeDefaults, attrs);
      return;
    }

    // subgraph
    if (tok.type === TokenType.SUBGRAPH) {
      this.parseSubgraph(graph, nodeDefaults, edgeDefaults, subgraphClasses);
      return;
    }

    // Top-level graph attribute declaration: key = value (not followed by -> or [)
    if (this.isIdentifierLike(tok) && this.peek().type === TokenType.EQUALS) {
      // Check it's not a node followed by attributes: after '= value' there shouldn't be '->'
      const savedPos = this.pos;
      const key = this.consumeIdentifier();
      this.expect(TokenType.EQUALS);
      const value = this.consumeValue();

      // It's a graph attribute declaration
      this.setGraphAttr(graph.attrs, key, value);
      return;
    }

    // Node or edge statement: starts with an identifier
    if (this.isIdentifierLike(tok)) {
      this.parseNodeOrEdgeStatement(graph, nodeDefaults, edgeDefaults, subgraphClasses);
      return;
    }

    throw this.error(`Unexpected token: ${tok.type} (${tok.value})`);
  }

  // -----------------------------------------------------------------------
  // Node or Edge Statement
  // -----------------------------------------------------------------------

  private parseNodeOrEdgeStatement(
    graph: Graph,
    nodeDefaults: Partial<NodeAttributes>,
    edgeDefaults: Partial<EdgeAttributes>,
    subgraphClasses: string[] | null,
  ): void {
    const firstId = this.consumeIdentifier();

    // Is it an edge chain? A -> B -> C [...]
    if (this.current().type === TokenType.ARROW) {
      const chain = [firstId];
      while (this.current().type === TokenType.ARROW) {
        this.advance(); // consume ->
        chain.push(this.consumeIdentifier());
      }

      // Optional attr block for the entire chain
      let edgeAttrs: Record<string, string> = {};
      if (this.current().type === TokenType.LBRACKET) {
        edgeAttrs = this.parseAttrBlock();
      }

      // Create edges for each pair in the chain
      for (let i = 0; i < chain.length - 1; i++) {
        const from = chain[i];
        const to = chain[i + 1];

        // Ensure both nodes exist
        this.ensureNode(graph, from, nodeDefaults, subgraphClasses);
        this.ensureNode(graph, to, nodeDefaults, subgraphClasses);

        const attrs = this.buildEdgeAttributes(edgeDefaults, edgeAttrs);
        graph.edges.push({ from, to, attrs });
      }
      return;
    }

    // Node statement: ID [attrs]
    let nodeAttrs: Record<string, string> = {};
    if (this.current().type === TokenType.LBRACKET) {
      nodeAttrs = this.parseAttrBlock();
    }

    this.ensureNode(graph, firstId, nodeDefaults, subgraphClasses, nodeAttrs);
  }

  // -----------------------------------------------------------------------
  // Subgraph
  // -----------------------------------------------------------------------

  private parseSubgraph(
    graph: Graph,
    parentNodeDefaults: Partial<NodeAttributes>,
    parentEdgeDefaults: Partial<EdgeAttributes>,
    parentClasses: string[] | null,
  ): void {
    this.expect(TokenType.SUBGRAPH);

    // Optional subgraph name
    let subgraphName = '';
    if (this.isIdentifierLike(this.current())) {
      subgraphName = this.consumeIdentifier();
    }

    this.expect(TokenType.LBRACE);

    // Inherit parent defaults
    const localNodeDefaults: Partial<NodeAttributes> = { ...parentNodeDefaults };
    const localEdgeDefaults: Partial<EdgeAttributes> = { ...parentEdgeDefaults };

    // Two-pass approach: first scan for the subgraph label, then parse all statements.
    // This ensures class derivation is not order-dependent.
    const bodyStart = this.pos;
    let subgraphLabel = '';

    // Pass 1: Scan for label declarations
    let braceDepth = 0;
    while (this.current().type !== TokenType.EOF) {
      if (this.current().type === TokenType.LBRACE) {
        braceDepth++;
        this.advance();
        continue;
      }
      if (this.current().type === TokenType.RBRACE) {
        if (braceDepth === 0) break;
        braceDepth--;
        this.advance();
        continue;
      }
      if (braceDepth > 0) {
        this.advance();
        continue;
      }

      // Check for graph [label=...] inside subgraph
      if (this.current().type === TokenType.GRAPH && this.peek().type === TokenType.LBRACKET) {
        this.advance();
        const attrs = this.parseAttrBlock();
        if (attrs['label']) {
          subgraphLabel = attrs['label'];
        }
        this.consumeOptional(TokenType.SEMICOLON);
        continue;
      }

      // Check for bare label = "..." at subgraph level
      if (this.isIdentifierLike(this.current()) && this.current().value === 'label' &&
          this.peek().type === TokenType.EQUALS) {
        this.advance(); // skip label
        this.advance(); // skip =
        subgraphLabel = this.consumeValue();
        this.consumeOptional(TokenType.SEMICOLON);
        continue;
      }

      this.advance();
    }

    // Pass 2: Rewind and parse all statements with the derived class known
    this.pos = bodyStart;
    const derivedClasses = parentClasses ? [...parentClasses] : [];
    if (subgraphLabel) {
      derivedClasses.push(this.deriveClassName(subgraphLabel));
    }

    while (this.current().type !== TokenType.RBRACE && this.current().type !== TokenType.EOF) {
      // Skip label declarations that were already processed
      if (this.current().type === TokenType.GRAPH && this.peek().type === TokenType.LBRACKET) {
        this.advance();
        this.parseAttrBlock(); // consume but don't re-apply
        this.consumeOptional(TokenType.SEMICOLON);
        continue;
      }
      if (this.isIdentifierLike(this.current()) && this.current().value === 'label' &&
          this.peek().type === TokenType.EQUALS) {
        this.advance(); // skip label
        this.advance(); // skip =
        this.consumeValue(); // consume but don't re-apply
        this.consumeOptional(TokenType.SEMICOLON);
        continue;
      }

      this.parseStatement(graph, localNodeDefaults, localEdgeDefaults, derivedClasses);
      this.consumeOptional(TokenType.SEMICOLON);
    }

    this.expect(TokenType.RBRACE);
  }

  // -----------------------------------------------------------------------
  // Attribute Block: '[' attr (',' attr)* ']'
  // -----------------------------------------------------------------------

  private parseAttrBlock(): Record<string, string> {
    this.expect(TokenType.LBRACKET);
    const attrs: Record<string, string> = {};

    while (this.current().type !== TokenType.RBRACKET && this.current().type !== TokenType.EOF) {
      const key = this.consumeQualifiedId();
      this.expect(TokenType.EQUALS);
      const value = this.consumeValue();
      attrs[key] = value;

      // Comma or semicolon separator (both accepted)
      if (this.current().type === TokenType.COMMA || this.current().type === TokenType.SEMICOLON) {
        this.advance();
      }
    }

    this.expect(TokenType.RBRACKET);
    return attrs;
  }

  // -----------------------------------------------------------------------
  // Qualified ID: identifier ('.' identifier)*
  // -----------------------------------------------------------------------

  private consumeQualifiedId(): string {
    let id = this.consumeIdentifier();
    while (this.current().type === TokenType.DOT) {
      this.advance(); // consume dot
      id += '.' + this.consumeIdentifier();
    }
    return id;
  }

  // -----------------------------------------------------------------------
  // Value consumption
  // -----------------------------------------------------------------------

  private consumeValue(): string {
    const tok = this.current();

    if (tok.type === TokenType.STRING) {
      this.advance();
      return tok.value;
    }
    if (tok.type === TokenType.INTEGER || tok.type === TokenType.FLOAT || tok.type === TokenType.DURATION) {
      this.advance();
      return tok.value;
    }
    if (tok.type === TokenType.TRUE) {
      this.advance();
      return 'true';
    }
    if (tok.type === TokenType.FALSE) {
      this.advance();
      return 'false';
    }
    if (tok.type === TokenType.IDENTIFIER) {
      this.advance();
      return tok.value;
    }

    throw this.error(`Expected a value, got ${tok.type} (${tok.value})`);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private ensureNode(
    graph: Graph,
    id: string,
    defaults: Partial<NodeAttributes>,
    subgraphClasses: string[] | null,
    explicitAttrs?: Record<string, string>,
  ): void {
    if (!graph.nodes.has(id)) {
      // Build node attributes from defaults + explicit
      const attrs = this.buildNodeAttributes(defaults, explicitAttrs || {}, subgraphClasses);
      graph.nodes.set(id, { id, attrs });
    } else if (explicitAttrs && Object.keys(explicitAttrs).length > 0) {
      // Merge explicit attrs into existing node
      const node = graph.nodes.get(id)!;
      const merged = this.buildNodeAttributes(defaults, explicitAttrs, subgraphClasses);
      // Explicit attrs override, but keep existing attrs that aren't in the new set
      for (const [key, val] of Object.entries(merged)) {
        if (key in explicitAttrs) {
          (node.attrs as Record<string, unknown>)[key] = val;
        } else if (!(key in node.attrs) || (node.attrs as Record<string, unknown>)[key] === (DEFAULT_NODE_ATTRIBUTES as Record<string, unknown>)[key]) {
          (node.attrs as Record<string, unknown>)[key] = val;
        }
      }
    }
  }

  private buildNodeAttributes(
    defaults: Partial<NodeAttributes>,
    explicit: Record<string, string>,
    subgraphClasses: string[] | null,
  ): NodeAttributes {
    const attrs: NodeAttributes = { ...DEFAULT_NODE_ATTRIBUTES };

    // Apply defaults
    for (const [key, val] of Object.entries(defaults)) {
      if (val !== undefined) {
        this.setNodeAttr(attrs, key, String(val));
      }
    }

    // Apply explicit attributes
    for (const [key, val] of Object.entries(explicit)) {
      this.setNodeAttr(attrs, key, val);
    }

    // Merge subgraph-derived classes
    if (subgraphClasses && subgraphClasses.length > 0) {
      const existingClasses = attrs.class ? attrs.class.split(',').map(c => c.trim()) : [];
      const allClasses = [...new Set([...existingClasses, ...subgraphClasses])].filter(Boolean);
      attrs.class = allClasses.join(',');
    }

    return attrs;
  }

  private buildEdgeAttributes(
    defaults: Partial<EdgeAttributes>,
    explicit: Record<string, string>,
  ): EdgeAttributes {
    const attrs: EdgeAttributes = { ...DEFAULT_EDGE_ATTRIBUTES };

    // Apply defaults
    for (const [key, val] of Object.entries(defaults)) {
      if (val !== undefined) {
        this.setEdgeAttr(attrs, key, String(val));
      }
    }

    // Apply explicit
    for (const [key, val] of Object.entries(explicit)) {
      this.setEdgeAttr(attrs, key, val);
    }

    return attrs;
  }

  private setNodeAttr(attrs: NodeAttributes, key: string, value: string): void {
    switch (key) {
      case 'label': attrs.label = value; break;
      case 'shape': attrs.shape = value; break;
      case 'type': attrs.type = value; break;
      case 'prompt': attrs.prompt = value; break;
      case 'max_retries': attrs.max_retries = parseInt(value, 10) || 0; break;
      case 'goal_gate': attrs.goal_gate = value === 'true'; break;
      case 'retry_target': attrs.retry_target = value; break;
      case 'fallback_retry_target': attrs.fallback_retry_target = value; break;
      case 'fidelity': attrs.fidelity = value; break;
      case 'thread_id': attrs.thread_id = value; break;
      case 'class': attrs.class = value; break;
      case 'timeout': attrs.timeout = value; break;
      case 'llm_model': attrs.llm_model = value; break;
      case 'llm_provider': attrs.llm_provider = value; break;
      case 'reasoning_effort': attrs.reasoning_effort = value; break;
      case 'auto_status': attrs.auto_status = value === 'true'; break;
      case 'allow_partial': attrs.allow_partial = value === 'true'; break;
      default:
        // Store arbitrary attributes
        (attrs as Record<string, unknown>)[key] = value;
        break;
    }
  }

  private setEdgeAttr(attrs: EdgeAttributes, key: string, value: string): void {
    switch (key) {
      case 'label': attrs.label = value; break;
      case 'condition': attrs.condition = value; break;
      case 'weight': attrs.weight = parseInt(value, 10) || 0; break;
      case 'fidelity': attrs.fidelity = value; break;
      case 'thread_id': attrs.thread_id = value; break;
      case 'loop_restart': attrs.loop_restart = value === 'true'; break;
      default:
        (attrs as Record<string, unknown>)[key] = value;
        break;
    }
  }

  private mergeGraphAttrs(attrs: GraphAttributes, raw: Record<string, string>): void {
    for (const [key, value] of Object.entries(raw)) {
      this.setGraphAttr(attrs, key, value);
    }
  }

  private setGraphAttr(attrs: GraphAttributes, key: string, value: string): void {
    switch (key) {
      case 'goal': attrs.goal = value; break;
      case 'label': attrs.label = value; break;
      case 'model_stylesheet': attrs.model_stylesheet = value; break;
      case 'default_max_retry': attrs.default_max_retry = parseInt(value, 10) || 50; break;
      case 'retry_target': attrs.retry_target = value; break;
      case 'fallback_retry_target': attrs.fallback_retry_target = value; break;
      case 'default_fidelity': attrs.default_fidelity = value; break;
      default:
        (attrs as Record<string, unknown>)[key] = value;
        break;
    }
  }

  private deriveClassName(label: string): string {
    return label
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
  }

  private isIdentifierLike(tok: Token): boolean {
    return tok.type === TokenType.IDENTIFIER ||
           tok.type === TokenType.GRAPH ||
           tok.type === TokenType.NODE ||
           tok.type === TokenType.EDGE;
  }

  private consumeIdentifier(): string {
    const tok = this.current();
    // Allow keywords as identifiers in node/edge contexts
    if (tok.type === TokenType.IDENTIFIER ||
        tok.type === TokenType.GRAPH ||
        tok.type === TokenType.NODE ||
        tok.type === TokenType.EDGE ||
        tok.type === TokenType.SUBGRAPH) {
      this.advance();
      return tok.value;
    }
    throw this.error(`Expected identifier, got ${tok.type} (${tok.value})`);
  }

  private expectIdentifierOrString(): string {
    const tok = this.current();
    if (tok.type === TokenType.IDENTIFIER || tok.type === TokenType.STRING) {
      this.advance();
      return tok.value;
    }
    // Allow DOT keywords as graph names
    if (this.isIdentifierLike(tok)) {
      this.advance();
      return tok.value;
    }
    throw this.error(`Expected identifier or string, got ${tok.type}`);
  }

  private expect(type: TokenType): Token {
    const tok = this.current();
    if (tok.type !== type) {
      throw this.error(`Expected ${type}, got ${tok.type} (${tok.value})`);
    }
    this.advance();
    return tok;
  }

  private consumeOptional(type: TokenType): boolean {
    if (this.current().type === type) {
      this.advance();
      return true;
    }
    return false;
  }

  private current(): Token {
    return this.tokens[this.pos] || { type: TokenType.EOF, value: '', line: 0, column: 0 };
  }

  private peek(): Token {
    return this.tokens[this.pos + 1] || { type: TokenType.EOF, value: '', line: 0, column: 0 };
  }

  private advance(): void {
    this.pos++;
  }

  private error(message: string): Error {
    const tok = this.current();
    return new Error(`Parse error at line ${tok.line}, column ${tok.column}: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseDot(input: string): Graph {
  const parser = new DotParser();
  return parser.parse(input);
}
