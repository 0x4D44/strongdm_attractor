/**
 * Start handler: no-op entry point. Returns SUCCESS immediately.
 */

import type { NodeHandler, Node, PipelineContext, Graph, Outcome } from '../types.js';
import { StageStatus, makeOutcome } from '../types.js';

export class StartHandler implements NodeHandler {
  async handle(
    _node: Node,
    _context: PipelineContext,
    _graph: Graph,
    _logsRoot: string,
  ): Promise<Outcome> {
    return makeOutcome({ status: StageStatus.SUCCESS });
  }
}
