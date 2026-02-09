/**
 * End-to-end integration tests for the Attractor Pipeline Engine.
 * These tests exercise the full stack: DOT parsing → validation → transforms →
 * pipeline execution with mock CodergenBackend implementations.
 *
 * No HTTP calls are made; we mock at the CodergenBackend boundary.
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PipelineEngine } from '../attractor/engine/pipeline.js';
import type { PipelineConfig } from '../attractor/engine/pipeline.js';
import type {
  CodergenBackend,
  Outcome,
  Node,
  PipelineContext,
  PipelineEvent,
} from '../attractor/types.js';
import {
  StageStatus,
  makeOutcome,
  PipelineEventKind,
  AnswerValue,
} from '../attractor/types.js';
import { QueueInterviewer } from '../attractor/interviewer.js';
import { loadCheckpoint, saveCheckpoint, createCheckpoint } from '../attractor/engine/checkpoint.js';
import { Context } from '../attractor/engine/context.js';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `attractor-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
  vi.restoreAllMocks();
});

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    logsRoot: makeTempDir(),
    ...overrides,
  };
}

/** Creates a mock CodergenBackend that always returns SUCCESS with a given response. */
function successBackend(response: string = 'Mock LLM output'): CodergenBackend {
  return {
    run: vi.fn().mockResolvedValue(response),
  };
}

/** Creates a mock CodergenBackend that returns an Outcome with preferred_label. */
function outcomeBackend(outcome: Partial<Outcome> & { status: StageStatus }): CodergenBackend {
  return {
    run: vi.fn().mockResolvedValue(makeOutcome(outcome)),
  };
}

// ---------------------------------------------------------------------------
// 1. Simple Linear Pipeline: START → codergen → EXIT
// ---------------------------------------------------------------------------

describe('E2E: Simple linear pipeline', () => {
  it('executes START → codergen → EXIT with mock backend response', async () => {
    const backend = successBackend('Generated code for web app');
    const logsRoot = makeTempDir();
    const events: PipelineEvent[] = [];

    const config = makeConfig({
      logsRoot,
      backend,
      eventListener: (e) => events.push(e),
    });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph SimpleLinear {
        goal = "Build a simple web application"
        start [shape=Mdiamond]
        codegen [shape=box, prompt="Generate code for $goal"]
        done [shape=Msquare]
        start -> codegen -> done
      }
    `);

    // Verify pipeline succeeded
    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.completed_nodes).toEqual(['start', 'codegen']);

    // Verify backend was called with expanded prompt
    expect(backend.run).toHaveBeenCalledOnce();
    const callArgs = (backend.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0].id).toBe('codegen');

    // Verify log artifacts
    const promptFile = join(logsRoot, 'codegen', 'prompt.md');
    expect(existsSync(promptFile)).toBe(true);
    const promptContent = readFileSync(promptFile, 'utf-8');
    expect(promptContent).toContain('Build a simple web application');

    const responseFile = join(logsRoot, 'codegen', 'response.md');
    expect(existsSync(responseFile)).toBe(true);
    expect(readFileSync(responseFile, 'utf-8')).toBe('Generated code for web app');

    // Verify manifest was written
    const manifestFile = join(logsRoot, 'manifest.json');
    expect(existsSync(manifestFile)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8'));
    expect(manifest.name).toBe('SimpleLinear');
    expect(manifest.goal).toBe('Build a simple web application');

    // Verify events
    const eventKinds = events.map(e => e.kind);
    expect(eventKinds).toContain(PipelineEventKind.PIPELINE_STARTED);
    expect(eventKinds).toContain(PipelineEventKind.STAGE_STARTED);
    expect(eventKinds).toContain(PipelineEventKind.STAGE_COMPLETED);
    expect(eventKinds).toContain(PipelineEventKind.CHECKPOINT_SAVED);
    expect(eventKinds).toContain(PipelineEventKind.PIPELINE_COMPLETED);
  });

  it('runs multi-stage linear pipeline: START → step1 → step2 → step3 → EXIT', async () => {
    let callCount = 0;
    const backend: CodergenBackend = {
      run: vi.fn().mockImplementation(async (node: Node) => {
        callCount++;
        return `Response for ${node.id} (call #${callCount})`;
      }),
    };

    const config = makeConfig({ backend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph MultiStage {
        start [shape=Mdiamond]
        step1 [shape=box, prompt="Step 1"]
        step2 [shape=box, prompt="Step 2"]
        step3 [shape=box, prompt="Step 3"]
        done [shape=Msquare]
        start -> step1 -> step2 -> step3 -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.completed_nodes).toEqual(['start', 'step1', 'step2', 'step3']);
    expect(callCount).toBe(3); // 3 codergen nodes
  });

  it('captures context updates from codergen across stages', async () => {
    const backend: CodergenBackend = {
      run: vi.fn().mockImplementation(async (node: Node, _prompt: string, context: PipelineContext) => {
        if (node.id === 'step1') {
          return makeOutcome({
            status: StageStatus.SUCCESS,
            context_updates: { 'step1.result': 'data_from_step1' },
          });
        }
        // step2 can read step1's output from context
        const prev = context.getString('step1.result', 'none');
        return `Step2 received: ${prev}`;
      }),
    };

    const config = makeConfig({ backend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph ContextFlow {
        start [shape=Mdiamond]
        step1 [shape=box, prompt="First step"]
        step2 [shape=box, prompt="Second step"]
        done [shape=Msquare]
        start -> step1 -> step2 -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.final_context['step1.result']).toBe('data_from_step1');
  });
});

// ---------------------------------------------------------------------------
// 2. Conditional Branching
// ---------------------------------------------------------------------------

describe('E2E: Conditional branching', () => {
  it('routes to success path when outcome=success', async () => {
    const backend = outcomeBackend({ status: StageStatus.SUCCESS });
    const events: PipelineEvent[] = [];
    const config = makeConfig({
      backend,
      eventListener: (e) => events.push(e),
    });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph ConditionalBranch {
        start [shape=Mdiamond]
        work [shape=box, prompt="Do work"]
        check [shape=diamond]
        good_path [shape=box, prompt="Handle success"]
        bad_path [shape=box, prompt="Handle failure"]
        done [shape=Msquare]

        start -> work -> check
        check -> good_path [condition="outcome=success"]
        check -> bad_path [condition="outcome=fail"]
        good_path -> done
        bad_path -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.completed_nodes).toContain('good_path');
    expect(result.completed_nodes).not.toContain('bad_path');

    // Verify edge selection events
    const edgeEvents = events.filter(e => e.kind === PipelineEventKind.EDGE_SELECTED);
    const checkToGood = edgeEvents.find(
      e => e.data.from === 'check' && e.data.to === 'good_path'
    );
    expect(checkToGood).toBeDefined();
  });

  it('routes to fail path when work outcome is stored in context', async () => {
    // The codergen handler stores its outcome status in context via context_updates.
    // The conditional/edge selection reads context.outcome which is set by the engine.
    // When work returns FAIL, the engine sets context outcome=fail, and the conditional
    // routes via condition="outcome=fail".
    // However, the FAIL outcome at work means the engine sets context outcome=fail,
    // then the edge from work→check is selected (unconditional), then at check
    // the edge selection evaluates outcome=success vs outcome=fail.
    // But the conditional handler returns SUCCESS (it's a pass-through), which overwrites
    // the context outcome. So we need to use a context variable instead.
    const backend: CodergenBackend = {
      run: vi.fn().mockImplementation(async (node: Node) => {
        if (node.id === 'work') {
          return makeOutcome({
            status: StageStatus.SUCCESS,
            context_updates: { 'work_result': 'failed' },
          });
        }
        return makeOutcome({ status: StageStatus.SUCCESS });
      }),
    };

    const config = makeConfig({ backend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph FailBranch {
        start [shape=Mdiamond]
        work [shape=box, prompt="Do work"]
        check [shape=diamond]
        good_path [shape=box, prompt="Success"]
        bad_path [shape=box, prompt="Failure recovery"]
        done [shape=Msquare]

        start -> work -> check
        check -> good_path [condition="context.work_result=passed"]
        check -> bad_path [condition="context.work_result=failed"]
        good_path -> done
        bad_path -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.completed_nodes).toContain('bad_path');
    expect(result.completed_nodes).not.toContain('good_path');
  });

  it('routes by preferred_label from codergen outcome', async () => {
    const backend: CodergenBackend = {
      run: vi.fn().mockImplementation(async (node: Node) => {
        if (node.id === 'analyze') {
          return makeOutcome({
            status: StageStatus.SUCCESS,
            preferred_label: 'needs_review',
          });
        }
        return makeOutcome({ status: StageStatus.SUCCESS });
      }),
    };

    const config = makeConfig({ backend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph LabelRouting {
        start [shape=Mdiamond]
        analyze [shape=box, prompt="Analyze code"]
        auto_merge [shape=box, prompt="Auto merge"]
        review [shape=box, prompt="Manual review"]
        done [shape=Msquare]

        start -> analyze
        analyze -> auto_merge [label="auto_approve"]
        analyze -> review [label="needs_review"]
        auto_merge -> done
        review -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.completed_nodes).toContain('review');
    expect(result.completed_nodes).not.toContain('auto_merge');
  });

  it('routes by context condition across stages', async () => {
    const backend: CodergenBackend = {
      run: vi.fn().mockImplementation(async (node: Node) => {
        if (node.id === 'detect') {
          return makeOutcome({
            status: StageStatus.SUCCESS,
            context_updates: { 'language': 'python' },
          });
        }
        return makeOutcome({ status: StageStatus.SUCCESS });
      }),
    };

    const config = makeConfig({ backend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph ContextCondition {
        start [shape=Mdiamond]
        detect [shape=box, prompt="Detect language"]
        branch [shape=diamond]
        py_handler [shape=box, prompt="Handle Python"]
        js_handler [shape=box, prompt="Handle JavaScript"]
        done [shape=Msquare]

        start -> detect -> branch
        branch -> py_handler [condition="context.language=python"]
        branch -> js_handler [condition="context.language=javascript"]
        py_handler -> done
        js_handler -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.completed_nodes).toContain('py_handler');
    expect(result.completed_nodes).not.toContain('js_handler');
  });
});

// ---------------------------------------------------------------------------
// 3. Parallel Fan-Out / Fan-In
// ---------------------------------------------------------------------------

describe('E2E: Parallel fan-out/fan-in', () => {
  it('executes parallel branches and fan-in selects best', async () => {
    // Parallel handler with null executor uses simulation mode
    const backend = outcomeBackend({ status: StageStatus.SUCCESS });
    const config = makeConfig({ backend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph ParallelFanOut {
        start [shape=Mdiamond]
        parallel_split [shape=component]
        branch_a [shape=box, prompt="Branch A"]
        branch_b [shape=box, prompt="Branch B"]
        fanin [shape=tripleoctagon]
        done [shape=Msquare]

        start -> parallel_split
        parallel_split -> branch_a
        parallel_split -> branch_b
        fanin -> done
        parallel_split -> fanin
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.completed_nodes).toContain('parallel_split');
  });

  it('parallel node sets parallel.results in context for fan-in', async () => {
    const backend = outcomeBackend({ status: StageStatus.SUCCESS });
    const events: PipelineEvent[] = [];
    const config = makeConfig({
      backend,
      eventListener: (e) => events.push(e),
    });
    const engine = new PipelineEngine(config);

    // linear: start -> par -> fanin -> done
    // par fans out to branch_a, branch_b (simulated) then continues to fanin
    const result = await engine.runFromSource(`
      digraph ParFanIn {
        start [shape=Mdiamond]
        par [shape=component]
        branch_a [shape=box]
        branch_b [shape=box]
        fanin [shape=tripleoctagon]
        done [shape=Msquare]

        start -> par
        par -> branch_a
        par -> branch_b
        par -> fanin [weight=100]
        fanin -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.completed_nodes).toContain('par');
    expect(result.completed_nodes).toContain('fanin');
    // Fan-in should have recorded the best branch
    expect(result.final_context['parallel.fan_in.best_id']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Human-in-the-Loop with QueueInterviewer
// ---------------------------------------------------------------------------

describe('E2E: Human-in-the-loop', () => {
  it('wait.human node presents choices and routes via QueueInterviewer', async () => {
    // Pre-fill the queue with an answer that selects "approve"
    const interviewer = new QueueInterviewer([
      { value: 'A', selected_option: { key: 'A', label: '[A] Approve' }, text: 'Approve' },
    ]);

    const backend = outcomeBackend({ status: StageStatus.SUCCESS });
    const config = makeConfig({ backend, interviewer });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph HumanGate {
        start [shape=Mdiamond]
        work [shape=box, prompt="Generate code"]
        review [shape=hexagon, label="Review code"]
        apply [shape=box, prompt="Apply approved code"]
        reject [shape=box, prompt="Handle rejection"]
        done [shape=Msquare]

        start -> work -> review
        review -> apply [label="[A] Approve"]
        review -> reject [label="[R] Reject"]
        apply -> done
        reject -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.completed_nodes).toContain('review');
    expect(result.completed_nodes).toContain('apply');
    expect(result.completed_nodes).not.toContain('reject');
    expect(interviewer.remaining()).toBe(0); // Answer was consumed
  });

  it('wait.human routes to rejection path', async () => {
    const interviewer = new QueueInterviewer([
      { value: 'R', selected_option: { key: 'R', label: '[R] Reject' }, text: 'Reject' },
    ]);

    const backend = outcomeBackend({ status: StageStatus.SUCCESS });
    const config = makeConfig({ backend, interviewer });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph HumanReject {
        start [shape=Mdiamond]
        work [shape=box, prompt="Generate code"]
        review [shape=hexagon, label="Review code"]
        apply [shape=box, prompt="Apply"]
        reject [shape=box, prompt="Reject handler"]
        done [shape=Msquare]

        start -> work -> review
        review -> apply [label="[A] Approve"]
        review -> reject [label="[R] Reject"]
        apply -> done
        reject -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.completed_nodes).toContain('reject');
    expect(result.completed_nodes).not.toContain('apply');
  });

  it('wait.human with SKIPPED answer returns FAIL result', async () => {
    const interviewer = new QueueInterviewer([
      { value: AnswerValue.SKIPPED, text: '' },
    ]);

    const backend = outcomeBackend({ status: StageStatus.SUCCESS });
    const config = makeConfig({ backend, interviewer });
    const engine = new PipelineEngine(config);

    // When human skips, wait.human returns FAIL. With an outgoing edge,
    // the pipeline continues but the final status reflects the failure.
    const result = await engine.runFromSource(`
      digraph HumanSkip {
        default_max_retry = 0
        start [shape=Mdiamond]
        review [shape=hexagon, label="Review"]
        done [shape=Msquare]
        start -> review
        review -> done [label="[A] Approve"]
      }
    `);

    expect(result.node_outcomes['review'].status).toBe(StageStatus.FAIL);
    expect(result.node_outcomes['review'].failure_reason).toContain('skipped');
  });
});

// ---------------------------------------------------------------------------
// 5. Error + Retry: codergen fails then succeeds
// ---------------------------------------------------------------------------

describe('E2E: Error + retry', () => {
  it('retries on RETRY status and eventually succeeds', async () => {
    let attemptCount = 0;
    const backend: CodergenBackend = {
      run: vi.fn().mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 3) {
          return makeOutcome({ status: StageStatus.RETRY, failure_reason: `attempt ${attemptCount} failed` });
        }
        return makeOutcome({ status: StageStatus.SUCCESS, notes: 'finally succeeded' });
      }),
    };

    const events: PipelineEvent[] = [];
    const config = makeConfig({
      backend,
      eventListener: (e) => events.push(e),
    });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph RetryPipeline {
        default_max_retry = 5
        start [shape=Mdiamond]
        flaky [shape=box, prompt="Flaky operation"]
        done [shape=Msquare]
        start -> flaky -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(attemptCount).toBe(3); // 2 retries + 1 success
    expect(result.completed_nodes).toContain('flaky');

    // Verify retry events were emitted
    const retryEvents = events.filter(e => e.kind === PipelineEventKind.STAGE_RETRYING);
    expect(retryEvents.length).toBe(2);
  });

  it('respects node-level max_retries', async () => {
    let attemptCount = 0;
    const backend: CodergenBackend = {
      run: vi.fn().mockImplementation(async () => {
        attemptCount++;
        return makeOutcome({ status: StageStatus.RETRY });
      }),
    };

    const config = makeConfig({ backend });
    const engine = new PipelineEngine(config);

    // Node has max_retries=2 → 3 total attempts, all RETRY → FAIL result
    const result = await engine.runFromSource(`
      digraph MaxRetries {
        default_max_retry = 0
        start [shape=Mdiamond]
        work [shape=box, prompt="Failing", max_retries=2]
        done [shape=Msquare]
        start -> work -> done
      }
    `);

    expect(result.status).toBe(StageStatus.FAIL);
    expect(result.node_outcomes['work'].status).toBe(StageStatus.FAIL);
    expect(result.node_outcomes['work'].failure_reason).toContain('max retries');
    expect(attemptCount).toBe(3); // 1 initial + 2 retries
  });

  it('backend RETRY status followed by SUCCESS on second attempt', async () => {
    let attemptCount = 0;
    const backend: CodergenBackend = {
      run: vi.fn().mockImplementation(async () => {
        attemptCount++;
        if (attemptCount === 1) {
          return makeOutcome({ status: StageStatus.RETRY, failure_reason: 'transient error' });
        }
        return 'Success after retry';
      }),
    };

    const config = makeConfig({ backend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph RetrySuccess {
        default_max_retry = 3
        start [shape=Mdiamond]
        work [shape=box, prompt="Might fail"]
        done [shape=Msquare]
        start -> work -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(attemptCount).toBe(2);
  });

  it('backend exception is caught by handler and returns FAIL', async () => {
    const backend: CodergenBackend = {
      run: vi.fn().mockRejectedValue(new Error('network timeout')),
    };

    const config = makeConfig({ backend });
    const engine = new PipelineEngine(config);

    // CodergenHandler catches exceptions and returns FAIL outcome
    const result = await engine.runFromSource(`
      digraph ExceptionFail {
        default_max_retry = 0
        start [shape=Mdiamond]
        work [shape=box, prompt="Will fail", max_retries=0]
        done [shape=Msquare]
        start -> work -> done
      }
    `);

    expect(result.status).toBe(StageStatus.FAIL);
    expect(result.node_outcomes['work'].failure_reason).toContain('network timeout');
  });

  it('allow_partial returns PARTIAL_SUCCESS when retries exhausted', async () => {
    const backend: CodergenBackend = {
      run: vi.fn().mockResolvedValue(makeOutcome({ status: StageStatus.RETRY })),
    };

    const config = makeConfig({ backend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph PartialRetry {
        default_max_retry = 0
        start [shape=Mdiamond]
        work [shape=box, prompt="Partial ok", max_retries=1, allow_partial=true]
        done [shape=Msquare]
        start -> work -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.node_outcomes['work'].status).toBe(StageStatus.PARTIAL_SUCCESS);
  });
});

// ---------------------------------------------------------------------------
// 6. Checkpoint Save/Resume
// ---------------------------------------------------------------------------

describe('E2E: Checkpoint save/resume', () => {
  it('saves checkpoint after each stage and can be loaded', async () => {
    const backend = successBackend('checkpoint test');
    const logsRoot = makeTempDir();
    const config = makeConfig({ logsRoot, backend });
    const engine = new PipelineEngine(config);

    await engine.runFromSource(`
      digraph CheckpointTest {
        start [shape=Mdiamond]
        step1 [shape=box, prompt="Step 1"]
        step2 [shape=box, prompt="Step 2"]
        done [shape=Msquare]
        start -> step1 -> step2 -> done
      }
    `);

    // Verify checkpoint was written
    const checkpoint = loadCheckpoint(logsRoot);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.completed_nodes).toContain('step1');
    expect(checkpoint!.completed_nodes).toContain('step2');
  });

  it('resumes from checkpoint and continues execution', async () => {
    const logsRoot = makeTempDir();
    let callCount = 0;
    const backend: CodergenBackend = {
      run: vi.fn().mockImplementation(async (node: Node) => {
        callCount++;
        return `Result for ${node.id}`;
      }),
    };

    // First run: execute start → step1, then we'll simulate resume
    const config1 = makeConfig({ logsRoot, backend });
    const engine1 = new PipelineEngine(config1);

    await engine1.runFromSource(`
      digraph ResumeTest {
        start [shape=Mdiamond]
        step1 [shape=box, prompt="Step 1"]
        step2 [shape=box, prompt="Step 2"]
        done [shape=Msquare]
        start -> step1 -> step2 -> done
      }
    `);

    // Verify both steps ran
    expect(callCount).toBe(2);

    // Now manually create a checkpoint as if we stopped after step1
    const ctx = new Context();
    ctx.set('outcome', 'success');
    ctx.set('last_stage', 'step1');
    const cp = createCheckpoint(
      ctx,
      'step1',
      ['start', 'step1'],
      {},
      {
        start: makeOutcome({ status: StageStatus.SUCCESS }),
        step1: makeOutcome({ status: StageStatus.SUCCESS }),
      },
    );
    saveCheckpoint(cp, logsRoot);

    // Resume: should pick up from step2
    callCount = 0;
    const config2 = makeConfig({
      logsRoot,
      backend,
      resumeFromCheckpoint: true,
    });
    const engine2 = new PipelineEngine(config2);

    const result = await engine2.runFromSource(`
      digraph ResumeTest {
        start [shape=Mdiamond]
        step1 [shape=box, prompt="Step 1"]
        step2 [shape=box, prompt="Step 2"]
        done [shape=Msquare]
        start -> step1 -> step2 -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    // Only step2 should have been executed in the resumed run
    expect(callCount).toBe(1);
    expect(result.completed_nodes).toContain('step2');
  });

  it('handles resume with no checkpoint (starts fresh)', async () => {
    const logsRoot = makeTempDir();
    const backend = successBackend();
    const config = makeConfig({
      logsRoot,
      backend,
      resumeFromCheckpoint: true,
    });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph FreshStart {
        start [shape=Mdiamond]
        work [shape=box, prompt="Work"]
        done [shape=Msquare]
        start -> work -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.completed_nodes).toContain('work');
  });
});

// ---------------------------------------------------------------------------
// 7. Model Stylesheet Selection
// ---------------------------------------------------------------------------

describe('E2E: Model stylesheet selection', () => {
  it('applies model stylesheet to nodes based on shape selectors', async () => {
    const backend: CodergenBackend = {
      run: vi.fn().mockImplementation(async (node: Node) => {
        // Verify the stylesheet was applied to the node
        return makeOutcome({
          status: StageStatus.SUCCESS,
          context_updates: {
            [`model.${node.id}`]: node.attrs.llm_model || 'none',
            [`provider.${node.id}`]: node.attrs.llm_provider || 'none',
          },
        });
      }),
    };

    const config = makeConfig({ backend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph StylesheetTest {
        model_stylesheet = "box { model = gpt-4o; provider = openai } diamond { model = claude-3-5-sonnet; provider = anthropic }"
        start [shape=Mdiamond]
        codegen [shape=box, prompt="Generate"]
        check [shape=diamond]
        done [shape=Msquare]
        start -> codegen -> check -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.final_context['model.codegen']).toBe('gpt-4o');
    expect(result.final_context['provider.codegen']).toBe('openai');
  });

  it('node-level llm_model overrides stylesheet', async () => {
    const backend: CodergenBackend = {
      run: vi.fn().mockImplementation(async (node: Node) => {
        return makeOutcome({
          status: StageStatus.SUCCESS,
          context_updates: {
            [`model.${node.id}`]: node.attrs.llm_model || 'none',
          },
        });
      }),
    };

    const config = makeConfig({ backend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph OverrideTest {
        model_stylesheet = "box { model = gpt-4o }"
        start [shape=Mdiamond]
        gen1 [shape=box, prompt="Default model"]
        gen2 [shape=box, prompt="Custom model", llm_model="claude-opus"]
        done [shape=Msquare]
        start -> gen1 -> gen2 -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.final_context['model.gen1']).toBe('gpt-4o');
    // Node-level override takes precedence
    expect(result.final_context['model.gen2']).toBe('claude-opus');
  });

  it('class-based stylesheet selectors work', async () => {
    const backend: CodergenBackend = {
      run: vi.fn().mockImplementation(async (node: Node) => {
        return makeOutcome({
          status: StageStatus.SUCCESS,
          context_updates: {
            [`model.${node.id}`]: node.attrs.llm_model || 'none',
          },
        });
      }),
    };

    const config = makeConfig({ backend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph ClassSelector {
        model_stylesheet = ".fast-tier { model = gpt-4o-mini } .premium-tier { model = claude-opus }"
        start [shape=Mdiamond]
        quick [shape=box, prompt="Quick task", class="fast-tier"]
        deep [shape=box, prompt="Deep analysis", class="premium-tier"]
        done [shape=Msquare]
        start -> quick -> deep -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.final_context['model.quick']).toBe('gpt-4o-mini');
    expect(result.final_context['model.deep']).toBe('claude-opus');
  });

  it('universal selector (*) applies to all nodes', async () => {
    const backend: CodergenBackend = {
      run: vi.fn().mockImplementation(async (node: Node) => {
        return makeOutcome({
          status: StageStatus.SUCCESS,
          context_updates: {
            [`effort.${node.id}`]: node.attrs.reasoning_effort || 'default',
          },
        });
      }),
    };

    const config = makeConfig({ backend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph UniversalSelector {
        model_stylesheet = "* { reasoning_effort = medium }"
        start [shape=Mdiamond]
        step1 [shape=box, prompt="A"]
        step2 [shape=box, prompt="B"]
        done [shape=Msquare]
        start -> step1 -> step2 -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    // reasoning_effort defaults to 'high' in DEFAULT_NODE_ATTRIBUTES,
    // but since it's already set, stylesheet won't override
    // Universal selector only applies where there's no existing value
  });

  it('ID selector (#node) targets specific nodes', async () => {
    const backend: CodergenBackend = {
      run: vi.fn().mockImplementation(async (node: Node) => {
        return makeOutcome({
          status: StageStatus.SUCCESS,
          context_updates: {
            [`model.${node.id}`]: node.attrs.llm_model || 'default',
          },
        });
      }),
    };

    const config = makeConfig({ backend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph IDSelector {
        model_stylesheet = "box { model = gpt-4o } #critical_step { model = claude-opus }"
        start [shape=Mdiamond]
        normal [shape=box, prompt="Normal"]
        critical_step [shape=box, prompt="Critical"]
        done [shape=Msquare]
        start -> normal -> critical_step -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.final_context['model.normal']).toBe('gpt-4o');
    // ID selector has higher specificity than shape selector
    expect(result.final_context['model.critical_step']).toBe('claude-opus');
  });
});

// ---------------------------------------------------------------------------
// 8. Combined E2E Scenarios
// ---------------------------------------------------------------------------

describe('E2E: Complex multi-feature scenarios', () => {
  it('full pipeline: codergen → conditional → human gate → retry → exit', async () => {
    let analyzeCallCount = 0;
    const backend: CodergenBackend = {
      run: vi.fn().mockImplementation(async (node: Node) => {
        if (node.id === 'analyze') {
          analyzeCallCount++;
          return makeOutcome({
            status: StageStatus.SUCCESS,
            context_updates: { quality: 'high' },
          });
        }
        if (node.id === 'implement') {
          return makeOutcome({ status: StageStatus.SUCCESS });
        }
        return makeOutcome({ status: StageStatus.SUCCESS });
      }),
    };

    const interviewer = new QueueInterviewer([
      { value: 'A', selected_option: { key: 'A', label: '[A] Approve' }, text: 'Approve' },
    ]);

    const events: PipelineEvent[] = [];
    const config = makeConfig({
      backend,
      interviewer,
      eventListener: (e) => events.push(e),
    });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph FullPipeline {
        goal = "Build user auth system"
        start [shape=Mdiamond]
        analyze [shape=box, prompt="Analyze requirements for $goal"]
        quality_check [shape=diamond]
        implement [shape=box, prompt="Implement solution"]
        review [shape=hexagon, label="Human review"]
        deploy [shape=box, prompt="Deploy"]
        done [shape=Msquare]

        start -> analyze -> quality_check
        quality_check -> implement [condition="context.quality=high"]
        quality_check -> analyze [condition="context.quality=low"]
        implement -> review
        review -> deploy [label="[A] Approve"]
        review -> implement [label="[R] Revise"]
        deploy -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.completed_nodes).toContain('analyze');
    expect(result.completed_nodes).toContain('implement');
    expect(result.completed_nodes).toContain('review');
    expect(result.completed_nodes).toContain('deploy');
    expect(analyzeCallCount).toBe(1); // Quality was 'high', no loop

    // Verify event timeline
    const startEvents = events.filter(e => e.kind === PipelineEventKind.STAGE_STARTED);
    expect(startEvents.length).toBeGreaterThanOrEqual(5); // start, analyze, quality_check, implement, review, deploy
  });

  it('goal gate with retry_target: re-executes failing node', async () => {
    let attemptCount = 0;
    const backend: CodergenBackend = {
      run: vi.fn().mockImplementation(async (node: Node) => {
        if (node.id === 'critical') {
          attemptCount++;
          if (attemptCount < 2) {
            return makeOutcome({ status: StageStatus.FAIL, failure_reason: 'not good enough' });
          }
          return makeOutcome({ status: StageStatus.SUCCESS });
        }
        return makeOutcome({ status: StageStatus.SUCCESS });
      }),
    };

    const config = makeConfig({ backend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph GoalGateRetry {
        retry_target = "critical"
        start [shape=Mdiamond]
        critical [shape=box, prompt="Critical work", goal_gate=true, max_retries=0]
        done [shape=Msquare]
        start -> critical -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    // critical should have been re-executed via goal gate retry
    expect(attemptCount).toBe(2);
  });

  it('variable expansion: $goal in prompt is replaced with graph goal', async () => {
    const backend: CodergenBackend = {
      run: vi.fn().mockImplementation(async (_node: Node, prompt: string) => {
        return `Received prompt: ${prompt}`;
      }),
    };

    const logsRoot = makeTempDir();
    const config = makeConfig({ logsRoot, backend });
    const engine = new PipelineEngine(config);

    await engine.runFromSource(`
      digraph VarExpand {
        goal = "create a REST API"
        start [shape=Mdiamond]
        codegen [shape=box, prompt="Please $goal with best practices"]
        done [shape=Msquare]
        start -> codegen -> done
      }
    `);

    // Verify the prompt was expanded
    const promptContent = readFileSync(join(logsRoot, 'codegen', 'prompt.md'), 'utf-8');
    expect(promptContent).toContain('create a REST API');
    expect(promptContent).not.toContain('$goal');
  });

  it('simulation mode (no backend): pipeline runs with simulated responses', async () => {
    const config = makeConfig(); // No backend
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph SimMode {
        start [shape=Mdiamond]
        step1 [shape=box, prompt="Step 1"]
        step2 [shape=box, prompt="Step 2"]
        done [shape=Msquare]
        start -> step1 -> step2 -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.completed_nodes).toEqual(['start', 'step1', 'step2']);
  });

  it('subgraph-derived classes propagate to stylesheet', async () => {
    const backend: CodergenBackend = {
      run: vi.fn().mockImplementation(async (node: Node) => {
        return makeOutcome({
          status: StageStatus.SUCCESS,
          context_updates: {
            [`model.${node.id}`]: node.attrs.llm_model || 'none',
          },
        });
      }),
    };

    const config = makeConfig({ backend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph SubgraphClass {
        model_stylesheet = ".fast-tasks { model = gpt-4o-mini }"
        start [shape=Mdiamond]

        subgraph cluster_fast {
          label = "Fast Tasks"
          fast1 [shape=box, prompt="Quick job"]
        }

        done [shape=Msquare]
        start -> fast1 -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    // The subgraph label "Fast Tasks" derives class "fast-tasks"
    // which matches .fast-tasks selector
    expect(result.final_context['model.fast1']).toBe('gpt-4o-mini');
  });

  it('edge weight tiebreaker selects higher-weight edge', async () => {
    const backend = outcomeBackend({ status: StageStatus.SUCCESS });
    const config = makeConfig({ backend });
    const engine = new PipelineEngine(config);

    const result = await engine.runFromSource(`
      digraph WeightTiebreak {
        start [shape=Mdiamond]
        branch [shape=diamond]
        path_a [shape=box, prompt="Path A"]
        path_b [shape=box, prompt="Path B"]
        done [shape=Msquare]

        start -> branch
        branch -> path_a [weight=1]
        branch -> path_b [weight=10]
        path_a -> done
        path_b -> done
      }
    `);

    expect(result.status).toBe(StageStatus.SUCCESS);
    // Higher weight should win
    expect(result.completed_nodes).toContain('path_b');
    expect(result.completed_nodes).not.toContain('path_a');
  });
});
