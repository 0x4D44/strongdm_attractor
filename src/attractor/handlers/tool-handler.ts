/**
 * Tool handler: executes an external tool/command configured via node attributes.
 */

import { execFileSync } from 'node:child_process';
import type { NodeHandler, Node, PipelineContext, Graph, Outcome } from '../types.js';
import { StageStatus, makeOutcome } from '../types.js';
import { parseDuration } from '../utils.js';

export class ToolHandler implements NodeHandler {
  async handle(
    node: Node,
    _context: PipelineContext,
    _graph: Graph,
    _logsRoot: string,
  ): Promise<Outcome> {
    const command = String((node.attrs as Record<string, unknown>)['tool_command'] ?? '');

    if (!command) {
      return makeOutcome({
        status: StageStatus.FAIL,
        failure_reason: 'No tool_command specified',
      });
    }

    try {
      const timeoutMs = node.attrs.timeout ? parseDuration(node.attrs.timeout) : 30000;
      // Trust model: tool_command comes from the DOT pipeline file, which is authored
      // by the pipeline developer — not by the LLM. Shell invocation is explicit.
      const result = execFileSync('/bin/sh', ['-c', command], {
        timeout: timeoutMs,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      return makeOutcome({
        status: StageStatus.SUCCESS,
        context_updates: { 'tool.output': result },
        notes: `Tool completed: ${command}`,
      });
    } catch (e) {
      return makeOutcome({
        status: StageStatus.FAIL,
        failure_reason: String(e),
      });
    }
  }
}
