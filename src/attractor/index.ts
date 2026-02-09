/**
 * Attractor Pipeline Engine - barrel exports.
 *
 * DOT-based pipeline runner for multi-stage AI workflows.
 */

// Core types
export {
  StageStatus,
  HandlerType,
  LintSeverity,
  QuestionType,
  AnswerValue,
  PipelineEventKind,
  SHAPE_TO_HANDLER_TYPE,
  DEFAULT_GRAPH_ATTRIBUTES,
  DEFAULT_NODE_ATTRIBUTES,
  DEFAULT_EDGE_ATTRIBUTES,
  PRESET_POLICIES,
  makeOutcome,
} from './types.js';

export type {
  Outcome,
  Graph,
  Node,
  Edge,
  GraphAttributes,
  NodeAttributes,
  EdgeAttributes,
  NodeHandler,
  CodergenBackend,
  LintResult,
  LintRule,
  Checkpoint,
  PipelineResult,
  PipelineContext,
  RetryPolicy,
  BackoffConfig,
  Question,
  QuestionOption,
  Answer,
  Interviewer,
  Transform,
  PipelineEvent,
} from './types.js';

// Parser
export { DotLexer, stripComments } from './parser/dot-lexer.js';
export type { Token } from './parser/dot-lexer.js';
export { TokenType } from './parser/dot-lexer.js';
export { DotParser, parseDot } from './parser/dot-parser.js';
export { validate, validateOrRaise } from './parser/validator.js';

// Conditions
export { evaluateCondition, resolveKey } from './conditions.js';

// Stylesheet
export { parseStylesheet, applyStylesheet } from './stylesheet.js';
export type { StyleRule, StyleSelector, StyleDeclaration } from './stylesheet.js';
export { SelectorType } from './stylesheet.js';

// Engine
export { Context } from './engine/context.js';
export { selectEdge, normalizeLabel } from './engine/edge-selection.js';
export {
  createCheckpoint,
  saveCheckpoint,
  loadCheckpoint,
  restoreFromCheckpoint,
} from './engine/checkpoint.js';
export {
  PipelineEngine,
  parseDuration,
  delayForAttempt,
} from './engine/pipeline.js';
export type { PipelineConfig } from './engine/pipeline.js';

// Handlers
export {
  HandlerRegistry,
  StartHandler,
  ExitHandler,
  CodergenHandler,
  WaitHumanHandler,
  parseAcceleratorKey,
  ConditionalHandler,
  ParallelHandler,
  FanInHandler,
  ToolHandler,
  StackManagerHandler,
} from './handlers/index.js';
export type { SubgraphExecutor } from './handlers/index.js';

// Interviewer implementations
export {
  AutoApproveInterviewer,
  ConsoleInterviewer,
  CallbackInterviewer,
  QueueInterviewer,
  RecordingInterviewer,
} from './interviewer.js';

// Events
export {
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
export type { EventListener } from './events.js';

// Transforms
export {
  VariableExpansionTransform,
  StylesheetTransform,
  applyTransforms,
} from './transforms.js';

// Utils
export { parseDuration as parseDurationUtil } from './utils.js';
