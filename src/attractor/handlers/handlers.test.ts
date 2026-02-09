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
});
