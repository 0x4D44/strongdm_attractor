/**
 * Conditional handler: pass-through node.
 * The actual routing logic is handled by the engine's edge selection algorithm.
 */

import type { NodeHandler, Node, PipelineContext, Graph, Outcome } from '../types.js';
import { StageStatus, makeOutcome } from '../types.js';

export class ConditionalHandler implements NodeHandler {
  async handle(
    node: Node,
    _context: PipelineContext,
    _graph: Graph,
    _logsRoot: string,
  ): Promise<Outcome> {
    return makeOutcome({
      status: StageStatus.SUCCESS,
      notes: `Conditional node evaluated: ${node.id}`,
    });
  }
}
