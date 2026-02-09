/**
 * Fan-in handler: consolidates results from a preceding parallel node.
 * Selects the best candidate by outcome status.
 */

import type { NodeHandler, Node, PipelineContext, Graph, Outcome } from '../types.js';
import { StageStatus, makeOutcome } from '../types.js';

interface BranchResult {
  branch: string;
  outcome: string;
  notes?: string;
  score?: number;
}

export class FanInHandler implements NodeHandler {
  async handle(
    node: Node,
    context: PipelineContext,
    _graph: Graph,
    _logsRoot: string,
  ): Promise<Outcome> {
    // 1. Read parallel results
    const rawResults = context.getString('parallel.results', '');
    if (!rawResults) {
      return makeOutcome({
        status: StageStatus.FAIL,
        failure_reason: 'No parallel results to evaluate',
      });
    }

    let results: BranchResult[];
    try {
      results = JSON.parse(rawResults) as BranchResult[];
    } catch {
      return makeOutcome({
        status: StageStatus.FAIL,
        failure_reason: 'Failed to parse parallel results',
      });
    }

    if (results.length === 0) {
      return makeOutcome({
        status: StageStatus.FAIL,
        failure_reason: 'No parallel results to evaluate',
      });
    }

    // 2. Heuristic selection: rank by outcome status, then score, then ID
    const outcomeRank: Record<string, number> = {
      [StageStatus.SUCCESS]: 0,
      [StageStatus.PARTIAL_SUCCESS]: 1,
      [StageStatus.RETRY]: 2,
      [StageStatus.FAIL]: 3,
    };

    const sorted = [...results].sort((a, b) => {
      const rankA = outcomeRank[a.outcome] ?? 3;
      const rankB = outcomeRank[b.outcome] ?? 3;
      if (rankA !== rankB) return rankA - rankB;
      // Higher score wins
      const scoreA = a.score ?? 0;
      const scoreB = b.score ?? 0;
      if (scoreA !== scoreB) return scoreB - scoreA;
      // Lexical tiebreak
      return a.branch.localeCompare(b.branch);
    });

    const best = sorted[0];

    // 3. Check if all candidates failed
    const allFailed = results.every(r => r.outcome === StageStatus.FAIL);
    if (allFailed) {
      return makeOutcome({
        status: StageStatus.FAIL,
        failure_reason: 'All parallel branches failed',
      });
    }

    // 4. Record winner in context
    return makeOutcome({
      status: StageStatus.SUCCESS,
      context_updates: {
        'parallel.fan_in.best_id': best.branch,
        'parallel.fan_in.best_outcome': best.outcome,
      },
      notes: `Selected best candidate: ${best.branch}`,
    });
  }
}
