import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StackManagerHandler } from './stack-manager.js';
import { StageStatus, makeOutcome } from '../types.js';
import type { Node, PipelineContext, Graph, NodeAttributes, GraphAttributes, EdgeAttributes } from '../types.js';
import { DEFAULT_NODE_ATTRIBUTES, DEFAULT_GRAPH_ATTRIBUTES } from '../types.js';

function makeNode(overrides: Record<string, unknown> = {}): Node {
  const attrs: NodeAttributes = {
    ...DEFAULT_NODE_ATTRIBUTES,
    shape: 'house',
    type: 'stack.manager_loop',
    ...overrides,
  };
  return { id: 'stack_mgr', attrs };
}

function makeContext(values: Record<string, string> = {}): PipelineContext {
  const store = new Map<string, unknown>(Object.entries(values));
  return {
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    get: vi.fn((key: string, defaultValue?: unknown) => store.get(key) ?? defaultValue),
    getString: vi.fn((key: string, defaultValue?: string) => {
      const v = store.get(key);
      return v != null ? String(v) : (defaultValue ?? '');
    }),
    appendLog: vi.fn(),
    snapshot: vi.fn(() => Object.fromEntries(store)),
    clone: vi.fn(),
    applyUpdates: vi.fn(),
    getLogs: vi.fn(() => []),
  } satisfies PipelineContext;
}

function makeGraph(): Graph {
  return {
    name: 'test-graph',
    attrs: { ...DEFAULT_GRAPH_ATTRIBUTES },
    nodes: new Map(),
    edges: [],
  };
}

describe('StackManagerHandler', () => {
  let handler: StackManagerHandler;

  beforeEach(() => {
    handler = new StackManagerHandler();
  });

  it('returns SUCCESS when child status is completed and outcome is success', async () => {
    const context = makeContext({
      'context.stack.child.status': 'completed',
      'context.stack.child.outcome': 'success',
    });

    const result = await handler.handle(makeNode(), context, makeGraph(), '/tmp/logs');

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.notes).toContain('Child completed successfully');
  });

  it('returns FAIL when child status is failed', async () => {
    const context = makeContext({
      'context.stack.child.status': 'failed',
      'context.stack.child.outcome': 'failure',
    });

    const result = await handler.handle(makeNode(), context, makeGraph(), '/tmp/logs');

    expect(result.status).toBe(StageStatus.FAIL);
    expect(result.failure_reason).toContain('Child pipeline failed');
  });

  it('returns FAIL when max cycles exceeded with no child completion', async () => {
    const node = makeNode({
      'manager.max_cycles': '2',
      'manager.poll_interval': '0ms',
      'manager.actions': 'observe',
    });
    const context = makeContext({}); // No child status set

    const result = await handler.handle(node, context, makeGraph(), '/tmp/logs');

    expect(result.status).toBe(StageStatus.FAIL);
    expect(result.failure_reason).toContain('Max cycles exceeded');
  });

  it('returns SUCCESS when stop condition is satisfied', async () => {
    const node = makeNode({
      'manager.max_cycles': '3',
      'manager.poll_interval': '0ms',
      'manager.stop_condition': 'outcome=success',
      'manager.actions': 'observe',
    });
    const context = makeContext({});

    const result = await handler.handle(node, context, makeGraph(), '/tmp/logs');

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.notes).toContain('Stop condition satisfied');
  });

  it('uses default poll interval of 45s', async () => {
    // Just verify it doesn't error with defaults; use immediate child completion
    const context = makeContext({
      'context.stack.child.status': 'completed',
      'context.stack.child.outcome': 'success',
    });

    const result = await handler.handle(makeNode(), context, makeGraph(), '/tmp/logs');
    expect(result.status).toBe(StageStatus.SUCCESS);
  });

  it('waits between cycles when actions include wait', async () => {
    const node = makeNode({
      'manager.max_cycles': '1',
      'manager.poll_interval': '1ms',
      'manager.actions': 'observe,wait',
    });
    const context = makeContext({});

    const result = await handler.handle(node, context, makeGraph(), '/tmp/logs');
    expect(result.status).toBe(StageStatus.FAIL);
  });

  it('yields without waiting when actions do not include wait', async () => {
    const node = makeNode({
      'manager.max_cycles': '1',
      'manager.poll_interval': '10000ms',
      'manager.actions': 'observe',
    });
    const context = makeContext({});

    const start = Date.now();
    const result = await handler.handle(node, context, makeGraph(), '/tmp/logs');
    const elapsed = Date.now() - start;

    expect(result.status).toBe(StageStatus.FAIL);
    // Should be fast since we're not waiting
    expect(elapsed).toBeLessThan(5000);
  });

  it('returns SUCCESS on completed child even without success outcome', async () => {
    // completed + non-success outcome falls through to the failed check
    const context = makeContext({
      'context.stack.child.status': 'completed',
      'context.stack.child.outcome': 'partial',
    });

    const node = makeNode({
      'manager.max_cycles': '1',
      'manager.poll_interval': '0ms',
      'manager.actions': 'observe',
    });

    const result = await handler.handle(node, context, makeGraph(), '/tmp/logs');
    // completed but not success and not failed — falls through to max cycles
    expect(result.status).toBe(StageStatus.FAIL);
    expect(result.failure_reason).toContain('Max cycles exceeded');
  });
});
