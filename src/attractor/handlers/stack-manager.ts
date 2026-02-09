/**
 * Stack manager handler: supervisor loop for child pipelines.
 * Orchestrates observe/steer/wait cycles over a child pipeline.
 */

import type { NodeHandler, Node, PipelineContext, Graph, Outcome } from '../types.js';
import { StageStatus, makeOutcome } from '../types.js';
import { evaluateCondition } from '../conditions.js';
import { parseDuration } from '../utils.js';

export class StackManagerHandler implements NodeHandler {
  async handle(
    node: Node,
    context: PipelineContext,
    graph: Graph,
    _logsRoot: string,
  ): Promise<Outcome> {
    const pollIntervalStr = String(
      (node.attrs as Record<string, unknown>)['manager.poll_interval'] ?? '45s'
    );
    const pollInterval = parseDuration(pollIntervalStr);
    const maxCycles = parseInt(
      String((node.attrs as Record<string, unknown>)['manager.max_cycles'] ?? '1000'), 10
    );
    const stopCondition = String(
      (node.attrs as Record<string, unknown>)['manager.stop_condition'] ?? ''
    );
    const actionsStr = String(
      (node.attrs as Record<string, unknown>)['manager.actions'] ?? 'observe,wait'
    );
    const actions = actionsStr.split(',').map(a => a.trim());

    // Observation loop
    for (let cycle = 1; cycle <= maxCycles; cycle++) {
      // Observe
      if (actions.includes('observe')) {
        // Ingest child telemetry (in real impl, would read from child pipeline)
        // For now, check context for child status
      }

      // Check child status
      const childStatus = context.getString('context.stack.child.status', '');
      if (childStatus === 'completed' || childStatus === 'failed') {
        const childOutcome = context.getString('context.stack.child.outcome', '');
        if (childOutcome === 'success') {
          return makeOutcome({
            status: StageStatus.SUCCESS,
            notes: 'Child completed successfully',
          });
        }
        if (childStatus === 'failed') {
          return makeOutcome({
            status: StageStatus.FAIL,
            failure_reason: 'Child pipeline failed',
          });
        }
      }

      // Evaluate stop condition
      if (stopCondition) {
        const dummyOutcome = makeOutcome({ status: StageStatus.SUCCESS });
        if (evaluateCondition(stopCondition, dummyOutcome, context)) {
          return makeOutcome({
            status: StageStatus.SUCCESS,
            notes: 'Stop condition satisfied',
          });
        }
      }

      // Wait
      if (actions.includes('wait')) {
        await sleep(pollInterval);
      } else {
        // At least yield to prevent blocking
        await sleep(0);
      }
    }

    return makeOutcome({
      status: StageStatus.FAIL,
      failure_reason: 'Max cycles exceeded',
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
