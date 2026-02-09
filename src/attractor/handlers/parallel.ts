/**
 * Parallel handler: fans out execution to multiple target nodes concurrently.
 * Each branch receives an isolated clone of the context.
 */

import type { NodeHandler, Node, PipelineContext, Graph, Outcome } from '../types.js';
import { StageStatus, makeOutcome } from '../types.js';

// Type for the subgraph executor function injected by the engine
export type SubgraphExecutor = (
  nodeId: string,
  context: PipelineContext,
  graph: Graph,
  logsRoot: string,
) => Promise<Outcome>;

export class ParallelHandler implements NodeHandler {
  private executor: SubgraphExecutor | null;

  constructor(executor: SubgraphExecutor | null = null) {
    this.executor = executor;
  }

  async handle(
    node: Node,
    context: PipelineContext,
    graph: Graph,
    logsRoot: string,
  ): Promise<Outcome> {
    // 1. Identify fan-out edges
    const branches = graph.edges.filter(e => e.from === node.id);

    if (branches.length === 0) {
      return makeOutcome({
        status: StageStatus.FAIL,
        failure_reason: 'No outgoing edges for parallel node',
      });
    }

    // 2. Determine policies from node attributes
    const joinPolicy = String(
      (node.attrs as Record<string, unknown>)['join_policy'] ?? 'wait_all'
    );
    const errorPolicy = String(
      (node.attrs as Record<string, unknown>)['error_policy'] ?? 'continue'
    );
    const maxParallel = parseInt(
      String((node.attrs as Record<string, unknown>)['max_parallel'] ?? '4'), 10
    );

    // 3. Execute branches concurrently
    const results: Outcome[] = [];

    if (this.executor) {
      // Execute with bounded parallelism
      const pending = [...branches];
      while (pending.length > 0) {
        const batch = pending.splice(0, maxParallel);
        const batchPromises = batch.map(async (branch) => {
          const branchContext = context.clone();
          try {
            return await this.executor!(branch.to, branchContext, graph, logsRoot);
          } catch (e) {
            return makeOutcome({
              status: StageStatus.FAIL,
              failure_reason: String(e),
            });
          }
        });

        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);

        // Check error policy
        if (errorPolicy === 'fail_fast') {
          const hasFail = batchResults.some(r => r.status === StageStatus.FAIL);
          if (hasFail) break;
        }
      }
    } else {
      // No executor: simulate success for each branch
      for (const branch of branches) {
        results.push(makeOutcome({
          status: StageStatus.SUCCESS,
          notes: `Simulated parallel branch: ${branch.to}`,
        }));
      }
    }

    // 4. Evaluate join policy
    const successCount = results.filter(r =>
      r.status === StageStatus.SUCCESS || r.status === StageStatus.PARTIAL_SUCCESS
    ).length;
    const failCount = results.filter(r => r.status === StageStatus.FAIL).length;

    // 5. Build results summary for downstream fan-in (via context_updates, not direct mutation)
    const resultsSummary = JSON.stringify(results.map((r, i) => ({
      branch: branches[i]?.to ?? `branch_${i}`,
      outcome: r.status,
      notes: r.notes,
    })));

    if (joinPolicy === 'wait_all') {
      if (failCount === 0) {
        return makeOutcome({
          status: StageStatus.SUCCESS,
          notes: 'All parallel branches succeeded',
          context_updates: { 'parallel.results': resultsSummary },
        });
      } else {
        return makeOutcome({
          status: StageStatus.PARTIAL_SUCCESS,
          notes: `${successCount} succeeded, ${failCount} failed`,
          context_updates: { 'parallel.results': resultsSummary },
        });
      }
    }

    if (joinPolicy === 'first_success') {
      if (successCount > 0) {
        return makeOutcome({
          status: StageStatus.SUCCESS,
          notes: 'At least one branch succeeded',
          context_updates: { 'parallel.results': resultsSummary },
        });
      } else {
        return makeOutcome({
          status: StageStatus.FAIL,
          failure_reason: 'All parallel branches failed',
          context_updates: { 'parallel.results': resultsSummary },
        });
      }
    }

    // Default: success if any succeeded
    return makeOutcome({
      status: successCount > 0 ? StageStatus.SUCCESS : StageStatus.FAIL,
      notes: `${successCount} succeeded, ${failCount} failed`,
      context_updates: { 'parallel.results': resultsSummary },
    });
  }
}
