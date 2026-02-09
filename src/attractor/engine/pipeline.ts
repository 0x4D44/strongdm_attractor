/**
 * Pipeline execution engine: the core execution loop.
 * Lifecycle: PARSE -> VALIDATE -> INITIALIZE -> EXECUTE -> FINALIZE
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseDot } from '../parser/dot-parser.js';
import { validateOrRaise } from '../parser/validator.js';
import { applyTransforms } from '../transforms.js';
import { selectEdge } from './edge-selection.js';
import { createCheckpoint, saveCheckpoint, loadCheckpoint, restoreFromCheckpoint } from './checkpoint.js';
import { Context } from './context.js';
import { HandlerRegistry } from '../handlers/index.js';
import { PipelineEventEmitter } from '../events.js';
import * as events from '../events.js';
import type {
  Graph,
  Node,
  Outcome,
  PipelineResult,
  PipelineContext,
  PipelineEvent,
  RetryPolicy,
  BackoffConfig,
  Transform,
  LintRule,
  CodergenBackend,
  Interviewer,
  NodeHandler,
} from '../types.js';
import {
  StageStatus,
  makeOutcome,
  PRESET_POLICIES,
} from '../types.js';
import { parseDuration } from '../utils.js';

// Re-export for backwards compatibility
export { parseDuration } from '../utils.js';

// ---------------------------------------------------------------------------
// Backoff Delay Calculation
// ---------------------------------------------------------------------------

export function delayForAttempt(attempt: number, config: BackoffConfig): number {
  // attempt is 1-indexed (first retry is attempt=1)
  let delay = config.initial_delay_ms * Math.pow(config.backoff_factor, attempt - 1);
  delay = Math.min(delay, config.max_delay_ms);
  if (config.jitter) {
    delay = delay * (0.5 + Math.random());
  }
  return Math.floor(delay);
}

// ---------------------------------------------------------------------------
// Pipeline Configuration
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  logsRoot: string;
  backend?: CodergenBackend | null;
  interviewer?: Interviewer;
  transforms?: Transform[];
  extraRules?: LintRule[];
  resumeFromCheckpoint?: boolean;
  eventListener?: (event: PipelineEvent) => void;
}

// ---------------------------------------------------------------------------
// Pipeline Engine
// ---------------------------------------------------------------------------

export class PipelineEngine {
  private registry: HandlerRegistry;
  private emitter: PipelineEventEmitter;
  private config: PipelineConfig;

  constructor(config: PipelineConfig) {
    this.config = config;
    this.registry = new HandlerRegistry();
    this.emitter = new PipelineEventEmitter();

    if (config.eventListener) {
      this.emitter.on(config.eventListener);
    }
  }

  /**
   * Register a custom handler by type string.
   */
  registerHandler(typeString: string, handler: NodeHandler): void {
    this.registry.register(typeString, handler);
  }

  /**
   * Run a pipeline from DOT source.
   */
  async runFromSource(dotSource: string): Promise<PipelineResult> {
    const startTime = Date.now();

    // Phase 1: PARSE
    const graph = parseDot(dotSource);

    // Phase 2: TRANSFORM (before validation)
    const transformed = applyTransforms(graph, this.config.transforms);

    // Phase 3: VALIDATE
    validateOrRaise(transformed, this.config.extraRules);

    // Phase 4: Execute
    return this.runGraph(transformed, startTime);
  }

  /**
   * Run a pipeline from a pre-parsed graph.
   */
  async runGraph(graph: Graph, startTime?: number): Promise<PipelineResult> {
    const start = startTime ?? Date.now();
    const logsRoot = this.config.logsRoot;

    // Ensure logs directory exists
    if (!existsSync(logsRoot)) {
      mkdirSync(logsRoot, { recursive: true });
    }

    // Register handlers with dependencies
    this.registry.registerDefaults({
      backend: this.config.backend,
      interviewer: this.config.interviewer,
    });

    // INITIALIZE
    let context: PipelineContext;
    let completedNodes: string[];
    let nodeOutcomes: Record<string, Outcome>;
    let nodeRetries: Record<string, number>;
    let currentNode: Node;

    if (this.config.resumeFromCheckpoint) {
      const checkpoint = loadCheckpoint(logsRoot);
      if (checkpoint) {
        const restored = restoreFromCheckpoint(checkpoint);
        context = restored.context;
        completedNodes = restored.completedNodes;
        nodeRetries = restored.nodeRetries;
        nodeOutcomes = restored.nodeOutcomes;

        // Find the next node after the checkpoint
        const lastNodeId = restored.currentNode;
        const lastNode = graph.nodes.get(lastNodeId);
        if (!lastNode) {
          throw new Error(`Checkpoint references unknown node: ${lastNodeId}`);
        }

        // Select next edge from the last completed node using the actual outcome
        const lastOutcome = nodeOutcomes[lastNodeId] ?? makeOutcome({ status: StageStatus.SUCCESS });
        const nextEdge = selectEdge(lastNodeId, lastOutcome, context, graph);
        if (nextEdge) {
          currentNode = graph.nodes.get(nextEdge.to)!;
        } else {
          // Already at terminal
          return {
            status: StageStatus.SUCCESS,
            completed_nodes: completedNodes,
            node_outcomes: nodeOutcomes,
            final_context: context.snapshot(),
            logs_root: logsRoot,
          };
        }
      } else {
        // No checkpoint, start fresh
        context = new Context();
        completedNodes = [];
        nodeOutcomes = {};
        nodeRetries = {};
        currentNode = this.findStartNode(graph);
      }
    } else {
      context = new Context();
      completedNodes = [];
      nodeOutcomes = {};
      nodeRetries = {};
      currentNode = this.findStartNode(graph);
    }

    // Mirror graph attributes into context
    mirrorGraphAttributes(graph, context);

    // Write manifest
    writeManifest(logsRoot, graph);

    // Emit pipeline started
    this.emitter.emit(events.pipelineStarted(graph.name, logsRoot));

    // EXECUTE
    try {
      const result = await this.executeLoop(
        graph, context, currentNode, completedNodes, nodeOutcomes, nodeRetries, logsRoot
      );

      const duration = Date.now() - start;
      this.emitter.emit(events.pipelineCompleted(duration, completedNodes.length));

      return result;
    } catch (e) {
      const duration = Date.now() - start;
      this.emitter.emit(events.pipelineFailed(String(e), duration));
      throw e;
    }
  }

  // -----------------------------------------------------------------------
  // Core Execution Loop
  // -----------------------------------------------------------------------

  private async executeLoop(
    graph: Graph,
    context: PipelineContext,
    startNode: Node,
    completedNodes: string[],
    nodeOutcomes: Record<string, Outcome>,
    nodeRetries: Record<string, number>,
    logsRoot: string,
  ): Promise<PipelineResult> {
    let currentNode = startNode;
    let lastOutcome: Outcome = makeOutcome({ status: StageStatus.SUCCESS });
    let stageIndex = completedNodes.length;

    while (true) {
      const node = currentNode;
      context.set('current_node', node.id);

      // Step 1: Check for terminal node
      if (isTerminal(node)) {
        const [gateOk, failedGate] = checkGoalGates(graph, nodeOutcomes);
        if (!gateOk && failedGate) {
          const retryTarget = getRetryTarget(failedGate, graph);
          if (retryTarget && graph.nodes.has(retryTarget)) {
            currentNode = graph.nodes.get(retryTarget)!;
            continue;
          } else {
            throw new Error(
              `Goal gate unsatisfied for node '${failedGate.id}' and no retry target available`
            );
          }
        }
        // Pipeline complete
        break;
      }

      // Step 2: Execute node handler with retry policy
      this.emitter.emit(events.stageStarted(node.id, stageIndex));
      const stageStart = Date.now();

      const retryPolicy = buildRetryPolicy(node, graph);
      let outcome = await this.executeWithRetry(
        node, context, graph, logsRoot, retryPolicy, nodeRetries, stageIndex,
      );

      // auto_status: synthesize SUCCESS if enabled and no status was explicitly set
      if (node.attrs.auto_status === true) {
        const stageDir = join(logsRoot, node.id);
        if (!existsSync(join(stageDir, 'status.json'))) {
          outcome = makeOutcome({ status: StageStatus.SUCCESS, notes: 'auto_status: synthesized' });
        }
      }

      const stageDuration = Date.now() - stageStart;

      // Handle SKIPPED status: don't track as completed
      if (outcome.status === StageStatus.SKIPPED) {
        this.emitter.emit(events.stageCompleted(node.id, stageIndex, stageDuration));
        lastOutcome = outcome;
        // Select next edge and continue without recording completion
        const nextEdge = selectEdge(node.id, outcome, context, graph);
        if (!nextEdge) break;
        this.emitter.emit(events.edgeSelected(node.id, nextEdge.to, 'edge_selection'));
        const nextNode = graph.nodes.get(nextEdge.to);
        if (!nextNode) {
          throw new Error(`Edge target '${nextEdge.to}' not found in graph`);
        }
        currentNode = nextNode;
        stageIndex++;
        continue;
      }

      // Step 3: Record completion
      completedNodes.push(node.id);
      nodeOutcomes[node.id] = outcome;
      lastOutcome = outcome;

      if (outcome.status === StageStatus.SUCCESS || outcome.status === StageStatus.PARTIAL_SUCCESS) {
        this.emitter.emit(events.stageCompleted(node.id, stageIndex, stageDuration));
      } else {
        this.emitter.emit(events.stageFailed(node.id, stageIndex, outcome.failure_reason, false));
      }

      // Step 4: Apply context updates from outcome
      if (outcome.context_updates) {
        context.applyUpdates(outcome.context_updates);
      }
      context.set('outcome', outcome.status);
      if (outcome.preferred_label) {
        context.set('preferred_label', outcome.preferred_label);
      }

      // Step 5: Save checkpoint
      const checkpoint = createCheckpoint(context, node.id, completedNodes, nodeRetries, nodeOutcomes);
      saveCheckpoint(checkpoint, logsRoot);
      this.emitter.emit(events.checkpointSaved(node.id));

      // Step 6: Select next edge
      const nextEdge = selectEdge(node.id, outcome, context, graph);
      if (!nextEdge) {
        if (outcome.status === StageStatus.FAIL) {
          throw new Error(`Stage '${node.id}' failed with no outgoing fail edge`);
        }
        break;
      }

      this.emitter.emit(events.edgeSelected(node.id, nextEdge.to, 'edge_selection'));

      // Step 7: Handle loop_restart
      if (nextEdge.attrs.loop_restart) {
        // Restart the pipeline from the target node with a fresh logs directory
        const restartNode = graph.nodes.get(nextEdge.to);
        if (restartNode) {
          const newLogsRoot = `${logsRoot}_restart_${Date.now()}`;
          mkdirSync(newLogsRoot, { recursive: true });
          return this.executeLoop(
            graph,
            new Context(),
            restartNode,
            [],
            {},
            {},
            newLogsRoot,
          );
        }
      }

      // Step 8: Advance to next node
      const nextNode = graph.nodes.get(nextEdge.to);
      if (!nextNode) {
        throw new Error(`Edge target '${nextEdge.to}' not found in graph`);
      }
      currentNode = nextNode;
      stageIndex++;
    }

    return {
      status: lastOutcome.status === StageStatus.FAIL ? StageStatus.FAIL : StageStatus.SUCCESS,
      completed_nodes: completedNodes,
      node_outcomes: nodeOutcomes,
      final_context: context.snapshot(),
      logs_root: logsRoot,
    };
  }

  // -----------------------------------------------------------------------
  // Retry Execution
  // -----------------------------------------------------------------------

  private async executeWithRetry(
    node: Node,
    context: PipelineContext,
    graph: Graph,
    logsRoot: string,
    retryPolicy: RetryPolicy,
    nodeRetries: Record<string, number>,
    stageIndex: number,
  ): Promise<Outcome> {
    const handler = this.registry.resolve(node);

    for (let attempt = 1; attempt <= retryPolicy.max_attempts; attempt++) {
      try {
        const outcome = await handler.handle(node, context, graph, logsRoot);

        if (outcome.status === StageStatus.SUCCESS || outcome.status === StageStatus.PARTIAL_SUCCESS) {
          // Reset retry counter on success
          nodeRetries[node.id] = 0;
          return outcome;
        }

        if (outcome.status === StageStatus.RETRY) {
          if (attempt < retryPolicy.max_attempts) {
            nodeRetries[node.id] = (nodeRetries[node.id] || 0) + 1;
            context.set(`internal.retry_count.${node.id}`, nodeRetries[node.id]);
            const delay = delayForAttempt(attempt, retryPolicy.backoff);
            this.emitter.emit(events.stageRetrying(node.id, stageIndex, attempt, delay));
            await sleep(delay);
            continue;
          } else {
            if (node.attrs.allow_partial) {
              return makeOutcome({
                status: StageStatus.PARTIAL_SUCCESS,
                notes: 'retries exhausted, partial accepted',
              });
            }
            return makeOutcome({
              status: StageStatus.FAIL,
              failure_reason: 'max retries exceeded',
            });
          }
        }

        if (outcome.status === StageStatus.FAIL) {
          return outcome;
        }

        if (outcome.status === StageStatus.SKIPPED) {
          return outcome;
        }

        return outcome;
      } catch (e) {
        if (retryPolicy.should_retry(e as Error) && attempt < retryPolicy.max_attempts) {
          nodeRetries[node.id] = (nodeRetries[node.id] || 0) + 1;
          context.set(`internal.retry_count.${node.id}`, nodeRetries[node.id]);
          const delay = delayForAttempt(attempt, retryPolicy.backoff);
          this.emitter.emit(events.stageRetrying(node.id, stageIndex, attempt, delay));
          await sleep(delay);
          continue;
        } else {
          return makeOutcome({
            status: StageStatus.FAIL,
            failure_reason: String(e),
          });
        }
      }
    }

    return makeOutcome({
      status: StageStatus.FAIL,
      failure_reason: 'max retries exceeded',
    });
  }

  // -----------------------------------------------------------------------
  // Start Node Resolution
  // -----------------------------------------------------------------------

  private findStartNode(graph: Graph): Node {
    // 1. Find by shape=Mdiamond
    for (const [_id, node] of graph.nodes) {
      if (node.attrs.shape === 'Mdiamond') return node;
    }

    // 2. Find by ID
    if (graph.nodes.has('start')) return graph.nodes.get('start')!;
    if (graph.nodes.has('Start')) return graph.nodes.get('Start')!;

    throw new Error('No start node found in graph');
  }
}

// ---------------------------------------------------------------------------
// Goal Gate Enforcement
// ---------------------------------------------------------------------------

function isTerminal(node: Node): boolean {
  return node.attrs.shape === 'Msquare';
}

function checkGoalGates(
  graph: Graph,
  nodeOutcomes: Record<string, Outcome>,
): [boolean, Node | null] {
  for (const [nodeId, outcome] of Object.entries(nodeOutcomes)) {
    const node = graph.nodes.get(nodeId);
    if (!node) continue;
    if (node.attrs.goal_gate) {
      if (outcome.status !== StageStatus.SUCCESS &&
          outcome.status !== StageStatus.PARTIAL_SUCCESS) {
        return [false, node];
      }
    }
  }
  return [true, null];
}

function getRetryTarget(node: Node, graph: Graph): string | undefined {
  // 1. Node-level retry_target
  if (node.attrs.retry_target) return node.attrs.retry_target;
  // 2. Node-level fallback_retry_target
  if (node.attrs.fallback_retry_target) return node.attrs.fallback_retry_target;
  // 3. Graph-level retry_target
  if (graph.attrs.retry_target) return graph.attrs.retry_target;
  // 4. Graph-level fallback_retry_target
  if (graph.attrs.fallback_retry_target) return graph.attrs.fallback_retry_target;
  return undefined;
}

// ---------------------------------------------------------------------------
// Retry Policy Builder
// ---------------------------------------------------------------------------

function buildRetryPolicy(node: Node, graph: Graph): RetryPolicy {
  // Determine max retries: explicit node value takes precedence, graph default is fallback.
  // The NodeAttributes default for max_retries is 0, meaning "use graph default".
  // An explicit max_retries > 0 on the node overrides the graph default.
  let maxRetries = node.attrs.max_retries;
  if (maxRetries <= 0) {
    // Node didn't set a retry count — fall back to graph-level default
    maxRetries = graph.attrs.default_max_retry > 0 ? graph.attrs.default_max_retry : 0;
  }

  const maxAttempts = maxRetries + 1;

  // Use standard backoff
  const preset = PRESET_POLICIES['standard'];

  return {
    max_attempts: maxAttempts,
    backoff: preset.backoff,
    should_retry: defaultShouldRetry,
  };
}

function defaultShouldRetry(error: Error): boolean {
  const message = error.message?.toLowerCase() || '';
  // Retry on network and rate limit errors
  if (message.includes('rate limit') || message.includes('429')) return true;
  if (message.includes('timeout') || message.includes('timed out')) return true;
  if (message.includes('network') || message.includes('econnrefused')) return true;
  if (message.includes('5') && message.includes('server error')) return true;
  // Don't retry on auth or validation errors
  if (message.includes('401') || message.includes('403')) return false;
  if (message.includes('400') || message.includes('validation')) return false;
  // Default: retry
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mirrorGraphAttributes(graph: Graph, context: PipelineContext): void {
  context.set('graph.goal', graph.attrs.goal);
  context.set('graph.label', graph.attrs.label);
  if (graph.attrs.default_fidelity) {
    context.set('graph.default_fidelity', graph.attrs.default_fidelity);
  }
}

function writeManifest(logsRoot: string, graph: Graph): void {
  const manifest = {
    name: graph.name,
    goal: graph.attrs.goal,
    label: graph.attrs.label,
    start_time: new Date().toISOString(),
    node_count: graph.nodes.size,
    edge_count: graph.edges.length,
  };
  writeFileSync(join(logsRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}
