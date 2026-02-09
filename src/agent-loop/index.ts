/**
 * Coding Agent Loop — barrel exports.
 *
 * This is the public API surface for the agent-loop library.
 */

// Types
export {
  SessionState,
  EventKind,
  DEFAULT_SESSION_CONFIG,
  type UserTurn,
  type AssistantTurn,
  type ToolResultsTurn,
  type SystemTurn,
  type SteeringTurn,
  type Turn,
  type SessionConfig,
  type ToolDefinition,
  type ToolExecutor,
  type RegisteredTool,
  type ProviderProfile,
  type ToolRegistry as IToolRegistry,
  type ExecutionEnvironment,
  type ExecResult,
  type DirEntry,
  type GrepOptions,
  type SubAgentStatus,
  type SubAgentResult,
  type SubAgentHandle,
  type SessionEvent,
} from './types.js';

// Re-export LLM types that consumers may need
export type {
  Message,
  ContentPart,
  ToolCall,
  ToolResult,
  Usage,
  FinishReason,
  Role,
} from './types.js';

// Events
export { EventEmitter, type EventListener } from './events.js';

// Tool Registry
export { ToolRegistry } from './tools/registry.js';

// Shared tools
export {
  readFileTool,
  writeFileTool,
  editFileTool,
  shellTool,
  grepTool,
  globTool,
  SHARED_TOOLS,
} from './tools/shared.js';

// Provider profiles
export { createOpenAIProfile, applyPatchTool } from './tools/openai-profile.js';
export { createAnthropicProfile } from './tools/anthropic-profile.js';
export { createGeminiProfile } from './tools/gemini-profile.js';

// Execution environment
export { LocalExecutionEnvironment, type LocalExecutionOptions, type EnvVarPolicy } from './execution/local.js';

// Truncation
export {
  truncateByChars,
  truncateByLines,
  truncateToolOutput,
  DEFAULT_TOOL_CHAR_LIMITS,
  DEFAULT_TRUNCATION_MODES,
  DEFAULT_TOOL_LINE_LIMITS,
} from './truncation.js';

// Core loop
export {
  processInput,
  convertHistoryToMessages,
  discoverProjectDocs,
  detectLoop,
  type LLMClient,
  type LLMRequest,
  type LLMResponse,
  type LoopContext,
} from './loop.js';

// Session
export { Session, type SessionOptions } from './session.js';

// Subagents
export { SubAgentManager, createSubagentTools } from './subagent.js';
