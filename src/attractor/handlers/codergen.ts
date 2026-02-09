/**
 * Codergen handler: LLM task node.
 * Expands $goal in prompt, calls CodergenBackend, writes artifacts to log dir.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  NodeHandler,
  Node,
  PipelineContext,
  Graph,
  Outcome,
  CodergenBackend,
} from '../types.js';
import { StageStatus, makeOutcome } from '../types.js';

export class CodergenHandler implements NodeHandler {
  private backend: CodergenBackend | null;

  constructor(backend: CodergenBackend | null = null) {
    this.backend = backend;
  }

  async handle(
    node: Node,
    context: PipelineContext,
    graph: Graph,
    logsRoot: string,
  ): Promise<Outcome> {
    // 1. Build prompt
    let prompt = node.attrs.prompt || node.attrs.label || node.id;
    prompt = expandVariables(prompt, graph, context);

    // 2. Write prompt to logs
    const stageDir = join(logsRoot, node.id);
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, 'prompt.md'), prompt, 'utf-8');

    // 3. Call LLM backend
    let responseText: string;

    if (this.backend) {
      try {
        const result = await this.backend.run(node, prompt, context);

        // If result is an Outcome, write status and return directly
        if (typeof result === 'object' && result !== null && 'status' in result) {
          const outcome = result as Outcome;
          writeStatus(stageDir, outcome);
          return outcome;
        }

        responseText = String(result);
      } catch (e) {
        const outcome = makeOutcome({
          status: StageStatus.FAIL,
          failure_reason: String(e),
        });
        writeStatus(stageDir, outcome);
        return outcome;
      }
    } else {
      // Simulation mode
      responseText = `[Simulated] Response for stage: ${node.id}`;
    }

    // 4. Write response to logs
    writeFileSync(join(stageDir, 'response.md'), responseText, 'utf-8');

    // 5. Build and return outcome
    const outcome = makeOutcome({
      status: StageStatus.SUCCESS,
      notes: `Stage completed: ${node.id}`,
      context_updates: {
        last_stage: node.id,
        last_response: responseText.substring(0, 200),
      },
    });

    writeStatus(stageDir, outcome);
    return outcome;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expandVariables(
  prompt: string,
  _graph: Graph,
  _context: PipelineContext,
): string {
  // $goal expansion is handled by VariableExpansionTransform during the transform phase.
  // No additional variable expansion needed here.
  return prompt;
}

function writeStatus(stageDir: string, outcome: Outcome): void {
  const status = {
    outcome: outcome.status,
    preferred_next_label: outcome.preferred_label,
    suggested_next_ids: outcome.suggested_next_ids,
    context_updates: outcome.context_updates,
    notes: outcome.notes,
    failure_reason: outcome.failure_reason,
  };
  writeFileSync(join(stageDir, 'status.json'), JSON.stringify(status, null, 2), 'utf-8');
}
