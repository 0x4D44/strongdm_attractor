/**
 * AST transforms: modify the pipeline graph between parsing and validation.
 * Built-in transforms: variable expansion, stylesheet application.
 */

import type { Graph, Transform } from './types.js';
import { applyStylesheet } from './stylesheet.js';

// ---------------------------------------------------------------------------
// Variable Expansion Transform
// ---------------------------------------------------------------------------

/**
 * Expands $goal in node prompt attributes to the graph-level goal attribute.
 */
export class VariableExpansionTransform implements Transform {
  apply(graph: Graph): Graph {
    const goal = graph.attrs.goal || '';

    for (const [_id, node] of graph.nodes) {
      if (node.attrs.prompt && node.attrs.prompt.includes('$goal')) {
        node.attrs.prompt = node.attrs.prompt.replace(/\$goal/g, goal);
      }
    }

    return graph;
  }
}

// ---------------------------------------------------------------------------
// Stylesheet Application Transform
// ---------------------------------------------------------------------------

/**
 * Applies the model_stylesheet to resolve llm_model, llm_provider,
 * and reasoning_effort for each node.
 */
export class StylesheetTransform implements Transform {
  apply(graph: Graph): Graph {
    return applyStylesheet(graph);
  }
}

// ---------------------------------------------------------------------------
// Transform Pipeline
// ---------------------------------------------------------------------------

/**
 * Applies a sequence of transforms to a graph.
 * Built-in transforms are applied first, then custom transforms.
 */
export function applyTransforms(
  graph: Graph,
  customTransforms: Transform[] = [],
): Graph {
  // Built-in transforms in order
  const builtInTransforms: Transform[] = [
    new StylesheetTransform(),
    new VariableExpansionTransform(),
  ];

  let result = graph;
  for (const transform of [...builtInTransforms, ...customTransforms]) {
    result = transform.apply(result);
  }

  return result;
}
