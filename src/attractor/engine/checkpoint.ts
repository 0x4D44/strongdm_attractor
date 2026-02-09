/**
 * Checkpointing: save/load execution state for fault tolerance and resume.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Checkpoint, PipelineContext, Outcome } from '../types.js';
import { Context } from './context.js';

// ---------------------------------------------------------------------------
// Checkpoint Operations
// ---------------------------------------------------------------------------

export function createCheckpoint(
  context: PipelineContext,
  currentNode: string,
  completedNodes: string[],
  nodeRetries: Record<string, number>,
  nodeOutcomes: Record<string, Outcome> = {},
): Checkpoint {
  return {
    timestamp: new Date().toISOString(),
    current_node: currentNode,
    completed_nodes: [...completedNodes],
    node_retries: { ...nodeRetries },
    node_outcomes: { ...nodeOutcomes },
    context_values: context.snapshot(),
    logs: context.getLogs(),
  };
}

export function saveCheckpoint(checkpoint: Checkpoint, logsRoot: string): void {
  const checkpointPath = join(logsRoot, 'checkpoint.json');
  const dir = dirname(checkpointPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
}

export function loadCheckpoint(logsRoot: string): Checkpoint | null {
  const checkpointPath = join(logsRoot, 'checkpoint.json');
  if (!existsSync(checkpointPath)) {
    return null;
  }

  const data = readFileSync(checkpointPath, 'utf-8');
  return JSON.parse(data) as Checkpoint;
}

export function restoreFromCheckpoint(checkpoint: Checkpoint): {
  context: PipelineContext;
  currentNode: string;
  completedNodes: string[];
  nodeRetries: Record<string, number>;
  nodeOutcomes: Record<string, Outcome>;
} {
  const context = new Context();
  context.applyUpdates(checkpoint.context_values);

  for (const entry of checkpoint.logs) {
    context.appendLog(entry);
  }

  return {
    context,
    currentNode: checkpoint.current_node,
    completedNodes: [...checkpoint.completed_nodes],
    nodeRetries: { ...checkpoint.node_retries },
    nodeOutcomes: { ...checkpoint.node_outcomes },
  };
}
