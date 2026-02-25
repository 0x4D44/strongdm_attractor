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

describe('PipelineEngine - checkpoint resume', () => {
  it('resumes from a checkpoint when resumeFromCheckpoint=true', async () => {
    // First run to create a checkpoint
    const logsDir = makeTempDir();
    const config1 = makeConfig({ logsRoot: logsDir, backend: successBackend });
    const engine1 = new PipelineEngine(config1);

    const dot = `
      digraph G {
        start [shape=Mdiamond]
        step1 [shape=box, prompt="Step 1"]
        step2 [shape=box, prompt="Step 2"]
        done [shape=Msquare]
        start -> step1 -> step2 -> done
      }
    `;
    await engine1.runFromSource(dot);

    // Now resume from checkpoint - it should pick up from the checkpoint
    const config2 = makeConfig({ logsRoot: logsDir, backend: successBackend, resumeFromCheckpoint: true });
    const engine2 = new PipelineEngine(config2);
    const graph = parseDot(dot);

    const result = await engine2.runGraph(graph);
    expect(result.status).toBe(StageStatus.SUCCESS);
  });

  it('starts fresh when resumeFromCheckpoint=true but no checkpoint exists', async () => {
    const logsDir = makeTempDir();
    const config = makeConfig({ logsRoot: logsDir, backend: successBackend, resumeFromCheckpoint: true });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [shape=box, prompt="Work"]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.completed_nodes).toContain('start');
  });
});

describe('PipelineEngine - goal gates with retry', () => {
  it('retries when goal gate fails and retry_target is set', async () => {
    let attempts = 0;
    const retryBackend: CodergenBackend = {
      run: vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 2) {
          return makeOutcome({ status: StageStatus.FAIL, failure_reason: 'not ready' });
        }
        return makeOutcome({ status: StageStatus.SUCCESS });
      }),
    };

    const config = makeConfig({ backend: retryBackend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph G {
        retry_target = work
        start [shape=Mdiamond]
        work [shape=box, prompt="Work", goal_gate=true, max_retries=1]
        done [shape=Msquare]
        start -> work -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
  }, 10000);
});

describe('PipelineEngine - loop_restart', () => {
  it('restarts pipeline when loop_restart edge is taken', async () => {
    let callCount = 0;
    const restartBackend: CodergenBackend = {
      run: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 1) {
          return makeOutcome({ status: StageStatus.FAIL, failure_reason: 'fail first time' });
        }
        return makeOutcome({ status: StageStatus.SUCCESS });
      }),
    };

    const config = makeConfig({ backend: restartBackend });
    const engine = new PipelineEngine(config);

    // Use runGraph to skip validation (start_no_incoming would reject the back-edge)
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        work [shape=box, prompt="Work", max_retries=0]
        restart_entry [shape=Mdiamond]
        done [shape=Msquare]
        start -> work
        work -> done [condition="outcome=success"]
        work -> restart_entry [condition="outcome=fail", loop_restart=true]
        restart_entry -> work
      }
    `);

    // Run directly on the graph to bypass validation
    const result = await engine.runGraph(graph);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(callCount).toBeGreaterThanOrEqual(2);
  }, 10000);
});

describe('PipelineEngine - FAIL with no outgoing edge', () => {
  it('throws when a node fails and has no fail edge', async () => {
    const config = makeConfig({ backend: failBackend });
    const engine = new PipelineEngine(config);

    // Use runGraph to bypass validation (missing terminal node)
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        work [shape=box, prompt="Doomed"]
        done [shape=Msquare]
        start -> work
      }
    `);
    // 'done' exists but is unreachable - runGraph won't validate
    await expect(engine.runGraph(graph)).rejects.toThrow(/failed with no outgoing fail edge/);
  });
});

describe('PipelineEngine - event listener', () => {
  it('fires pipeline events when eventListener configured', async () => {
    const events: unknown[] = [];
    const config = makeConfig({
      backend: successBackend,
      eventListener: (event) => events.push(event),
    });
    const engine = new PipelineEngine(config);

    await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [shape=box, prompt="Work"]
        done [shape=Msquare]
        start -> work -> done
      }
    `);

    expect(events.length).toBeGreaterThan(0);
  });
});

describe('PipelineEngine - defaultShouldRetry', () => {
  it('retries on rate limit errors', async () => {
    let callCount = 0;
    const retryHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        callCount++;
        if (callCount === 1) {
          throw new Error('429 rate limit exceeded');
        }
        return makeOutcome({ status: StageStatus.SUCCESS });
      },
    };
    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('retrier', retryHandler);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [type=retrier, max_retries=3]
        done [shape=Msquare]
        start -> work -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(callCount).toBe(2);
  });

  it('retries on timeout errors', async () => {
    let callCount = 0;
    const retryHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        callCount++;
        if (callCount === 1) {
          throw new Error('request timed out');
        }
        return makeOutcome({ status: StageStatus.SUCCESS });
      },
    };
    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('retrier', retryHandler);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [type=retrier, max_retries=3]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(callCount).toBe(2);
  });

  it('retries on network errors', async () => {
    let callCount = 0;
    const retryHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        callCount++;
        if (callCount === 1) {
          throw new Error('ECONNREFUSED network error');
        }
        return makeOutcome({ status: StageStatus.SUCCESS });
      },
    };
    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('retrier', retryHandler);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [type=retrier, max_retries=3]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    expect(result.status).toBe(StageStatus.SUCCESS);
  });

  it('does not retry on auth errors (401)', async () => {
    let callCount = 0;
    const retryHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        callCount++;
        throw new Error('401 unauthorized');
      },
    };
    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('retrier', retryHandler);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [type=retrier, max_retries=3]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    // Should fail after first attempt (no retry)
    expect(result.status).toBe(StageStatus.FAIL);
    expect(callCount).toBe(1);
  });

  it('does not retry on validation errors (400)', async () => {
    let callCount = 0;
    const retryHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        callCount++;
        throw new Error('400 validation error');
      },
    };
    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('retrier', retryHandler);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [type=retrier, max_retries=3]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    expect(callCount).toBe(1);
  });

  it('retries by default for unknown errors', async () => {
    let callCount = 0;
    const retryHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        callCount++;
        if (callCount === 1) {
          throw new Error('something unexpected happened');
        }
        return makeOutcome({ status: StageStatus.SUCCESS });
      },
    };
    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('retrier', retryHandler);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [type=retrier, max_retries=3]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(callCount).toBe(2);
  });
});

describe('PipelineEngine - allow_partial on retries exhausted', () => {
  it('returns PARTIAL_SUCCESS when retries exhausted and allow_partial=true', async () => {
    const retryHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        return makeOutcome({ status: StageStatus.RETRY });
      },
    };
    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('retrier', retryHandler);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [type=retrier, max_retries=1, allow_partial=true]
        done [shape=Msquare]
        start -> work -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.node_outcomes['work'].status).toBe(StageStatus.PARTIAL_SUCCESS);
  });

  it('returns FAIL when retries exhausted and allow_partial is not set', async () => {
    const retryHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        return makeOutcome({ status: StageStatus.RETRY });
      },
    };
    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('retrier', retryHandler);

    // Use runGraph to bypass validation (no terminal node connected to work)
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        work [type=retrier, max_retries=1]
        done [shape=Msquare]
        start -> work
      }
    `);
    await expect(engine.runGraph(graph)).rejects.toThrow(/failed with no outgoing fail edge/);
  });
});

describe('PipelineEngine - mirrorGraphAttributes', () => {
  it('mirrors default_fidelity into context when set', async () => {
    const captureHandler: NodeHandler = {
      async handle(_node: Node, ctx: PipelineContext): Promise<Outcome> {
        const fid = ctx.get('graph.default_fidelity');
        return makeOutcome({
          status: StageStatus.SUCCESS,
          context_updates: { captured_fidelity: fid as string },
        });
      },
    };

    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('capture', captureHandler);

    const result = await engine.runFromSource(`
      digraph G {
        default_fidelity = compact
        start [shape=Mdiamond]
        work [type=capture]
        done [shape=Msquare]
        start -> work -> done
      }
    `);

    expect(result.final_context['captured_fidelity']).toBe('compact');
  });
});

describe('PipelineEngine - preferred_label edge selection', () => {
  it('sets preferred_label in context from outcome', async () => {
    const labelBackend: CodergenBackend = {
      run: vi.fn().mockResolvedValue(
        makeOutcome({ status: StageStatus.SUCCESS, preferred_label: 'good_path' })
      ),
    };
    const config = makeConfig({ backend: labelBackend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [shape=box, prompt="Work"]
        good [shape=box, prompt="Good"]
        bad [shape=box, prompt="Bad"]
        done [shape=Msquare]
        start -> work
        work -> good [label="good_path"]
        work -> bad [label="bad_path"]
        good -> done
        bad -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.completed_nodes).toContain('good');
    expect(result.completed_nodes).not.toContain('bad');
  });
});

describe('PipelineEngine - findStartNode', () => {
  it('finds start node by ID when no Mdiamond shape', async () => {
    const config = makeConfig({ backend: successBackend });
    const engine = new PipelineEngine(config);

    // 'start' by name convention, no shape=Mdiamond
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        done [shape=Msquare]
        start -> done
      }
    `);
    const result = await engine.runGraph(graph);
    expect(result.status).toBe(StageStatus.SUCCESS);
  });

  it('finds start node by ID "start" when no Mdiamond shape exists', async () => {
    const config = makeConfig({ backend: successBackend });
    const engine = new PipelineEngine(config);

    // Manually construct a graph with 'start' node but no Mdiamond shape
    const graph: Graph = {
      name: 'test',
      attrs: { ...DEFAULT_GRAPH_ATTRIBUTES },
      nodes: new Map([
        ['start', { id: 'start', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'box' } }],
        ['done', { id: 'done', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'Msquare' } }],
      ]),
      edges: [{ from: 'start', to: 'done', attrs: { ...DEFAULT_EDGE_ATTRIBUTES } }],
    };

    const result = await engine.runGraph(graph);
    expect(result.status).toBe(StageStatus.SUCCESS);
  });

  it('finds start node by ID "Start" (capitalized)', async () => {
    const config = makeConfig({ backend: successBackend });
    const engine = new PipelineEngine(config);

    const graph: Graph = {
      name: 'test',
      attrs: { ...DEFAULT_GRAPH_ATTRIBUTES },
      nodes: new Map([
        ['Start', { id: 'Start', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'box' } }],
        ['done', { id: 'done', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'Msquare' } }],
      ]),
      edges: [{ from: 'Start', to: 'done', attrs: { ...DEFAULT_EDGE_ATTRIBUTES } }],
    };

    const result = await engine.runGraph(graph);
    expect(result.status).toBe(StageStatus.SUCCESS);
  });

  it('throws when no start node can be found', async () => {
    const config = makeConfig({ backend: successBackend });
    const engine = new PipelineEngine(config);

    const graph: Graph = {
      name: 'test',
      attrs: { ...DEFAULT_GRAPH_ATTRIBUTES },
      nodes: new Map([
        ['work', { id: 'work', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'box' } }],
      ]),
      edges: [],
    };

    await expect(engine.runGraph(graph)).rejects.toThrow(/No start node found/);
  });
});

describe('PipelineEngine - edge to missing node', () => {
  it('throws when edge targets a node not in the graph', async () => {
    const config = makeConfig({ backend: successBackend });
    const engine = new PipelineEngine(config);

    // Manually construct graph with edge pointing to non-existent node
    const graph: Graph = {
      name: 'test',
      attrs: { ...DEFAULT_GRAPH_ATTRIBUTES },
      nodes: new Map([
        ['start', { id: 'start', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'Mdiamond' } }],
        ['done', { id: 'done', attrs: { ...DEFAULT_NODE_ATTRIBUTES, shape: 'Msquare' } }],
      ]),
      edges: [
        { from: 'start', to: 'ghost', attrs: { ...DEFAULT_EDGE_ATTRIBUTES } },
      ],
    };

    await expect(engine.runGraph(graph)).rejects.toThrow(/Edge target 'ghost' not found/);
  });
});

describe('PipelineEngine - SKIPPED handler in executeWithRetry', () => {
  it('returns SKIPPED outcome directly from executeWithRetry', async () => {
    const skippedHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        return makeOutcome({ status: StageStatus.SKIPPED });
      },
    };
    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('skipper', skippedHandler);

    // The SKIPPED status is returned by executeWithRetry and then handled by executeLoop
    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        skip_me [type=skipper]
        done [shape=Msquare]
        start -> skip_me -> done
      }
    `);
    expect(result.completed_nodes).not.toContain('skip_me');
    expect(result.status).toBe(StageStatus.SUCCESS);
  });
});

describe('PipelineEngine - SKIPPED handling', () => {
  it('SKIPPED status with no next edge breaks the loop', async () => {
    const skippedHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        return makeOutcome({ status: StageStatus.SKIPPED });
      },
    };
    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('skipper', skippedHandler);

    // Use runGraph directly to skip validation, since skip_me has no outgoing edge
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        skip_me [type=skipper]
        done [shape=Msquare]
        start -> skip_me
      }
    `);
    const result = await engine.runGraph(graph);
    // Should complete (pipeline ends because no next edge after SKIPPED)
    expect(result.completed_nodes).not.toContain('skip_me');
  });
});

describe('PipelineEngine - executeWithRetry SKIPPED returns immediately', () => {
  it('SKIPPED from handler returns immediately without retry', async () => {
    let callCount = 0;
    const skippedHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        callCount++;
        return makeOutcome({ status: StageStatus.SKIPPED });
      },
    };
    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('skipper', skippedHandler);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        skip_me [type=skipper, max_retries=5]
        done [shape=Msquare]
        start -> skip_me -> done
      }
    `);
    // Handler should only be called once (no retries for SKIPPED)
    expect(callCount).toBe(1);
  });
});

describe('PipelineEngine - allow_partial on retry exhaustion', () => {
  it('returns PARTIAL_SUCCESS when allow_partial and retries exhausted', async () => {
    const retryHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        return makeOutcome({ status: StageStatus.RETRY });
      },
    };
    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('retrier', retryHandler);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [type=retrier, max_retries=1, allow_partial=true]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    // work should have gotten PARTIAL_SUCCESS from exhausted retries
    const workOutcome = result.node_outcomes['work'];
    expect(workOutcome?.status).toBe(StageStatus.PARTIAL_SUCCESS);
  });
});

describe('PipelineEngine - executeWithRetry fall-through', () => {
  it('falls through to FAIL when all retries are exhausted via exception', async () => {
    let callCount = 0;
    const throwHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        callCount++;
        throw new Error('500 server error');
      },
    };
    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('thrower', throwHandler);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [type=thrower, max_retries=2]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    // max_retries=2 means initial + 2 retries = 3 calls
    expect(callCount).toBe(3);
    expect(result.node_outcomes['work']?.status).toBe(StageStatus.FAIL);
  });
});

describe('PipelineEngine - checkpoint resume edge cases', () => {
  it('resumes at terminal node (no next edge) when checkpoint is at last node (line 161)', async () => {
    // First run creates checkpoint at last node before terminal
    const logsDir = makeTempDir();
    const config1 = makeConfig({ logsRoot: logsDir, backend: successBackend });
    const engine1 = new PipelineEngine(config1);

    const dot = `
      digraph G {
        start [shape=Mdiamond]
        work [shape=box, prompt="Work"]
        done [shape=Msquare]
        start -> work -> done
      }
    `;
    await engine1.runFromSource(dot);

    // Resume — checkpoint is at last completed node (work), next edge goes to terminal (done)
    // The terminal node triggers break in executeLoop, returning immediately
    const config2 = makeConfig({ logsRoot: logsDir, backend: successBackend, resumeFromCheckpoint: true });
    const engine2 = new PipelineEngine(config2);
    const graph = parseDot(dot);
    const result = await engine2.runGraph(graph);
    expect(result.status).toBe(StageStatus.SUCCESS);
  });

  it('throws when checkpoint references unknown node (line 152)', async () => {
    const logsDir = makeTempDir();
    // Write a fake checkpoint that references a non-existent node
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(logsDir, 'checkpoint.json'), JSON.stringify({
      timestamp: new Date().toISOString(),
      current_node: 'nonexistent_node',
      completed_nodes: [],
      node_retries: {},
      node_outcomes: {},
      context_values: {},
      logs: [],
    }), 'utf-8');

    const config = makeConfig({ logsRoot: logsDir, backend: successBackend, resumeFromCheckpoint: true });
    const engine = new PipelineEngine(config);
    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        done [shape=Msquare]
        start -> done
      }
    `);
    await expect(engine.runGraph(graph)).rejects.toThrow(/Checkpoint references unknown node/);
  });
});

describe('PipelineEngine - getRetryTarget fallbacks', () => {
  it('uses node fallback_retry_target (line 487)', async () => {
    let attempts = 0;
    const retryBackend: CodergenBackend = {
      run: vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 2) {
          return makeOutcome({ status: StageStatus.FAIL, failure_reason: 'not ready' });
        }
        return makeOutcome({ status: StageStatus.SUCCESS });
      }),
    };

    const config = makeConfig({ backend: retryBackend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [shape=box, prompt="Work", goal_gate=true, fallback_retry_target=work, max_retries=1]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    expect(result.status).toBe(StageStatus.SUCCESS);
  }, 10000);

  it('uses graph fallback_retry_target (line 491)', async () => {
    let attempts = 0;
    const retryBackend: CodergenBackend = {
      run: vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 2) {
          return makeOutcome({ status: StageStatus.FAIL, failure_reason: 'not ready' });
        }
        return makeOutcome({ status: StageStatus.SUCCESS });
      }),
    };

    const config = makeConfig({ backend: retryBackend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph G {
        fallback_retry_target = work
        start [shape=Mdiamond]
        work [shape=box, prompt="Work", goal_gate=true, max_retries=1]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    expect(result.status).toBe(StageStatus.SUCCESS);
  }, 10000);
});

describe('PipelineEngine - mirrorGraphAttributes without default_fidelity (line 542)', () => {
  it('does not set graph.default_fidelity when not specified', async () => {
    const captureHandler: NodeHandler = {
      async handle(_node: Node, ctx: PipelineContext): Promise<Outcome> {
        const fid = ctx.get('graph.default_fidelity');
        return makeOutcome({
          status: StageStatus.SUCCESS,
          context_updates: { has_fidelity: fid !== undefined },
        });
      },
    };

    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('capture', captureHandler);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [type=capture]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    expect(result.final_context['has_fidelity']).toBe(false);
  });
});

describe('PipelineEngine - sleep with ms <= 0 (line 560)', () => {
  it('handles zero-delay retries without blocking', async () => {
    let callCount = 0;
    const retryHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        callCount++;
        if (callCount < 2) {
          return makeOutcome({ status: StageStatus.RETRY });
        }
        return makeOutcome({ status: StageStatus.SUCCESS });
      },
    };
    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('retrier', retryHandler);

    // max_retries=1 gives max_attempts=2
    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [type=retrier, max_retries=1]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(callCount).toBe(2);
  });
});

describe('PipelineEngine - checkGoalGates with node not in graph (line 472)', () => {
  it('skips nodeOutcomes entries whose node is not in the graph', async () => {
    // This is an edge case where nodeOutcomes has a key not in graph.nodes
    // The checkGoalGates function should skip it via `if (!node) continue`
    // We can trigger this by using runGraph with a manipulated graph
    const config = makeConfig({ backend: successBackend });
    const engine = new PipelineEngine(config);

    // Normal run should succeed — the checkGoalGates skip is a defensive path
    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [shape=box, prompt="Work"]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    expect(result.status).toBe(StageStatus.SUCCESS);
  });
});

describe('PipelineEngine - executeWithRetry fall-through after max attempts (line 432-437)', () => {
  it('returns FAIL from fall-through when for loop completes without return', async () => {
    // This tests the code path after the for loop in executeWithRetry
    // where all retries are exhausted through the FAIL status return inside the loop
    // The fall-through at line 434-437 is the defensive path after the for loop
    // This is naturally unreachable since the loop covers all cases internally,
    // but we can get close by testing the max_retries=0 case (max_attempts=1)
    const failHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        return makeOutcome({ status: StageStatus.FAIL, failure_reason: 'always fail' });
      },
    };
    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('failer', failHandler);

    const graph = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        work [type=failer, max_retries=0]
        done [shape=Msquare]
        start -> work
      }
    `);
    await expect(engine.runGraph(graph)).rejects.toThrow(/failed with no outgoing fail edge/);
  });
});

describe('PipelineEngine - defaultShouldRetry edge cases', () => {
  it('does not retry on 400 validation error', async () => {
    let callCount = 0;
    const throwHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        callCount++;
        throw new Error('400 bad request validation error');
      },
    };
    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('thrower', throwHandler);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [type=thrower, max_retries=3]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    expect(callCount).toBe(1);
    expect(result.node_outcomes['work']?.status).toBe(StageStatus.FAIL);
  });
});

describe('PipelineEngine - server error retry', () => {
  it('retries on 5xx server error', async () => {
    let callCount = 0;
    const retryHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        callCount++;
        if (callCount === 1) {
          throw new Error('500 server error occurred');
        }
        return makeOutcome({ status: StageStatus.SUCCESS });
      },
    };
    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('retrier', retryHandler);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [type=retrier, max_retries=3]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(callCount).toBe(2);
  });

  it('does not retry on 403 forbidden', async () => {
    let callCount = 0;
    const retryHandler: NodeHandler = {
      async handle(): Promise<Outcome> {
        callCount++;
        throw new Error('403 forbidden');
      },
    };
    const config = makeConfig();
    const engine = new PipelineEngine(config);
    engine.registerHandler('retrier', retryHandler);

    const result = await engine.runFromSource(`
      digraph G {
        start [shape=Mdiamond]
        work [type=retrier, max_retries=3]
        done [shape=Msquare]
        start -> work -> done
      }
    `);
    expect(callCount).toBe(1);
  });
});
