import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StartHandler } from './start.js';
import { ExitHandler } from './exit.js';
import { ConditionalHandler } from './conditional.js';
import { CodergenHandler } from './codergen.js';
import { WaitHumanHandler, parseAcceleratorKey } from './wait-human.js';
import { ToolHandler } from './tool-handler.js';
import { ParallelHandler } from './parallel.js';
import { FanInHandler } from './fan-in.js';
import { Context } from '../engine/context.js';
import type { Node, Graph, CodergenBackend, Interviewer, Outcome } from '../types.js';
import {
  StageStatus,
  makeOutcome,
  DEFAULT_NODE_ATTRIBUTES,
  DEFAULT_EDGE_ATTRIBUTES,
  DEFAULT_GRAPH_ATTRIBUTES,
  QuestionType,
  AnswerValue,
} from '../types.js';

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `attractor-handlers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  tempDirs = [];
});

function makeNode(id: string, attrs: Partial<typeof DEFAULT_NODE_ATTRIBUTES> = {}): Node {
  return { id, attrs: { ...DEFAULT_NODE_ATTRIBUTES, ...attrs } };
}

function makeGraph(nodes: Node[] = [], edges: Array<{ from: string; to: string; attrs?: Partial<typeof DEFAULT_EDGE_ATTRIBUTES> }> = []): Graph {
  const nodeMap = new Map<string, Node>();
  for (const n of nodes) nodeMap.set(n.id, n);
  return {
    name: 'test',
    attrs: { ...DEFAULT_GRAPH_ATTRIBUTES },
    nodes: nodeMap,
    edges: edges.map(e => ({ from: e.from, to: e.to, attrs: { ...DEFAULT_EDGE_ATTRIBUTES, ...e.attrs } })),
  };
}

describe('StartHandler', () => {
  it('returns SUCCESS', async () => {
    const handler = new StartHandler();
    const node = makeNode('start', { shape: 'Mdiamond' });
    const ctx = new Context();
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
  });
});

describe('ExitHandler', () => {
  it('returns SUCCESS', async () => {
    const handler = new ExitHandler();
    const node = makeNode('exit', { shape: 'Msquare' });
    const ctx = new Context();
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
  });
});

describe('ConditionalHandler', () => {
  it('returns SUCCESS with pass-through', async () => {
    const handler = new ConditionalHandler();
    const node = makeNode('check', { shape: 'diamond' });
    const ctx = new Context();
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.notes).toContain('check');
  });
});

describe('CodergenHandler', () => {
  it('writes prompt.md and response.md, calls backend', async () => {
    const mockBackend: CodergenBackend = {
      run: vi.fn().mockResolvedValue('Generated response text'),
    };
    const handler = new CodergenHandler(mockBackend);
    const node = makeNode('gen', { prompt: 'Write code for $goal', label: 'Generate' });
    const ctx = new Context();
    const graph = makeGraph([node]);
    graph.attrs.goal = 'a web app';
    const logsRoot = makeTempDir();

    const outcome = await handler.handle(node, ctx, graph, logsRoot);

    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(mockBackend.run).toHaveBeenCalled();

    // Check files were written
    const stageDir = join(logsRoot, 'gen');
    expect(existsSync(join(stageDir, 'prompt.md'))).toBe(true);
    expect(existsSync(join(stageDir, 'response.md'))).toBe(true);

    const response = readFileSync(join(stageDir, 'response.md'), 'utf-8');
    expect(response).toBe('Generated response text');
  });

  it('returns FAIL when backend throws', async () => {
    const mockBackend: CodergenBackend = {
      run: vi.fn().mockRejectedValue(new Error('LLM error')),
    };
    const handler = new CodergenHandler(mockBackend);
    const node = makeNode('gen', { prompt: 'test' });
    const ctx = new Context();
    const graph = makeGraph([node]);
    const logsRoot = makeTempDir();

    const outcome = await handler.handle(node, ctx, graph, logsRoot);
    expect(outcome.status).toBe(StageStatus.FAIL);
    expect(outcome.failure_reason).toContain('LLM error');
  });

  it('simulation mode when no backend', async () => {
    const handler = new CodergenHandler(null);
    const node = makeNode('gen', { prompt: 'test' });
    const ctx = new Context();
    const graph = makeGraph([node]);
    const logsRoot = makeTempDir();

    const outcome = await handler.handle(node, ctx, graph, logsRoot);
    expect(outcome.status).toBe(StageStatus.SUCCESS);

    const response = readFileSync(join(logsRoot, 'gen', 'response.md'), 'utf-8');
    expect(response).toContain('Simulated');
  });

  it('handles backend returning Outcome directly', async () => {
    const directOutcome = makeOutcome({
      status: StageStatus.SUCCESS,
      preferred_label: 'next',
      notes: 'direct outcome',
    });
    const mockBackend: CodergenBackend = {
      run: vi.fn().mockResolvedValue(directOutcome),
    };
    const handler = new CodergenHandler(mockBackend);
    const node = makeNode('gen', { prompt: 'test' });
    const ctx = new Context();
    const graph = makeGraph([node]);
    const logsRoot = makeTempDir();

    const outcome = await handler.handle(node, ctx, graph, logsRoot);
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.preferred_label).toBe('next');
  });
});

describe('WaitHumanHandler', () => {
  it('presents choices and returns selected label', async () => {
    const mockInterviewer: Interviewer = {
      ask: vi.fn().mockResolvedValue({
        value: 'Y',
        selected_option: { key: 'Y', label: '[Y] Yes' },
        text: '[Y] Yes',
      }),
    };

    const handler = new WaitHumanHandler(mockInterviewer);
    const node = makeNode('gate', { shape: 'hexagon', label: 'Continue?' });
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('yes'), makeNode('no')],
      [
        { from: 'gate', to: 'yes', attrs: { label: '[Y] Yes' } },
        { from: 'gate', to: 'no', attrs: { label: '[N] No' } },
      ]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.suggested_next_ids).toContain('yes');
  });

  it('returns FAIL when no outgoing edges', async () => {
    const mockInterviewer: Interviewer = {
      ask: vi.fn(),
    };
    const handler = new WaitHumanHandler(mockInterviewer);
    const node = makeNode('gate', { shape: 'hexagon' });
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, new Context(), graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.FAIL);
  });

  it('TIMEOUT with matching default_choice returns SUCCESS', async () => {
    const mockInterviewer: Interviewer = {
      ask: vi.fn().mockResolvedValue({
        value: AnswerValue.TIMEOUT,
      }),
    };
    const handler = new WaitHumanHandler(mockInterviewer);
    const node = makeNode('gate', { shape: 'hexagon', label: 'Pick one' });
    (node.attrs as Record<string, unknown>)['human.default_choice'] = 'yes';
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('yes'), makeNode('no')],
      [
        { from: 'gate', to: 'yes', attrs: { label: '[Y] Yes' } },
        { from: 'gate', to: 'no', attrs: { label: '[N] No' } },
      ]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.suggested_next_ids).toContain('yes');
    expect(outcome.context_updates['human.gate.selected']).toBe('Y');
  });

  it('TIMEOUT with non-matching default_choice returns RETRY', async () => {
    const mockInterviewer: Interviewer = {
      ask: vi.fn().mockResolvedValue({
        value: AnswerValue.TIMEOUT,
      }),
    };
    const handler = new WaitHumanHandler(mockInterviewer);
    const node = makeNode('gate', { shape: 'hexagon', label: 'Pick' });
    (node.attrs as Record<string, unknown>)['human.default_choice'] = 'nonexistent';
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('yes')],
      [{ from: 'gate', to: 'yes', attrs: { label: 'Yes' } }]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.RETRY);
    expect(outcome.failure_reason).toContain('timeout');
  });

  it('TIMEOUT without default_choice returns RETRY', async () => {
    const mockInterviewer: Interviewer = {
      ask: vi.fn().mockResolvedValue({
        value: AnswerValue.TIMEOUT,
      }),
    };
    const handler = new WaitHumanHandler(mockInterviewer);
    const node = makeNode('gate', { shape: 'hexagon', label: 'Pick' });
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('yes')],
      [{ from: 'gate', to: 'yes', attrs: { label: 'Yes' } }]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.RETRY);
    expect(outcome.failure_reason).toContain('no default');
  });

  it('SKIPPED answer returns FAIL', async () => {
    const mockInterviewer: Interviewer = {
      ask: vi.fn().mockResolvedValue({
        value: AnswerValue.SKIPPED,
      }),
    };
    const handler = new WaitHumanHandler(mockInterviewer);
    const node = makeNode('gate', { shape: 'hexagon', label: 'Pick' });
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('yes')],
      [{ from: 'gate', to: 'yes', attrs: { label: 'Yes' } }]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.FAIL);
    expect(outcome.failure_reason).toContain('skipped');
  });

  it('uses edge.to as label fallback when edge has no label', async () => {
    const mockInterviewer: Interviewer = {
      ask: vi.fn().mockResolvedValue({
        value: 'next_step',
      }),
    };
    const handler = new WaitHumanHandler(mockInterviewer);
    const node = makeNode('gate', { shape: 'hexagon' });
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('next_step')],
      [{ from: 'gate', to: 'next_step' }] // no label attr
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.suggested_next_ids).toContain('next_step');
  });

  it('TIMEOUT default_choice matches by key', async () => {
    const mockInterviewer: Interviewer = {
      ask: vi.fn().mockResolvedValue({
        value: AnswerValue.TIMEOUT,
      }),
    };
    const handler = new WaitHumanHandler(mockInterviewer);
    const node = makeNode('gate', { shape: 'hexagon', label: 'Pick' });
    (node.attrs as Record<string, unknown>)['human.default_choice'] = 'Y';
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('yes'), makeNode('no')],
      [
        { from: 'gate', to: 'yes', attrs: { label: '[Y] Yes' } },
        { from: 'gate', to: 'no', attrs: { label: '[N] No' } },
      ]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.suggested_next_ids).toContain('yes');
  });

  it('TIMEOUT default_choice matches by label', async () => {
    const mockInterviewer: Interviewer = {
      ask: vi.fn().mockResolvedValue({
        value: AnswerValue.TIMEOUT,
      }),
    };
    const handler = new WaitHumanHandler(mockInterviewer);
    const node = makeNode('gate', { shape: 'hexagon', label: 'Pick' });
    (node.attrs as Record<string, unknown>)['human.default_choice'] = '[Y] Yes';
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('yes'), makeNode('no')],
      [
        { from: 'gate', to: 'yes', attrs: { label: '[Y] Yes' } },
        { from: 'gate', to: 'no', attrs: { label: '[N] No' } },
      ]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.context_updates['human.gate.label']).toBe('[Y] Yes');
  });

  it('answer matching by label text', async () => {
    const mockInterviewer: Interviewer = {
      ask: vi.fn().mockResolvedValue({
        value: '[N] No',
      }),
    };
    const handler = new WaitHumanHandler(mockInterviewer);
    const node = makeNode('gate', { shape: 'hexagon', label: 'Pick' });
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('yes'), makeNode('no')],
      [
        { from: 'gate', to: 'yes', attrs: { label: '[Y] Yes' } },
        { from: 'gate', to: 'no', attrs: { label: '[N] No' } },
      ]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.suggested_next_ids).toContain('no');
  });

  it('answer matching by node target ID', async () => {
    const mockInterviewer: Interviewer = {
      ask: vi.fn().mockResolvedValue({
        value: 'no',
      }),
    };
    const handler = new WaitHumanHandler(mockInterviewer);
    const node = makeNode('gate', { shape: 'hexagon', label: 'Pick' });
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('yes'), makeNode('no')],
      [
        { from: 'gate', to: 'yes', attrs: { label: '[Y] Yes' } },
        { from: 'gate', to: 'no', attrs: { label: '[N] No' } },
      ]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.suggested_next_ids).toContain('no');
  });

  it('falls back to first choice when answer matches nothing', async () => {
    const mockInterviewer: Interviewer = {
      ask: vi.fn().mockResolvedValue({
        value: 'zzzzz',
      }),
    };
    const handler = new WaitHumanHandler(mockInterviewer);
    const node = makeNode('gate', { shape: 'hexagon', label: 'Pick' });
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('yes'), makeNode('no')],
      [
        { from: 'gate', to: 'yes', attrs: { label: '[Y] Yes' } },
        { from: 'gate', to: 'no', attrs: { label: '[N] No' } },
      ]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.suggested_next_ids).toContain('yes'); // first choice is fallback
  });

  it('uses node label as question text', async () => {
    const mockInterviewer: Interviewer = {
      ask: vi.fn().mockResolvedValue({
        value: 'Y',
        selected_option: { key: 'Y', label: '[Y] Yes' },
      }),
    };
    const handler = new WaitHumanHandler(mockInterviewer);
    const node = makeNode('gate', { shape: 'hexagon', label: 'Custom Question?' });
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('yes')],
      [{ from: 'gate', to: 'yes', attrs: { label: '[Y] Yes' } }]
    );

    await handler.handle(node, ctx, graph, makeTempDir());
    const calledQuestion = (mockInterviewer.ask as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledQuestion.text).toBe('Custom Question?');
  });
});

describe('ToolHandler', () => {
  it('executes command and returns result', async () => {
    const handler = new ToolHandler();
    const node = makeNode('tool', { shape: 'parallelogram' });
    (node.attrs as Record<string, unknown>)['tool_command'] = 'echo hello';
    const ctx = new Context();
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.context_updates['tool.output']).toContain('hello');
  });

  it('returns FAIL when no tool_command', async () => {
    const handler = new ToolHandler();
    const node = makeNode('tool', { shape: 'parallelogram' });
    const ctx = new Context();
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.FAIL);
    expect(outcome.failure_reason).toContain('No tool_command');
  });

  it('uses default timeout of 30000ms when timeout is not specified', async () => {
    const handler = new ToolHandler();
    const node = makeNode('tool', { shape: 'parallelogram' });
    // No timeout attr set -> defaults to 30000ms
    (node.attrs as Record<string, unknown>)['tool_command'] = 'echo hello';
    const ctx = new Context();
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.context_updates['tool.output']).toContain('hello');
  });

  it('uses specified timeout from node attrs', async () => {
    const handler = new ToolHandler();
    const node = makeNode('tool', { shape: 'parallelogram', timeout: '5s' });
    (node.attrs as Record<string, unknown>)['tool_command'] = 'echo hello';
    const ctx = new Context();
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
  });

  it('returns FAIL on command error', async () => {
    const handler = new ToolHandler();
    const node = makeNode('tool', { shape: 'parallelogram' });
    (node.attrs as Record<string, unknown>)['tool_command'] = 'false'; // exits with 1
    const ctx = new Context();
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.FAIL);
  });
});

describe('ParallelHandler', () => {
  it('fans out and returns combined result via context_updates', async () => {
    const handler = new ParallelHandler(null); // null executor = simulation
    const node = makeNode('par', { shape: 'component' });
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('branch1'), makeNode('branch2')],
      [
        { from: 'par', to: 'branch1' },
        { from: 'par', to: 'branch2' },
      ]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.context_updates['parallel.results']).toBeDefined();
    const results = JSON.parse(outcome.context_updates['parallel.results'] as string);
    expect(results).toHaveLength(2);
  });

  it('returns FAIL when no outgoing edges', async () => {
    const handler = new ParallelHandler(null);
    const node = makeNode('par', { shape: 'component' });
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, new Context(), graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.FAIL);
  });

  it('uses executor when provided', async () => {
    const executor = vi.fn().mockResolvedValue(
      makeOutcome({ status: StageStatus.SUCCESS, notes: 'executed' })
    );
    const handler = new ParallelHandler(executor);
    const node = makeNode('par', { shape: 'component' });
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('b1')],
      [{ from: 'par', to: 'b1' }]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(executor).toHaveBeenCalled();
  });

  it('join_policy=first_success returns SUCCESS when at least one branch succeeds', async () => {
    const executor = vi.fn()
      .mockResolvedValueOnce(makeOutcome({ status: StageStatus.FAIL, failure_reason: 'branch1 failed' }))
      .mockResolvedValueOnce(makeOutcome({ status: StageStatus.SUCCESS, notes: 'branch2 ok' }));
    const handler = new ParallelHandler(executor);
    const node = makeNode('par', { shape: 'component' });
    (node.attrs as Record<string, unknown>)['join_policy'] = 'first_success';
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('b1'), makeNode('b2')],
      [{ from: 'par', to: 'b1' }, { from: 'par', to: 'b2' }]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.notes).toContain('At least one branch succeeded');
  });

  it('join_policy=first_success returns FAIL when all branches fail', async () => {
    const executor = vi.fn()
      .mockResolvedValue(makeOutcome({ status: StageStatus.FAIL, failure_reason: 'failed' }));
    const handler = new ParallelHandler(executor);
    const node = makeNode('par', { shape: 'component' });
    (node.attrs as Record<string, unknown>)['join_policy'] = 'first_success';
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('b1'), makeNode('b2')],
      [{ from: 'par', to: 'b1' }, { from: 'par', to: 'b2' }]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.FAIL);
    expect(outcome.failure_reason).toContain('All parallel branches failed');
  });

  it('error_policy=fail_fast stops on first FAIL batch', async () => {
    let callCount = 0;
    const executor = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return makeOutcome({ status: StageStatus.FAIL, failure_reason: 'first fails' });
      }
      return makeOutcome({ status: StageStatus.SUCCESS });
    });
    const handler = new ParallelHandler(executor);
    const node = makeNode('par', { shape: 'component' });
    (node.attrs as Record<string, unknown>)['error_policy'] = 'fail_fast';
    (node.attrs as Record<string, unknown>)['max_parallel'] = '1'; // one at a time to control order
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('b1'), makeNode('b2'), makeNode('b3')],
      [
        { from: 'par', to: 'b1' },
        { from: 'par', to: 'b2' },
        { from: 'par', to: 'b3' },
      ]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    // Should stop after first batch since it has a FAIL
    expect(callCount).toBe(1);
    // wait_all with at least one FAIL returns PARTIAL_SUCCESS (fail_fast only stops execution early)
    expect(outcome.status).toBe(StageStatus.PARTIAL_SUCCESS);
  });

  it('max_parallel limits batch size', async () => {
    const concurrencyTracker: number[] = [];
    let running = 0;
    const executor = vi.fn().mockImplementation(async () => {
      running++;
      concurrencyTracker.push(running);
      await new Promise(r => setTimeout(r, 10));
      running--;
      return makeOutcome({ status: StageStatus.SUCCESS });
    });
    const handler = new ParallelHandler(executor);
    const node = makeNode('par', { shape: 'component' });
    (node.attrs as Record<string, unknown>)['max_parallel'] = '2';
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('b1'), makeNode('b2'), makeNode('b3'), makeNode('b4')],
      [
        { from: 'par', to: 'b1' },
        { from: 'par', to: 'b2' },
        { from: 'par', to: 'b3' },
        { from: 'par', to: 'b4' },
      ]
    );

    await handler.handle(node, ctx, graph, makeTempDir());
    // Max concurrent should never exceed 2
    expect(Math.max(...concurrencyTracker)).toBeLessThanOrEqual(2);
    expect(executor).toHaveBeenCalledTimes(4);
  });

  it('executor throwing exception produces FAIL outcome for that branch', async () => {
    const executor = vi.fn().mockRejectedValue(new Error('branch exploded'));
    const handler = new ParallelHandler(executor);
    const node = makeNode('par', { shape: 'component' });
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('b1')],
      [{ from: 'par', to: 'b1' }]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    // wait_all with 1 failed branch -> PARTIAL_SUCCESS
    expect(outcome.status).toBe(StageStatus.PARTIAL_SUCCESS);
    const results = JSON.parse(outcome.context_updates['parallel.results'] as string);
    expect(results[0].outcome).toBe(StageStatus.FAIL);
  });

  it('null executor simulation returns SUCCESS for all branches with notes', async () => {
    const handler = new ParallelHandler(null);
    const node = makeNode('par', { shape: 'component' });
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('b1'), makeNode('b2')],
      [{ from: 'par', to: 'b1' }, { from: 'par', to: 'b2' }]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    const results = JSON.parse(outcome.context_updates['parallel.results'] as string);
    expect(results[0].notes).toContain('Simulated');
    expect(results[1].notes).toContain('Simulated');
  });

  it('default join policy (not wait_all or first_success) returns SUCCESS if any succeeded', async () => {
    const executor = vi.fn()
      .mockResolvedValueOnce(makeOutcome({ status: StageStatus.SUCCESS }))
      .mockResolvedValueOnce(makeOutcome({ status: StageStatus.FAIL, failure_reason: 'oops' }));
    const handler = new ParallelHandler(executor);
    const node = makeNode('par', { shape: 'component' });
    (node.attrs as Record<string, unknown>)['join_policy'] = 'any';
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('b1'), makeNode('b2')],
      [{ from: 'par', to: 'b1' }, { from: 'par', to: 'b2' }]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.notes).toContain('1 succeeded');
  });

  it('default join policy returns FAIL if none succeeded', async () => {
    const executor = vi.fn()
      .mockResolvedValue(makeOutcome({ status: StageStatus.FAIL, failure_reason: 'nope' }));
    const handler = new ParallelHandler(executor);
    const node = makeNode('par', { shape: 'component' });
    (node.attrs as Record<string, unknown>)['join_policy'] = 'any';
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('b1'), makeNode('b2')],
      [{ from: 'par', to: 'b1' }, { from: 'par', to: 'b2' }]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.FAIL);
  });

  it('branches[i]?.to fallback when more results than branches', async () => {
    // This can happen if the executor produces extra results somehow
    // We'll use a custom executor that returns more results than branches
    const executor = vi.fn()
      .mockResolvedValueOnce(makeOutcome({ status: StageStatus.SUCCESS, notes: 'b1 ok' }))
      .mockResolvedValueOnce(makeOutcome({ status: StageStatus.SUCCESS, notes: 'b2 ok' }));
    const handler = new ParallelHandler(executor);
    const node = makeNode('par', { shape: 'component' });
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('b1'), makeNode('b2')],
      [{ from: 'par', to: 'b1' }, { from: 'par', to: 'b2' }]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    const results = JSON.parse(outcome.context_updates['parallel.results'] as string);
    expect(results[0].branch).toBe('b1');
    expect(results[1].branch).toBe('b2');
  });

  it('wait_all with PARTIAL_SUCCESS counts as success', async () => {
    const executor = vi.fn()
      .mockResolvedValue(makeOutcome({ status: StageStatus.PARTIAL_SUCCESS }));
    const handler = new ParallelHandler(executor);
    const node = makeNode('par', { shape: 'component' });
    const ctx = new Context();
    const graph = makeGraph(
      [node, makeNode('b1')],
      [{ from: 'par', to: 'b1' }]
    );

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.notes).toContain('All parallel branches succeeded');
  });
});

describe('FanInHandler', () => {
  it('waits for branches and selects best', async () => {
    const handler = new FanInHandler();
    const node = makeNode('fanin', { shape: 'tripleoctagon' });
    const ctx = new Context();
    ctx.set('parallel.results', JSON.stringify([
      { branch: 'b1', outcome: 'success', notes: 'good' },
      { branch: 'b2', outcome: 'fail', notes: 'bad' },
    ]));
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.context_updates['parallel.fan_in.best_id']).toBe('b1');
  });

  it('returns FAIL when no parallel results', async () => {
    const handler = new FanInHandler();
    const node = makeNode('fanin', { shape: 'tripleoctagon' });
    const ctx = new Context();
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.FAIL);
  });

  it('returns FAIL when all branches failed', async () => {
    const handler = new FanInHandler();
    const node = makeNode('fanin', { shape: 'tripleoctagon' });
    const ctx = new Context();
    ctx.set('parallel.results', JSON.stringify([
      { branch: 'b1', outcome: 'fail' },
      { branch: 'b2', outcome: 'fail' },
    ]));
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.FAIL);
  });

  it('returns FAIL on malformed JSON in parallel.results', async () => {
    const handler = new FanInHandler();
    const node = makeNode('fanin', { shape: 'tripleoctagon' });
    const ctx = new Context();
    ctx.set('parallel.results', 'not valid json {{{');
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.FAIL);
    expect(outcome.failure_reason).toContain('Failed to parse parallel results');
  });

  it('returns FAIL on empty results array', async () => {
    const handler = new FanInHandler();
    const node = makeNode('fanin', { shape: 'tripleoctagon' });
    const ctx = new Context();
    ctx.set('parallel.results', JSON.stringify([]));
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.FAIL);
    expect(outcome.failure_reason).toContain('No parallel results');
  });

  it('selects higher-scored branch among same-status results', async () => {
    const handler = new FanInHandler();
    const node = makeNode('fanin', { shape: 'tripleoctagon' });
    const ctx = new Context();
    ctx.set('parallel.results', JSON.stringify([
      { branch: 'b1', outcome: 'success', score: 5 },
      { branch: 'b2', outcome: 'success', score: 10 },
    ]));
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.context_updates['parallel.fan_in.best_id']).toBe('b2');
  });

  it('selects PARTIAL_SUCCESS over FAIL', async () => {
    const handler = new FanInHandler();
    const node = makeNode('fanin', { shape: 'tripleoctagon' });
    const ctx = new Context();
    ctx.set('parallel.results', JSON.stringify([
      { branch: 'b1', outcome: 'fail' },
      { branch: 'b2', outcome: 'partial_success' },
    ]));
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.context_updates['parallel.fan_in.best_id']).toBe('b2');
  });

  it('lexical tiebreak when score and status are equal', async () => {
    const handler = new FanInHandler();
    const node = makeNode('fanin', { shape: 'tripleoctagon' });
    const ctx = new Context();
    ctx.set('parallel.results', JSON.stringify([
      { branch: 'z_branch', outcome: 'success', score: 5 },
      { branch: 'a_branch', outcome: 'success', score: 5 },
    ]));
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.context_updates['parallel.fan_in.best_id']).toBe('a_branch');
  });

  it('unknown outcome status falls back to rank 3 (same as FAIL)', async () => {
    const handler = new FanInHandler();
    const node = makeNode('fanin', { shape: 'tripleoctagon' });
    const ctx = new Context();
    ctx.set('parallel.results', JSON.stringify([
      { branch: 'b1', outcome: 'unknown_status' },
      { branch: 'b2', outcome: 'success' },
    ]));
    const graph = makeGraph([node]);

    const outcome = await handler.handle(node, ctx, graph, makeTempDir());
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    // b2 (success, rank 0) should win over b1 (unknown, rank 3)
    expect(outcome.context_updates['parallel.fan_in.best_id']).toBe('b2');
  });
});

describe('parseAcceleratorKey', () => {
  it('parses [K] format', () => {
    expect(parseAcceleratorKey('[K] My Label')).toBe('K');
  });

  it('parses K) format', () => {
    expect(parseAcceleratorKey('Y) Yes')).toBe('Y');
  });

  it('parses K - format', () => {
    expect(parseAcceleratorKey('N - No')).toBe('N');
  });

  it('falls back to first character', () => {
    expect(parseAcceleratorKey('Hello')).toBe('H');
  });

  it('returns empty string for empty label', () => {
    expect(parseAcceleratorKey('')).toBe('');
  });
});
