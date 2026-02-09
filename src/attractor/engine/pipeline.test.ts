import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PipelineEngine, delayForAttempt } from './pipeline.js';
import type { PipelineConfig } from './pipeline.js';
import { Context } from './context.js';
import type { CodergenBackend, NodeHandler, Node, PipelineContext, Graph, Outcome, BackoffConfig } from '../types.js';
import { StageStatus, makeOutcome, DEFAULT_NODE_ATTRIBUTES, DEFAULT_EDGE_ATTRIBUTES, DEFAULT_GRAPH_ATTRIBUTES } from '../types.js';
import { parseDot } from '../parser/dot-parser.js';

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `attractor-pipe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    logsRoot: makeTempDir(),
    ...overrides,
  };
}

const successBackend: CodergenBackend = {
  run: vi.fn().mockResolvedValue(
    makeOutcome({ status: StageStatus.SUCCESS, preferred_label: '', notes: 'mock success' })
  ),
};

const failBackend: CodergenBackend = {
  run: vi.fn().mockResolvedValue(
    makeOutcome({ status: StageStatus.FAIL, failure_reason: 'mock failure' })
  ),
};

describe('PipelineEngine', () => {
  it('executes linear 3-node pipeline (start -> work -> done)', async () => {
    const config = makeConfig({ backend: successBackend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [shape=box, prompt="Do work"]
        done [shape=Msquare]
        start -> work -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.completed_nodes).toContain('start');
    expect(result.completed_nodes).toContain('work');
  });

  it('executes with conditional branching (success/fail paths)', async () => {
    const config = makeConfig({ backend: successBackend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [shape=box, prompt="Do work"]
        check [shape=diamond]
        good [shape=box, prompt="Good path"]
        done [shape=Msquare]
        start -> work -> check
        check -> good [condition="outcome=success"]
        check -> done [condition="outcome=fail"]
        good -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.completed_nodes).toContain('check');
  });

  it('goal gate blocks exit when unsatisfied (no retry target -> throws)', async () => {
    const config = makeConfig({
      backend: {
        run: vi.fn().mockResolvedValue(
          makeOutcome({ status: StageStatus.FAIL, failure_reason: 'failed' })
        ),
      },
    });
    const engine = new PipelineEngine(config);

    // A pipeline where a goal_gate node fails and there's NO retry_target
    // The engine should throw because the goal gate is unsatisfied with no way to retry
    await expect(engine.runFromSource(`
      digraph G {
        default_max_retry = 0
        start [shape=Mdiamond]
        work [shape=box, prompt="Work", goal_gate=true, max_retries=1]
        done [shape=Msquare]
        start -> work -> done
      }
    `)).rejects.toThrow(/Goal gate unsatisfied/);
  }, 10000);

  it('goal gate allows exit when all satisfied', async () => {
    const config = makeConfig({ backend: successBackend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [shape=box, prompt="Work", goal_gate=true]
        done [shape=Msquare]
        start -> work -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
  });

  it('auto_status synthesizes SUCCESS when handler writes no status', async () => {
    // Use a custom handler that does NOT write status.json
    const customHandler: NodeHandler = {
      async handle(_node: Node, _ctx: PipelineContext, _graph: Graph, logsRoot: string): Promise<Outcome> {
        // Don't write status.json
        const stageDir = join(logsRoot, _node.id);
        mkdirSync(stageDir, { recursive: true });
        return makeOutcome({ status: StageStatus.FAIL, failure_reason: 'should be overridden' });
      },
    };

    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('custom', customHandler);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [type=custom, auto_status=true]
        done [shape=Msquare]
        start -> work -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
  });

  it('SKIPPED status: node excluded from completedNodes', async () => {
    const skippedHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        return makeOutcome({ status: StageStatus.SKIPPED });
      },
    };

    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('skippable', skippedHandler);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        skip [type=skippable]
        done [shape=Msquare]
        start -> skip -> done
      }
    `);

    expect(result.completed_nodes).not.toContain('skip');
  });
});

describe('delayForAttempt', () => {
  it('calculates backoff delay', () => {
    const config: BackoffConfig = {
      initial_delay_ms: 100,
      backoff_factor: 2,
      max_delay_ms: 10000,
      jitter: false,
    };

    expect(delayForAttempt(1, config)).toBe(100);
    expect(delayForAttempt(2, config)).toBe(200);
    expect(delayForAttempt(3, config)).toBe(400);
  });

  it('caps at max_delay_ms', () => {
    const config: BackoffConfig = {
      initial_delay_ms: 100,
      backoff_factor: 10,
      max_delay_ms: 500,
      jitter: false,
    };

    expect(delayForAttempt(5, config)).toBe(500);
  });

  it('adds jitter when enabled', () => {
    const config: BackoffConfig = {
      initial_delay_ms: 1000,
      backoff_factor: 1,
      max_delay_ms: 10000,
      jitter: true,
    };

    const delays = new Set<number>();
    for (let i = 0; i < 20; i++) {
      delays.add(delayForAttempt(1, config));
    }
    // With jitter, we should get varying delays (0.5x to 1.5x)
    expect(delays.size).toBeGreaterThan(1);
  });
});

describe('buildRetryPolicy', () => {
  it('falls back to graph.attrs.default_max_retry when node max_retries=0', async () => {
    let attemptCount = 0;
    const retryBackend: CodergenBackend = {
      run: vi.fn().mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 3) {
          return makeOutcome({ status: StageStatus.RETRY });
        }
        return makeOutcome({ status: StageStatus.SUCCESS });
      }),
    };

    const config = makeConfig({ backend: retryBackend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph G {
        default_max_retry = 5
        start [shape=Mdiamond]
        work [shape=box, prompt="Retry work"]
        done [shape=Msquare]
        start -> work -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(attemptCount).toBe(3);
  });
});
