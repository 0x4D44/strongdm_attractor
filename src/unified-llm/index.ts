// ============================================================================
// Unified LLM Client — Barrel Exports
// ============================================================================

// --- Types ---
export {
  // Enums
  Role,
  ContentKind,
  StreamEventType,
  // Classes
  Message,
  Usage,
  Response,
  // Error hierarchy
  LLMError,
  ProviderError,
  AuthenticationError,
  AccessDeniedError,
  NotFoundError,
  InvalidRequestError,
  RateLimitError,
  ServerError,
  ContentFilterError,
  ContextLengthError,
  QuotaExceededError,
  RequestTimeoutError,
  AbortError,
  NetworkError,
  StreamError,
  InvalidToolCallError,
  NoObjectGeneratedError,
  ConfigurationError,
  // Helpers
  errorFromStatusCode,
} from "./types.js";

export type {
  // Content data
  ImageData,
  AudioData,
  DocumentData,
  ToolCallData,
  ToolResultData,
  ThinkingData,
  ContentPart,
  // Tool types
  Tool,
  ToolCall,
  ToolResult,
  ToolChoice,
  ToolExecuteHandler,
  ToolDefinition,
  // Request/Response
  Request,
  FinishReason,
  ResponseFormat,
  Warning,
  RateLimitInfo,
  StreamEvent,
  // Generation
  StepResult,
  GenerateResult,
  // Config
  TimeoutConfig,
  AdapterTimeout,
  StopCondition,
  RetryPolicy,
  ModelInfo,
  // Adapter interface
  ProviderAdapter,
  // Middleware
  Middleware,
  MiddlewareNext,
  StreamMiddleware,
  StreamMiddlewareNext,
} from "./types.js";

// --- Client ---
export { Client, getDefaultClient, setDefaultClient } from "./client.js";
export type { ClientOptions } from "./client.js";

// --- High-Level API ---
export { generate, stream, generate_object } from "./api.js";
export type { GenerateOptions, StreamOptions, StreamResult, GenerateObjectOptions } from "./api.js";

// --- Model Catalog ---
export { MODELS, getModelInfo, listModels, getLatestModel } from "./model-catalog.js";

// --- Middleware ---
export {
  buildMiddlewareChain,
  buildStreamMiddlewareChain,
  createLoggingMiddleware,
} from "./middleware.js";

// --- Adapters ---
export { OpenAIAdapter } from "./adapters/openai.js";
export type { OpenAIAdapterOptions } from "./adapters/openai.js";

export { AnthropicAdapter } from "./adapters/anthropic.js";
export type { AnthropicAdapterOptions } from "./adapters/anthropic.js";

export { GeminiAdapter } from "./adapters/gemini.js";
export type { GeminiAdapterOptions } from "./adapters/gemini.js";

// --- Utilities ---
export { retry } from "./utils/retry.js";
export { httpRequest, httpStreamRequest } from "./utils/http.js";
export { parseSSEStream } from "./utils/sse.js";
