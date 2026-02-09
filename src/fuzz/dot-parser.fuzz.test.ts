/**
 * Property-based / fuzz tests for the DOT Parser.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { DotParser, parseDot } from '../attractor/parser/dot-parser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParse(input: string): ReturnType<DotParser['parse']> | null {
  try {
    return parseDot(input);
  } catch (e: unknown) {
    if (e instanceof Error) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Arbitrary generators for structurally valid DOT
// ---------------------------------------------------------------------------

const RESERVED = ['digraph', 'graph', 'node', 'edge', 'subgraph', 'true', 'false'];

/** Simple identifier (lowercase only, avoids reserved words). */
const arbNodeId = fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 1, maxLength: 8 })
  .map(arr => arr.join(''))
  .filter(s => !RESERVED.includes(s));

/** Graph name. */
const arbGraphName = fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 1, maxLength: 10 })
  .map(arr => arr.join(''))
  .filter(s => !RESERVED.includes(s));

/** Single attribute pair. */
const arbAttr = fc.tuple(
  fc.constantFrom('label', 'shape', 'prompt', 'type', 'fidelity'),
  fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789 '.split('')), { minLength: 1, maxLength: 15 })
    .map(arr => arr.join('')),
).map(([k, v]) => `${k}="${v.replace(/"/g, '')}"`);

/** Attribute block. */
const arbAttrBlock = fc.array(arbAttr, { minLength: 0, maxLength: 3 }).map(attrs =>
  attrs.length > 0 ? ` [${attrs.join(', ')}]` : '',
);

/** Node declaration. */
const arbNodeDecl = fc.tuple(arbNodeId, arbAttrBlock).map(([id, attrs]) => `  ${id}${attrs};`);

/** Edge declaration. */
const arbEdgeDecl = fc.tuple(
  fc.array(arbNodeId, { minLength: 2, maxLength: 4 }),
  arbAttrBlock,
).map(([ids, attrs]) => `  ${ids.join(' -> ')}${attrs};`);

/** A statement (node or edge). */
const arbStatement = fc.oneof(arbNodeDecl, arbEdgeDecl);

/** A complete valid digraph. */
const arbDigraph = fc.tuple(
  arbGraphName,
  fc.array(arbStatement, { minLength: 1, maxLength: 10 }),
).map(([name, stmts]) => `digraph ${name} {\n${stmts.join('\n')}\n}`);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DotParser fuzz tests', () => {
  it('never crashes on arbitrary input (throws clean Error or returns Graph)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 500 }), (input) => {
        try {
          parseDot(input);
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('valid digraphs always produce a Graph with at least one node', () => {
    fc.assert(
      fc.property(arbDigraph, (dot) => {
        const graph = parseDot(dot);
        expect(graph).toBeDefined();
        expect(graph.nodes.size).toBeGreaterThanOrEqual(1);
        expect(graph.edges).toBeInstanceOf(Array);
        expect(typeof graph.name).toBe('string');
        expect(graph.name.length).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });

  it('all edges reference nodes that exist in the graph', () => {
    fc.assert(
      fc.property(arbDigraph, (dot) => {
        const graph = parseDot(dot);
        for (const edge of graph.edges) {
          expect(graph.nodes.has(edge.from)).toBe(true);
          expect(graph.nodes.has(edge.to)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('node IDs in the map match the node.id property', () => {
    fc.assert(
      fc.property(arbDigraph, (dot) => {
        const graph = parseDot(dot);
        for (const [id, node] of graph.nodes) {
          expect(node.id).toBe(id);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('every node has a non-empty label (defaulting to node ID)', () => {
    fc.assert(
      fc.property(arbDigraph, (dot) => {
        const graph = parseDot(dot);
        for (const [id, node] of graph.nodes) {
          expect(node.attrs.label.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('parsing a digraph with graph attributes preserves them', () => {
    fc.assert(
      fc.property(
        arbGraphName,
        fc.string({ minLength: 1, maxLength: 30 }).filter(s => !s.includes('"') && !s.includes('\\')),
        (name, goal) => {
          const dot = `digraph ${name} {\n  goal="${goal}"\n  start [shape=Mdiamond]\n}`;
          const graph = safeParse(dot);
          if (graph) {
            expect(graph.attrs.goal).toBe(goal);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('edge chain A -> B -> C creates N-1 edges', () => {
    fc.assert(
      fc.property(
        arbGraphName,
        fc.array(arbNodeId, { minLength: 2, maxLength: 6 }).filter(ids => new Set(ids).size === ids.length),
        (name, ids) => {
          const chain = ids.join(' -> ');
          const dot = `digraph ${name} {\n  ${chain};\n}`;
          const graph = safeParse(dot);
          if (graph) {
            expect(graph.edges.length).toBe(ids.length - 1);
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
          parseDot(input);
        } catch {
          // Errors are fine
        }
      }),
      { numRuns: 200 },
    );
  });

  it('subgraph parsing produces nodes with class attributes', () => {
    fc.assert(
      fc.property(
        arbGraphName,
        arbNodeId,
        fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 1, maxLength: 10 })
          .map(arr => arr.join('')),
        (name, nodeId, label) => {
          const dot = `digraph ${name} {
  subgraph cluster_test {
    label="${label}"
    ${nodeId} [shape=box]
  }
}`;
          const graph = safeParse(dot);
          if (graph) {
            const node = graph.nodes.get(nodeId);
            if (node) {
              expect(typeof node.attrs.class).toBe('string');
            }
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
