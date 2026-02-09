import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createCheckpoint,
  saveCheckpoint,
  loadCheckpoint,
  restoreFromCheckpoint,
} from './checkpoint.js';
import { Context } from './context.js';
import { StageStatus, makeOutcome } from '../types.js';

let tempDir: string;

function makeTempDir(): string {
  const dir = join(tmpdir(), `attractor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDir = dir;
  return dir;
}

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('createCheckpoint', () => {
  it('returns correct structure', () => {
    const ctx = new Context();
    ctx.set('key', 'value');
    ctx.appendLog('log entry');

    const checkpoint = createCheckpoint(
      ctx,
      'nodeA',
      ['start', 'nodeA'],
      { nodeA: 1 },
      { nodeA: makeOutcome({ status: StageStatus.SUCCESS }) },
    );

    expect(checkpoint.current_node).toBe('nodeA');
    expect(checkpoint.completed_nodes).toEqual(['start', 'nodeA']);
    expect(checkpoint.node_retries).toEqual({ nodeA: 1 });
    expect(checkpoint.context_values).toEqual({ key: 'value' });
    expect(checkpoint.logs).toEqual(['log entry']);
    expect(checkpoint.timestamp).toBeDefined();
    expect(typeof checkpoint.timestamp).toBe('string');
  });

  it('includes node_outcomes', () => {
    const ctx = new Context();
    const outcomes = {
      nodeA: makeOutcome({ status: StageStatus.SUCCESS, notes: 'done' }),
      nodeB: makeOutcome({ status: StageStatus.FAIL, failure_reason: 'error' }),
    };

    const checkpoint = createCheckpoint(ctx, 'nodeB', ['nodeA', 'nodeB'], {}, outcomes);

    expect(checkpoint.node_outcomes).toBeDefined();
    expect(checkpoint.node_outcomes.nodeA.status).toBe(StageStatus.SUCCESS);
    expect(checkpoint.node_outcomes.nodeB.status).toBe(StageStatus.FAIL);
  });
});

describe('saveCheckpoint', () => {
  it('writes JSON file', () => {
    const dir = makeTempDir();
    const ctx = new Context();
    const checkpoint = createCheckpoint(ctx, 'node', [], {});

    saveCheckpoint(checkpoint, dir);

    expect(existsSync(join(dir, 'checkpoint.json'))).toBe(true);
  });

  it('creates directory if it does not exist', () => {
    const dir = join(tmpdir(), `attractor-test-nested-${Date.now()}`);
    tempDir = dir;
    const ctx = new Context();
    const checkpoint = createCheckpoint(ctx, 'node', [], {});

    saveCheckpoint(checkpoint, dir);

    expect(existsSync(join(dir, 'checkpoint.json'))).toBe(true);
  });
});

describe('loadCheckpoint', () => {
  it('reads back correctly', () => {
    const dir = makeTempDir();
    const ctx = new Context();
    ctx.set('data', 42);
    const outcomes = { n: makeOutcome({ status: StageStatus.SUCCESS }) };
    const checkpoint = createCheckpoint(ctx, 'nodeX', ['start'], { nodeX: 2 }, outcomes);

    saveCheckpoint(checkpoint, dir);
    const loaded = loadCheckpoint(dir);

    expect(loaded).not.toBeNull();
    expect(loaded!.current_node).toBe('nodeX');
    expect(loaded!.completed_nodes).toEqual(['start']);
    expect(loaded!.node_retries).toEqual({ nodeX: 2 });
    expect(loaded!.context_values).toEqual({ data: 42 });
    expect(loaded!.node_outcomes.n.status).toBe(StageStatus.SUCCESS);
  });

  it('returns null when no checkpoint exists', () => {
    const dir = makeTempDir();
    const loaded = loadCheckpoint(dir);
    expect(loaded).toBeNull();
  });
});

describe('restoreFromCheckpoint', () => {
  it('restores context, completed nodes, retry counts', () => {
    const dir = makeTempDir();
    const ctx = new Context();
    ctx.set('key', 'value');
    ctx.appendLog('entry1');
    const outcomes = { n: makeOutcome({ status: StageStatus.SUCCESS }) };
    const checkpoint = createCheckpoint(ctx, 'current', ['start', 'A'], { A: 1 }, outcomes);

    saveCheckpoint(checkpoint, dir);
    const loaded = loadCheckpoint(dir)!;
    const restored = restoreFromCheckpoint(loaded);

    expect(restored.currentNode).toBe('current');
    expect(restored.completedNodes).toEqual(['start', 'A']);
    expect(restored.nodeRetries).toEqual({ A: 1 });
    expect(restored.context.get('key')).toBe('value');
    expect(restored.context.getLogs()).toEqual(['entry1']);
    expect(restored.nodeOutcomes.n.status).toBe(StageStatus.SUCCESS);
  });
});

describe('round-trip', () => {
  it('save then load produces same data', () => {
    const dir = makeTempDir();
    const ctx = new Context();
    ctx.set('list', [1, 2, 3]);
    ctx.set('nested', { a: { b: 'c' } });
    ctx.appendLog('log1');
    ctx.appendLog('log2');

    const outcomes = {
      step1: makeOutcome({ status: StageStatus.SUCCESS, preferred_label: 'next' }),
    };
    const original = createCheckpoint(ctx, 'step2', ['step1'], { step1: 0 }, outcomes);

    saveCheckpoint(original, dir);
    const loaded = loadCheckpoint(dir)!;

    expect(loaded.current_node).toBe(original.current_node);
    expect(loaded.completed_nodes).toEqual(original.completed_nodes);
    expect(loaded.node_retries).toEqual(original.node_retries);
    expect(loaded.context_values).toEqual(original.context_values);
    expect(loaded.logs).toEqual(original.logs);
    expect(loaded.node_outcomes.step1.status).toBe(StageStatus.SUCCESS);
    expect(loaded.node_outcomes.step1.preferred_label).toBe('next');
  });
});
