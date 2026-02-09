/**
 * Core types for the Attractor Pipeline Engine.
 * DOT-based pipeline runner for multi-stage AI workflows.
 */

// ---------------------------------------------------------------------------
// Outcome Status
// ---------------------------------------------------------------------------

export enum StageStatus {
  SUCCESS = 'success',
  PARTIAL_SUCCESS = 'partial_success',
  RETRY = 'retry',
  FAIL = 'fail',
  SKIPPED = 'skipped',
}

export interface Outcome {
  status: StageStatus;
  preferred_label: string;
  suggested_next_ids: string[];
  context_updates: Record<string, unknown>;
  notes: string;
  failure_reason: string;
}

export function makeOutcome(partial: Partial<Outcome> & { status: StageStatus }): Outcome {
  return {
    preferred_label: '',
    suggested_next_ids: [],
    context_updates: {},
    notes: '',
    failure_reason: '',
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Handler Type
// ---------------------------------------------------------------------------

export enum HandlerType {
  START = 'start',
  EXIT = 'exit',
  CODERGEN = 'codergen',
  WAIT_HUMAN = 'wait.human',
  CONDITIONAL = 'conditional',
  PARALLEL = 'parallel',
  PARALLEL_FAN_IN = 'parallel.fan_in',
  TOOL = 'tool',
  STACK_MANAGER_LOOP = 'stack.manager_loop',
}

// ---------------------------------------------------------------------------
// Shape-to-Handler-Type Mapping
// ---------------------------------------------------------------------------

export const SHAPE_TO_HANDLER_TYPE: Record<string, HandlerType> = {
  Mdiamond: HandlerType.START,
  Msquare: HandlerType.EXIT,
  box: HandlerType.CODERGEN,
  hexagon: HandlerType.WAIT_HUMAN,
  diamond: HandlerType.CONDITIONAL,
  component: HandlerType.PARALLEL,
  tripleoctagon: HandlerType.PARALLEL_FAN_IN,
  parallelogram: HandlerType.TOOL,
  house: HandlerType.STACK_MANAGER_LOOP,
};

// ---------------------------------------------------------------------------
// Graph AST Types
// ---------------------------------------------------------------------------

export interface GraphAttributes {
  goal: string;
  label: string;
  model_stylesheet: string;
  default_max_retry: number;
  retry_target: string;
  fallback_retry_target: string;
  default_fidelity: string;
  [key: string]: unknown;
}

export const DEFAULT_GRAPH_ATTRIBUTES: GraphAttributes = {
  goal: '',
  label: '',
  model_stylesheet: '',
  default_max_retry: 50,
  retry_target: '',
  fallback_retry_target: '',
  default_fidelity: '',
};

export interface NodeAttributes {
  label: string;
  shape: string;
  type: string;
  prompt: string;
  max_retries: number;
  goal_gate: boolean;
  retry_target: string;
  fallback_retry_target: string;
  fidelity: string;
  thread_id: string;
  class: string;
  timeout: string;
  llm_model: string;
  llm_provider: string;
  reasoning_effort: string;
  auto_status: boolean;
  allow_partial: boolean;
  [key: string]: unknown;
}

export const DEFAULT_NODE_ATTRIBUTES: NodeAttributes = {
  label: '',
  shape: 'box',
  type: '',
  prompt: '',
  max_retries: 0,
  goal_gate: false,
  retry_target: '',
  fallback_retry_target: '',
  fidelity: '',
  thread_id: '',
  class: '',
  timeout: '',
  llm_model: '',
  llm_provider: '',
  reasoning_effort: 'high',
  auto_status: false,
  allow_partial: false,
};

export interface EdgeAttributes {
  label: string;
  condition: string;
  weight: number;
  fidelity: string;
  thread_id: string;
  loop_restart: boolean;
  [key: string]: unknown;
}

export const DEFAULT_EDGE_ATTRIBUTES: EdgeAttributes = {
  label: '',
  condition: '',
  weight: 0,
  fidelity: '',
  thread_id: '',
  loop_restart: false,
};

export interface Node {
  id: string;
  attrs: NodeAttributes;
}

export interface Edge {
  from: string;
  to: string;
  attrs: EdgeAttributes;
}

export interface Graph {
  name: string;
  attrs: GraphAttributes;
  nodes: Map<string, Node>;
  edges: Edge[];
}

// ---------------------------------------------------------------------------
// Node Handler Interface
// ---------------------------------------------------------------------------

export interface NodeHandler {
  handle(
    node: Node,
    context: PipelineContext,
    graph: Graph,
    logsRoot: string,
  ): Promise<Outcome>;
}

// ---------------------------------------------------------------------------
// CodergenBackend Interface
// ---------------------------------------------------------------------------

export interface CodergenBackend {
  run(
    node: Node,
    prompt: string,
    context: PipelineContext,
  ): Promise<string | Outcome>;
}

// ---------------------------------------------------------------------------
// Lint Result
// ---------------------------------------------------------------------------

export enum LintSeverity {
  ERROR = 'error',
  WARNING = 'warning',
  INFO = 'info',
}

export interface LintResult {
  rule: string;
  severity: LintSeverity;
  message: string;
  node_id?: string;
  edge?: { from: string; to: string };
  fix?: string;
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export interface Checkpoint {
  timestamp: string;
  current_node: string;
  completed_nodes: string[];
  node_retries: Record<string, number>;
  node_outcomes: Record<string, Outcome>;
  context_values: Record<string, unknown>;
  logs: string[];
}

// ---------------------------------------------------------------------------
// Pipeline Result
// ---------------------------------------------------------------------------

export interface PipelineResult {
  status: StageStatus;
  completed_nodes: string[];
  node_outcomes: Record<string, Outcome>;
  final_context: Record<string, unknown>;
  logs_root: string;
}

// ---------------------------------------------------------------------------
// Pipeline Context Interface (forward declaration)
// ---------------------------------------------------------------------------

export interface PipelineContext {
  set(key: string, value: unknown): void;
  get(key: string, defaultValue?: unknown): unknown;
  getString(key: string, defaultValue?: string): string;
  appendLog(entry: string): void;
  snapshot(): Record<string, unknown>;
  clone(): PipelineContext;
  applyUpdates(updates: Record<string, unknown>): void;
  getLogs(): string[];
}

// ---------------------------------------------------------------------------
// Retry Policy
// ---------------------------------------------------------------------------

export interface BackoffConfig {
  initial_delay_ms: number;
  backoff_factor: number;
  max_delay_ms: number;
  jitter: boolean;
}

export interface RetryPolicy {
  max_attempts: number;
  backoff: BackoffConfig;
  should_retry: (error: Error) => boolean;
}

export const PRESET_POLICIES: Record<string, Omit<RetryPolicy, 'should_retry'>> = {
  none: {
    max_attempts: 1,
    backoff: { initial_delay_ms: 0, backoff_factor: 1, max_delay_ms: 0, jitter: false },
  },
  standard: {
    max_attempts: 5,
    backoff: { initial_delay_ms: 200, backoff_factor: 2.0, max_delay_ms: 60000, jitter: true },
  },
  aggressive: {
    max_attempts: 5,
    backoff: { initial_delay_ms: 500, backoff_factor: 2.0, max_delay_ms: 60000, jitter: true },
  },
  linear: {
    max_attempts: 3,
    backoff: { initial_delay_ms: 500, backoff_factor: 1.0, max_delay_ms: 60000, jitter: true },
  },
  patient: {
    max_attempts: 3,
    backoff: { initial_delay_ms: 2000, backoff_factor: 3.0, max_delay_ms: 60000, jitter: true },
  },
};

// ---------------------------------------------------------------------------
// Interviewer Types
// ---------------------------------------------------------------------------

export enum QuestionType {
  SINGLE_SELECT = 'SINGLE_SELECT',
  MULTI_SELECT = 'MULTI_SELECT',
  FREE_TEXT = 'FREE_TEXT',
  CONFIRM = 'CONFIRM',
}

export interface QuestionOption {
  key: string;
  label: string;
}

export interface Question {
  text: string;
  type: QuestionType;
  options: QuestionOption[];
  default?: Answer;
  timeout_seconds?: number;
  stage: string;
  metadata: Record<string, unknown>;
}

export enum AnswerValue {
  YES = 'YES',
  NO = 'NO',
  SKIPPED = 'SKIPPED',
  TIMEOUT = 'TIMEOUT',
}

export interface Answer {
  value: string | AnswerValue;
  selected_option?: QuestionOption;
  text: string;
}

export interface Interviewer {
  ask(question: Question): Promise<Answer>;
  askMultiple?(questions: Question[]): Promise<Answer[]>;
  inform?(message: string, stage: string): void;
}

// ---------------------------------------------------------------------------
// Transform Interface
// ---------------------------------------------------------------------------

export interface Transform {
  apply(graph: Graph): Graph;
}

// ---------------------------------------------------------------------------
// Lint Rule Interface
// ---------------------------------------------------------------------------

export interface LintRule {
  name: string;
  apply(graph: Graph): LintResult[];
}

// ---------------------------------------------------------------------------
// Pipeline Event Types
// ---------------------------------------------------------------------------

export enum PipelineEventKind {
  PIPELINE_STARTED = 'pipeline_started',
  PIPELINE_COMPLETED = 'pipeline_completed',
  PIPELINE_FAILED = 'pipeline_failed',
  STAGE_STARTED = 'stage_started',
  STAGE_COMPLETED = 'stage_completed',
  STAGE_FAILED = 'stage_failed',
  STAGE_RETRYING = 'stage_retrying',
  PARALLEL_STARTED = 'parallel_started',
  PARALLEL_BRANCH_STARTED = 'parallel_branch_started',
  PARALLEL_BRANCH_COMPLETED = 'parallel_branch_completed',
  PARALLEL_COMPLETED = 'parallel_completed',
  INTERVIEW_STARTED = 'interview_started',
  INTERVIEW_COMPLETED = 'interview_completed',
  INTERVIEW_TIMEOUT = 'interview_timeout',
  CHECKPOINT_SAVED = 'checkpoint_saved',
  EDGE_SELECTED = 'edge_selected',
}

export interface PipelineEvent {
  kind: PipelineEventKind;
  timestamp: Date;
  data: Record<string, unknown>;
}
