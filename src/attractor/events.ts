/**
 * Pipeline execution events: typed events emitted during pipeline execution.
 */

import type { PipelineEvent } from './types.js';
import { PipelineEventKind } from './types.js';

// ---------------------------------------------------------------------------
// Event Emitter
// ---------------------------------------------------------------------------

export type EventListener = (event: PipelineEvent) => void;

export class PipelineEventEmitter {
  private listeners: EventListener[] = [];
  private eventLog: PipelineEvent[] = [];

  on(listener: EventListener): void {
    this.listeners.push(listener);
  }

  off(listener: EventListener): void {
    this.listeners = this.listeners.filter(l => l !== listener);
  }

  emit(event: PipelineEvent): void {
    this.eventLog.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('Event listener error:', e);
      }
    }
  }

  getEventLog(): PipelineEvent[] {
    return [...this.eventLog];
  }

  clear(): void {
    this.eventLog = [];
  }
}

// ---------------------------------------------------------------------------
// Event Factory Functions
// ---------------------------------------------------------------------------

function makeEvent(kind: PipelineEventKind, data: Record<string, unknown>): PipelineEvent {
  return { kind, timestamp: new Date(), data };
}

export function pipelineStarted(name: string, id: string): PipelineEvent {
  return makeEvent(PipelineEventKind.PIPELINE_STARTED, { name, id });
}

export function pipelineCompleted(duration: number, artifactCount: number): PipelineEvent {
  return makeEvent(PipelineEventKind.PIPELINE_COMPLETED, { duration, artifact_count: artifactCount });
}

export function pipelineFailed(error: string, duration: number): PipelineEvent {
  return makeEvent(PipelineEventKind.PIPELINE_FAILED, { error, duration });
}

export function stageStarted(name: string, index: number): PipelineEvent {
  return makeEvent(PipelineEventKind.STAGE_STARTED, { name, index });
}

export function stageCompleted(name: string, index: number, duration: number): PipelineEvent {
  return makeEvent(PipelineEventKind.STAGE_COMPLETED, { name, index, duration });
}

export function stageFailed(name: string, index: number, error: string, willRetry: boolean): PipelineEvent {
  return makeEvent(PipelineEventKind.STAGE_FAILED, { name, index, error, will_retry: willRetry });
}

export function stageRetrying(name: string, index: number, attempt: number, delay: number): PipelineEvent {
  return makeEvent(PipelineEventKind.STAGE_RETRYING, { name, index, attempt, delay });
}

export function parallelStarted(branchCount: number): PipelineEvent {
  return makeEvent(PipelineEventKind.PARALLEL_STARTED, { branch_count: branchCount });
}

export function parallelBranchStarted(branch: string, index: number): PipelineEvent {
  return makeEvent(PipelineEventKind.PARALLEL_BRANCH_STARTED, { branch, index });
}

export function parallelBranchCompleted(branch: string, index: number, duration: number, success: boolean): PipelineEvent {
  return makeEvent(PipelineEventKind.PARALLEL_BRANCH_COMPLETED, { branch, index, duration, success });
}

export function parallelCompleted(duration: number, successCount: number, failureCount: number): PipelineEvent {
  return makeEvent(PipelineEventKind.PARALLEL_COMPLETED, { duration, success_count: successCount, failure_count: failureCount });
}

export function interviewStarted(question: string, stage: string): PipelineEvent {
  return makeEvent(PipelineEventKind.INTERVIEW_STARTED, { question, stage });
}

export function interviewCompleted(question: string, answer: string, duration: number): PipelineEvent {
  return makeEvent(PipelineEventKind.INTERVIEW_COMPLETED, { question, answer, duration });
}

export function interviewTimeout(question: string, stage: string, duration: number): PipelineEvent {
  return makeEvent(PipelineEventKind.INTERVIEW_TIMEOUT, { question, stage, duration });
}

export function checkpointSaved(nodeId: string): PipelineEvent {
  return makeEvent(PipelineEventKind.CHECKPOINT_SAVED, { node_id: nodeId });
}

export function edgeSelected(from: string, to: string, reason: string): PipelineEvent {
  return makeEvent(PipelineEventKind.EDGE_SELECTED, { from, to, reason });
}
