/**
 * Exit handler: no-op exit point. Returns SUCCESS immediately.
 * Goal gate enforcement is handled by the pipeline engine.
 */

import type { NodeHandler, Node, PipelineContext, Graph, Outcome } from '../types.js';
import { StageStatus, makeOutcome } from '../types.js';

export class ExitHandler implements NodeHandler {
  async handle(
    _node: Node,
    _context: PipelineContext,
    _graph: Graph,
    _logsRoot: string,
  ): Promise<Outcome> {
    return makeOutcome({ status: StageStatus.SUCCESS });
  }
}
