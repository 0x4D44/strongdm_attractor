/**
 * Agent-loop types for the Coding Agent Loop library.
 * Imports LLM types from the unified-llm layer.
 */

import type {
  Message,
  ContentPart,
  ToolCall,
  ToolResult,
  Usage,
  Tool,
  StreamEvent,
  FinishReason,
  Role,
} from '../unified-llm/types.js';

// Re-export for convenience
export type {
  Message,
  ContentPart,
  ToolCall,
  ToolResult,
  Usage,
  Tool,
  StreamEvent,
  FinishReason,
  Role,
};

// ---------------------------------------------------------------------------
// Session State
// ---------------------------------------------------------------------------

export enum SessionState {
  IDLE = 'IDLE',
  PROCESSING = 'PROCESSING',
  AWAITING_INPUT = 'AWAITING_INPUT',
  CLOSED = 'CLOSED',
}

// ---------------------------------------------------------------------------
// Turn Types
// ---------------------------------------------------------------------------

export interface UserTurn {
  kind: 'user';
  content: string;
  timestamp: Date;
}

export interface AssistantTurn {
  kind: 'assistant';
  content: string;
  tool_calls: ToolCall[];
  reasoning: string | null;
  usage: Usage;
  response_id: string | null;
  timestamp: Date;
}

export interface ToolResultsTurn {
  kind: 'tool_results';
  results: ToolResult[];
  timestamp: Date;
}

export interface SystemTurn {
  kind: 'system';
  content: string;
  timestamp: Date;
}

export interface SteeringTurn {
  kind: 'steering';
  content: string;
  timestamp: Date;
}

export type Turn =
  | UserTurn
  | AssistantTurn
  | ToolResultsTurn
  | SystemTurn
  | SteeringTurn;

// ---------------------------------------------------------------------------
// Session Configuration
// ---------------------------------------------------------------------------

export interface SessionConfig {
  max_turns: number;
  max_tool_rounds_per_input: number;
  default_command_timeout_ms: number;
  max_command_timeout_ms: number;
  reasoning_effort: string | null;
  tool_output_limits: Map<string, number>;
  tool_line_limits: Map<string, number>;
  enable_loop_detection: boolean;
  loop_detection_window: number;
  max_subagent_depth: number;
  user_instructions: string | null;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  max_turns: 0,
  max_tool_rounds_per_input: 200,
  default_command_timeout_ms: 10_000,
  max_command_timeout_ms: 600_000,
  reasoning_effort: null,
  tool_output_limits: new Map(),
  tool_line_limits: new Map(),
  enable_loop_detection: true,
  loop_detection_window: 10,
  max_subagent_depth: 1,
  user_instructions: null,
};

// ---------------------------------------------------------------------------
// Provider Profile
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  env: ExecutionEnvironment,
) => Promise<string>;

export interface RegisteredTool {
  definition: ToolDefinition;
  executor: ToolExecutor;
}

export interface ProviderProfile {
  id: string;
  model: string;
  tool_registry: ToolRegistry;

  build_system_prompt(
    environment: ExecutionEnvironment,
    project_docs: string,
  ): string;
  tools(): ToolDefinition[];
  provider_options(): Record<string, unknown> | null;

  supports_reasoning: boolean;
  supports_streaming: boolean;
  supports_parallel_tool_calls: boolean;
  context_window_size: number;
}

// ---------------------------------------------------------------------------
// Tool Registry interface (implemented in tools/registry.ts)
// ---------------------------------------------------------------------------

export interface ToolRegistry {
  register(tool: RegisteredTool): void;
  unregister(name: string): void;
  get(name: string): RegisteredTool | undefined;
  definitions(): ToolDefinition[];
  names(): string[];
  validate(toolName: string, args: Record<string, unknown>): { valid: boolean; error?: string };
}

// ---------------------------------------------------------------------------
// Execution Environment interface (implemented in execution/)
// ---------------------------------------------------------------------------

export interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  duration_ms: number;
}

export interface DirEntry {
  name: string;
  is_dir: boolean;
  size: number | null;
}

export interface GrepOptions {
  glob_filter?: string;
  case_insensitive?: boolean;
  max_results?: number;
}

export interface ExecutionEnvironment {
  /** Read file and return raw content (no line-number formatting). */
  read_file(
    path: string,
    offset?: number | null,
    limit?: number | null,
  ): Promise<string>;
  write_file(path: string, content: string): Promise<void>;
  file_exists(path: string): Promise<boolean>;
  list_directory(path: string, depth: number): Promise<DirEntry[]>;

  exec_command(
    command: string,
    timeout_ms: number,
    working_dir?: string | null,
    env_vars?: Record<string, string> | null,
  ): Promise<ExecResult>;

  grep(pattern: string, path: string, options: GrepOptions): Promise<string>;
  glob(pattern: string, path?: string): Promise<string[]>;

  initialize(): Promise<void>;
  cleanup(): Promise<void>;

  working_directory(): string;
  platform(): string;
  os_version(): string;
}

// ---------------------------------------------------------------------------
// SubAgent
// ---------------------------------------------------------------------------

export type SubAgentStatus = 'running' | 'completed' | 'failed';

export interface SubAgentResult {
  output: string;
  success: boolean;
  turns_used: number;
}

export interface SubAgentHandle {
  id: string;
  status: SubAgentStatus;
  result: SubAgentResult | null;
}

// ---------------------------------------------------------------------------
// Event System
// ---------------------------------------------------------------------------

export enum EventKind {
  SESSION_START = 'SESSION_START',
  SESSION_END = 'SESSION_END',
  USER_INPUT = 'USER_INPUT',
  LLM_CALL_START = 'LLM_CALL_START',
  LLM_CALL_END = 'LLM_CALL_END',
  ASSISTANT_TEXT_START = 'ASSISTANT_TEXT_START',
  ASSISTANT_TEXT_DELTA = 'ASSISTANT_TEXT_DELTA',
  ASSISTANT_TEXT_END = 'ASSISTANT_TEXT_END',
  TOOL_CALL_START = 'TOOL_CALL_START',
  TOOL_CALL_OUTPUT_DELTA = 'TOOL_CALL_OUTPUT_DELTA',
  TOOL_CALL_END = 'TOOL_CALL_END',
  TOOL_CALL_ERROR = 'TOOL_CALL_ERROR',
  STEERING_INJECTED = 'STEERING_INJECTED',
  TURN_COMPLETE = 'TURN_COMPLETE',
  TURN_LIMIT = 'TURN_LIMIT',
  LOOP_DETECTION = 'LOOP_DETECTION',
  SUBAGENT_SPAWN = 'SUBAGENT_SPAWN',
  SUBAGENT_COMPLETE = 'SUBAGENT_COMPLETE',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
}

export interface SessionEvent {
  kind: EventKind;
  timestamp: Date;
  session_id: string;
  data: Record<string, unknown>;
}
