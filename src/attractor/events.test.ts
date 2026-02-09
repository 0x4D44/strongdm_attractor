import { describe, it, expect, vi } from 'vitest';
import {
  PipelineEventEmitter,
  pipelineStarted,
  pipelineCompleted,
  pipelineFailed,
  stageStarted,
  stageCompleted,
  stageFailed,
  stageRetrying,
  parallelStarted,
  parallelBranchStarted,
  parallelBranchCompleted,
  parallelCompleted,
  interviewStarted,
  interviewCompleted,
  interviewTimeout,
  checkpointSaved,
  edgeSelected,
} from './events.js';
import { PipelineEventKind } from './types.js';
import type { PipelineEvent } from './types.js';

// ---------------------------------------------------------------------------
// PipelineEventEmitter
// ---------------------------------------------------------------------------

describe('PipelineEventEmitter', () => {
  it('emits events to all listeners', () => {
    const emitter = new PipelineEventEmitter();
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    emitter.on(listener1);
    emitter.on(listener2);

    const event = pipelineStarted('test-pipeline', 'id-1');
    emitter.emit(event);

    expect(listener1).toHaveBeenCalledWith(event);
    expect(listener2).toHaveBeenCalledWith(event);
  });

  it('removes listener with off()', () => {
    const emitter = new PipelineEventEmitter();
    const listener = vi.fn();

    emitter.on(listener);
    emitter.off(listener);

    emitter.emit(pipelineStarted('test', 'id'));
    expect(listener).not.toHaveBeenCalled();
  });

  it('maintains event log', () => {
    const emitter = new PipelineEventEmitter();

    emitter.emit(pipelineStarted('p', 'id'));
    emitter.emit(stageStarted('s1', 0));

    const log = emitter.getEventLog();
    expect(log).toHaveLength(2);
    expect(log[0].kind).toBe(PipelineEventKind.PIPELINE_STARTED);
    expect(log[1].kind).toBe(PipelineEventKind.STAGE_STARTED);
  });

  it('getEventLog returns a copy', () => {
    const emitter = new PipelineEventEmitter();
    emitter.emit(pipelineStarted('p', 'id'));

    const log1 = emitter.getEventLog();
    const log2 = emitter.getEventLog();
    expect(log1).not.toBe(log2);
    expect(log1).toEqual(log2);
  });

  it('clear removes all events from log', () => {
    const emitter = new PipelineEventEmitter();
    emitter.emit(pipelineStarted('p', 'id'));
    emitter.emit(stageStarted('s', 0));

    emitter.clear();
    expect(emitter.getEventLog()).toHaveLength(0);
  });

  it('catches and logs listener errors without affecting other listeners', () => {
    const emitter = new PipelineEventEmitter();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const badListener = vi.fn(() => { throw new Error('listener error'); });
    const goodListener = vi.fn();

    emitter.on(badListener);
    emitter.on(goodListener);

    emitter.emit(pipelineStarted('p', 'id'));

    expect(badListener).toHaveBeenCalled();
    expect(goodListener).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Event Factory Functions
// ---------------------------------------------------------------------------

describe('Event factory functions', () => {
  it('pipelineStarted creates correct event', () => {
    const event = pipelineStarted('my-pipeline', 'run-123');
    expect(event.kind).toBe(PipelineEventKind.PIPELINE_STARTED);
    expect(event.data.name).toBe('my-pipeline');
    expect(event.data.id).toBe('run-123');
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it('pipelineCompleted creates correct event', () => {
    const event = pipelineCompleted(5000, 3);
    expect(event.kind).toBe(PipelineEventKind.PIPELINE_COMPLETED);
    expect(event.data.duration).toBe(5000);
    expect(event.data.artifact_count).toBe(3);
  });

  it('pipelineFailed creates correct event', () => {
    const event = pipelineFailed('timeout', 10000);
    expect(event.kind).toBe(PipelineEventKind.PIPELINE_FAILED);
    expect(event.data.error).toBe('timeout');
    expect(event.data.duration).toBe(10000);
  });

  it('stageStarted creates correct event', () => {
    const event = stageStarted('build', 0);
    expect(event.kind).toBe(PipelineEventKind.STAGE_STARTED);
    expect(event.data.name).toBe('build');
    expect(event.data.index).toBe(0);
  });

  it('stageCompleted creates correct event', () => {
    const event = stageCompleted('build', 0, 2000);
    expect(event.kind).toBe(PipelineEventKind.STAGE_COMPLETED);
    expect(event.data.duration).toBe(2000);
  });

  it('stageFailed creates correct event', () => {
    const event = stageFailed('build', 0, 'compile error', true);
    expect(event.kind).toBe(PipelineEventKind.STAGE_FAILED);
    expect(event.data.error).toBe('compile error');
    expect(event.data.will_retry).toBe(true);
  });

  it('stageRetrying creates correct event', () => {
    const event = stageRetrying('build', 0, 2, 1000);
    expect(event.kind).toBe(PipelineEventKind.STAGE_RETRYING);
    expect(event.data.attempt).toBe(2);
    expect(event.data.delay).toBe(1000);
  });

  it('parallelStarted creates correct event', () => {
    const event = parallelStarted(3);
    expect(event.kind).toBe(PipelineEventKind.PARALLEL_STARTED);
    expect(event.data.branch_count).toBe(3);
  });

  it('parallelBranchStarted creates correct event', () => {
    const event = parallelBranchStarted('worker-1', 0);
    expect(event.kind).toBe(PipelineEventKind.PARALLEL_BRANCH_STARTED);
    expect(event.data.branch).toBe('worker-1');
  });

  it('parallelBranchCompleted creates correct event', () => {
    const event = parallelBranchCompleted('worker-1', 0, 1500, true);
    expect(event.kind).toBe(PipelineEventKind.PARALLEL_BRANCH_COMPLETED);
    expect(event.data.success).toBe(true);
  });

  it('parallelCompleted creates correct event', () => {
    const event = parallelCompleted(3000, 2, 1);
    expect(event.kind).toBe(PipelineEventKind.PARALLEL_COMPLETED);
    expect(event.data.success_count).toBe(2);
    expect(event.data.failure_count).toBe(1);
  });

  it('interviewStarted creates correct event', () => {
    const event = interviewStarted('Approve deploy?', 'review');
    expect(event.kind).toBe(PipelineEventKind.INTERVIEW_STARTED);
    expect(event.data.question).toBe('Approve deploy?');
    expect(event.data.stage).toBe('review');
  });

  it('interviewCompleted creates correct event', () => {
    const event = interviewCompleted('Approve?', 'yes', 5000);
    expect(event.kind).toBe(PipelineEventKind.INTERVIEW_COMPLETED);
    expect(event.data.answer).toBe('yes');
  });

  it('interviewTimeout creates correct event', () => {
    const event = interviewTimeout('Approve?', 'review', 30000);
    expect(event.kind).toBe(PipelineEventKind.INTERVIEW_TIMEOUT);
    expect(event.data.duration).toBe(30000);
  });

  it('checkpointSaved creates correct event', () => {
    const event = checkpointSaved('node-5');
    expect(event.kind).toBe(PipelineEventKind.CHECKPOINT_SAVED);
    expect(event.data.node_id).toBe('node-5');
  });

  it('edgeSelected creates correct event', () => {
    const event = edgeSelected('node-1', 'node-2', 'condition met');
    expect(event.kind).toBe(PipelineEventKind.EDGE_SELECTED);
    expect(event.data.from).toBe('node-1');
    expect(event.data.to).toBe('node-2');
    expect(event.data.reason).toBe('condition met');
  });
});
