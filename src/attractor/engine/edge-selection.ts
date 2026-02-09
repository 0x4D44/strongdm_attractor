/**
 * Edge selection algorithm: deterministic 5-step priority for choosing next edge.
 * 1. Condition match
 * 2. Preferred label
 * 3. Suggested next IDs
 * 4. Highest weight
 * 5. Lexical tiebreak
 */

import type { Edge, Outcome, PipelineContext, Graph } from '../types.js';
import { evaluateCondition } from '../conditions.js';

// ---------------------------------------------------------------------------
// Label Normalization
// ---------------------------------------------------------------------------

export function normalizeLabel(label: string): string {
  let normalized = label.toLowerCase().trim();

  // Strip accelerator prefixes:
  // [K] Label -> Label
  // K) Label -> Label
  // K - Label -> Label
  normalized = normalized.replace(/^\[[^\]]+\]\s*/, '');
  normalized = normalized.replace(/^[a-z0-9]\)\s*/i, '');
  normalized = normalized.replace(/^[a-z0-9]\s*-\s*/i, '');

  return normalized.trim();
}

// ---------------------------------------------------------------------------
// Weight + Lexical Sorting
// ---------------------------------------------------------------------------

function bestByWeightThenLexical(edges: Edge[]): Edge | undefined {
  if (edges.length === 0) return undefined;

  const sorted = [...edges].sort((a, b) => {
    // Higher weight first
    if (b.attrs.weight !== a.attrs.weight) {
      return b.attrs.weight - a.attrs.weight;
    }
    // Lexical by target node ID (ascending)
    return a.to.localeCompare(b.to);
  });

  return sorted[0];
}

// ---------------------------------------------------------------------------
// Edge Selection
// ---------------------------------------------------------------------------

export function selectEdge(
  nodeId: string,
  outcome: Outcome,
  context: PipelineContext,
  graph: Graph,
): Edge | undefined {
  // Get all outgoing edges from the current node
  const edges = graph.edges.filter(e => e.from === nodeId);
  if (edges.length === 0) return undefined;

  // Step 1: Condition matching
  const conditionMatched: Edge[] = [];
  for (const edge of edges) {
    if (edge.attrs.condition) {
      if (evaluateCondition(edge.attrs.condition, outcome, context)) {
        conditionMatched.push(edge);
      }
    }
  }
  if (conditionMatched.length > 0) {
    return bestByWeightThenLexical(conditionMatched);
  }

  // Step 2: Preferred label
  if (outcome.preferred_label) {
    const normalizedPreferred = normalizeLabel(outcome.preferred_label);
    for (const edge of edges) {
      if (edge.attrs.label && normalizeLabel(edge.attrs.label) === normalizedPreferred) {
        return edge;
      }
    }
  }

  // Step 3: Suggested next IDs
  if (outcome.suggested_next_ids && outcome.suggested_next_ids.length > 0) {
    for (const suggestedId of outcome.suggested_next_ids) {
      for (const edge of edges) {
        if (edge.to === suggestedId) {
          return edge;
        }
      }
    }
  }

  // Step 4 & 5: Weight with lexical tiebreak (unconditional edges only)
  const unconditional = edges.filter(e => !e.attrs.condition);
  if (unconditional.length > 0) {
    return bestByWeightThenLexical(unconditional);
  }

  // Fallback: any edge
  return bestByWeightThenLexical(edges);
}
