// ============================================================================
// Unified LLM Client — Data Model Types
// ============================================================================

// --- Enums -------------------------------------------------------------------

export enum Role {
  SYSTEM = "system",
  USER = "user",
  ASSISTANT = "assistant",
  TOOL = "tool",
  DEVELOPER = "developer",
}

export enum ContentKind {
  TEXT = "text",
  IMAGE = "image",
  AUDIO = "audio",
  DOCUMENT = "document",
  TOOL_CALL = "tool_call",
  TOOL_RESULT = "tool_result",
  THINKING = "thinking",
  REDACTED_THINKING = "redacted_thinking",
}

export enum StreamEventType {
  STREAM_START = "stream_start",
  TEXT_START = "text_start",
  TEXT_DELTA = "text_delta",
  TEXT_END = "text_end",
  REASONING_START = "reasoning_start",
  REASONING_DELTA = "reasoning_delta",
  REASONING_END = "reasoning_end",
  TOOL_CALL_START = "tool_call_start",
  TOOL_CALL_DELTA = "tool_call_delta",
  TOOL_CALL_END = "tool_call_end",
  FINISH = "finish",
  ERROR = "error",
  PROVIDER_EVENT = "provider_event",
}

// --- Content Data Structures -------------------------------------------------

export interface ImageData {
  url?: string;
  data?: string; // base64-encoded
  media_type?: string;
  detail?: "auto" | "low" | "high";
}

export interface AudioData {
  url?: string;
  data?: string; // base64-encoded
  media_type?: string;
}

export interface DocumentData {
  url?: string;
  data?: string; // base64-encoded
  media_type?: string;
  file_name?: string;
}

export interface ToolCallData {
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
  type?: string; // "function" (default) or "custom"
}

export interface ToolResultData {
  tool_call_id: string;
  content: string | Record<string, unknown>;
  is_error: boolean;
  image_data?: string; // base64-encoded
  image_media_type?: string;
}

export interface ThinkingData {
  text: string;
  signature?: string;
  redacted?: boolean;
}

// --- ContentPart (Tagged Union) ----------------------------------------------

export interface ContentPart {
  kind: ContentKind | string;
  text?: string;
  image?: ImageData;
  audio?: AudioData;
  document?: DocumentData;
  tool_call?: ToolCallData;
  tool_result?: ToolResultData;
  thinking?: ThinkingData;
}

// --- Message -----------------------------------------------------------------

export class Message {
  role: Role;
  content: ContentPart[];
  name?: string;
  tool_call_id?: string;

  constructor(init: {
    role: Role;
    content: ContentPart[];
    name?: string;
    tool_call_id?: string;
  }) {
    this.role = init.role;
    this.content = init.content;
    this.name = init.name;
    this.tool_call_id = init.tool_call_id;
  }

  get text(): string {
    return this.content
      .filter((p) => p.kind === ContentKind.TEXT && p.text != null)
      .map((p) => p.text!)
      .join("");
  }

  static system(text: string): Message {
    return new Message({
      role: Role.SYSTEM,
      content: [{ kind: ContentKind.TEXT, text }],
    });
  }

  static user(text: string): Message {
    return new Message({
      role: Role.USER,
      content: [{ kind: ContentKind.TEXT, text }],
    });
  }

  static assistant(text: string): Message {
    return new Message({
      role: Role.ASSISTANT,
      content: [{ kind: ContentKind.TEXT, text }],
    });
  }

  static tool_result(
    tool_call_id: string,
    content: string | Record<string, unknown>,
    is_error = false,
  ): Message {
    return new Message({
      role: Role.TOOL,
      content: [
        {
          kind: ContentKind.TOOL_RESULT,
          tool_result: { tool_call_id, content, is_error },
        },
      ],
      tool_call_id,
    });
  }
}

// --- Tool & ToolChoice -------------------------------------------------------

export type ToolExecuteHandler = (
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute?: ToolExecuteHandler;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  raw_arguments?: string;
}

export interface ToolResult {
  tool_call_id: string;
  content: string | Record<string, unknown> | unknown[];
  is_error: boolean;
}

export interface ToolChoice {
  mode: "auto" | "none" | "required" | "named";
  tool_name?: string;
}

// --- FinishReason ------------------------------------------------------------

export interface FinishReason {
  reason: "stop" | "length" | "tool_calls" | "content_filter" | "error" | "other";
  raw?: string;
}

// --- Usage -------------------------------------------------------------------

export class Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  raw?: Record<string, unknown>;

  constructor(init: {
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
    reasoning_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    raw?: Record<string, unknown>;
  }) {
    this.input_tokens = init.input_tokens;
    this.output_tokens = init.output_tokens;
    this.total_tokens =
      init.total_tokens ?? init.input_tokens + init.output_tokens;
    this.reasoning_tokens = init.reasoning_tokens;
    this.cache_read_tokens = init.cache_read_tokens;
    this.cache_write_tokens = init.cache_write_tokens;
    this.raw = init.raw;
  }

  add(other: Usage): Usage {
    const addOptional = (
      a: number | undefined,
      b: number | undefined,
    ): number | undefined => {
      if (a == null && b == null) return undefined;
      return (a ?? 0) + (b ?? 0);
    };
    return new Usage({
      input_tokens: this.input_tokens + other.input_tokens,
      output_tokens: this.output_tokens + other.output_tokens,
      total_tokens: this.total_tokens + other.total_tokens,
      reasoning_tokens: addOptional(this.reasoning_tokens, other.reasoning_tokens),
      cache_read_tokens: addOptional(
        this.cache_read_tokens,
        other.cache_read_tokens,
      ),
      cache_write_tokens: addOptional(
        this.cache_write_tokens,
        other.cache_write_tokens,
      ),
    });
  }

  static zero(): Usage {
    return new Usage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  }
}

// --- ResponseFormat ----------------------------------------------------------

export interface ResponseFormat {
  type: "text" | "json" | "json_schema";
  json_schema?: Record<string, unknown>;
  strict?: boolean;
}

// --- Warning / RateLimitInfo -------------------------------------------------

export interface Warning {
  message: string;
  code?: string;
}

export interface RateLimitInfo {
  requests_remaining?: number;
  requests_limit?: number;
  tokens_remaining?: number;
  tokens_limit?: number;
  reset_at?: Date;
}

// --- Request -----------------------------------------------------------------

export interface Request {
  model: string;
  messages: Message[];
  provider?: string;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  response_format?: ResponseFormat;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop_sequences?: string[];
  reasoning_effort?: "none" | "low" | "medium" | "high";
  metadata?: Record<string, string>;
  provider_options?: Record<string, Record<string, unknown>>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// --- Response ----------------------------------------------------------------

export class Response {
  id: string;
  model: string;
  provider: string;
  message: Message;
  finish_reason: FinishReason;
  usage: Usage;
  raw?: Record<string, unknown>;
  warnings: Warning[];
  rate_limit?: RateLimitInfo;

  constructor(init: {
    id: string;
    model: string;
    provider: string;
    message: Message;
    finish_reason: FinishReason;
    usage: Usage;
    raw?: Record<string, unknown>;
    warnings?: Warning[];
    rate_limit?: RateLimitInfo;
  }) {
    this.id = init.id;
    this.model = init.model;
    this.provider = init.provider;
    this.message = init.message;
    this.finish_reason = init.finish_reason;
    this.usage = init.usage;
    this.raw = init.raw;
    this.warnings = init.warnings ?? [];
    this.rate_limit = init.rate_limit;
  }

  get text(): string {
    return this.message.text;
  }

  get tool_calls(): ToolCall[] {
    return this.message.content
      .filter((p) => p.kind === ContentKind.TOOL_CALL && p.tool_call != null)
      .map((p) => {
        const tc = p.tool_call!;
        const args =
          typeof tc.arguments === "string"
            ? JSON.parse(tc.arguments)
            : tc.arguments;
        return {
          id: tc.id,
          name: tc.name,
          arguments: args as Record<string, unknown>,
          raw_arguments:
            typeof tc.arguments === "string" ? tc.arguments : undefined,
        };
      });
  }

  get reasoning(): string | undefined {
    const parts = this.message.content.filter(
      (p) => p.kind === ContentKind.THINKING && p.thinking?.text,
    );
    if (parts.length === 0) return undefined;
    return parts.map((p) => p.thinking!.text).join("");
  }
}

// --- StreamEvent -------------------------------------------------------------

export interface StreamEvent {
  type: StreamEventType | string;
  delta?: string;
  text_id?: string;
  reasoning_delta?: string;
  tool_call?: Partial<ToolCall>;
  finish_reason?: FinishReason;
  usage?: Usage;
  response?: Response;
  error?: LLMError;
  raw?: Record<string, unknown>;
}

// --- StepResult & GenerateResult ---------------------------------------------

export interface StepResult {
  text: string;
  reasoning?: string;
  tool_calls: ToolCall[];
  tool_results: ToolResult[];
  finish_reason: FinishReason;
  usage: Usage;
  response: Response;
  warnings: Warning[];
}

export interface GenerateResult {
  text: string;
  reasoning?: string;
  tool_calls: ToolCall[];
  tool_results: ToolResult[];
  finish_reason: FinishReason;
  usage: Usage;
  total_usage: Usage;
  steps: StepResult[];
  response: Response;
  output?: unknown;
}

// --- Timeout Config ----------------------------------------------------------

export interface TimeoutConfig {
  total?: number;
  per_step?: number;
}

export interface AdapterTimeout {
  connect: number; // default 10s
  request: number; // default 120s
  stream_read: number; // default 30s
}

// --- Stop Condition ----------------------------------------------------------

export type StopCondition = (steps: StepResult[]) => boolean;

// --- Error Hierarchy ---------------------------------------------------------

export class LLMError extends Error {
  cause?: Error;
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "LLMError";
    this.cause = cause;
  }
}

export class ProviderError extends LLMError {
  provider: string;
  status_code?: number;
  error_code?: string;
  retryable: boolean;
  retry_after?: number;
  raw?: Record<string, unknown>;

  constructor(init: {
    message: string;
    provider: string;
    status_code?: number;
    error_code?: string;
    retryable: boolean;
    retry_after?: number;
    raw?: Record<string, unknown>;
    cause?: Error;
  }) {
    super(init.message, init.cause);
    this.name = "ProviderError";
    this.provider = init.provider;
    this.status_code = init.status_code;
    this.error_code = init.error_code;
    this.retryable = init.retryable;
    this.retry_after = init.retry_after;
    this.raw = init.raw;
  }
}

export class AuthenticationError extends ProviderError {
  constructor(init: Omit<ConstructorParameters<typeof ProviderError>[0], "retryable">) {
    super({ ...init, retryable: false });
    this.name = "AuthenticationError";
  }
}

export class AccessDeniedError extends ProviderError {
  constructor(init: Omit<ConstructorParameters<typeof ProviderError>[0], "retryable">) {
    super({ ...init, retryable: false });
    this.name = "AccessDeniedError";
  }
}

export class NotFoundError extends ProviderError {
  constructor(init: Omit<ConstructorParameters<typeof ProviderError>[0], "retryable">) {
    super({ ...init, retryable: false });
    this.name = "NotFoundError";
  }
}

export class InvalidRequestError extends ProviderError {
  constructor(init: Omit<ConstructorParameters<typeof ProviderError>[0], "retryable">) {
    super({ ...init, retryable: false });
    this.name = "InvalidRequestError";
  }
}

export class RateLimitError extends ProviderError {
  constructor(init: Omit<ConstructorParameters<typeof ProviderError>[0], "retryable">) {
    super({ ...init, retryable: true });
    this.name = "RateLimitError";
  }
}

export class ServerError extends ProviderError {
  constructor(init: Omit<ConstructorParameters<typeof ProviderError>[0], "retryable">) {
    super({ ...init, retryable: true });
    this.name = "ServerError";
  }
}

export class ContentFilterError extends ProviderError {
  constructor(init: Omit<ConstructorParameters<typeof ProviderError>[0], "retryable">) {
    super({ ...init, retryable: false });
    this.name = "ContentFilterError";
  }
}

export class ContextLengthError extends ProviderError {
  constructor(init: Omit<ConstructorParameters<typeof ProviderError>[0], "retryable">) {
    super({ ...init, retryable: false });
    this.name = "ContextLengthError";
  }
}

export class QuotaExceededError extends ProviderError {
  constructor(init: Omit<ConstructorParameters<typeof ProviderError>[0], "retryable">) {
    super({ ...init, retryable: false });
    this.name = "QuotaExceededError";
  }
}

export class RequestTimeoutError extends ProviderError {
  constructor(init: string | Omit<ConstructorParameters<typeof ProviderError>[0], "retryable">) {
    if (typeof init === "string") {
      super({ message: init, provider: "unknown", retryable: true });
    } else {
      super({ ...init, retryable: true });
    }
    this.name = "RequestTimeoutError";
  }
}

export class AbortError extends LLMError {
  constructor(message = "Request was aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export class NetworkError extends LLMError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = "NetworkError";
  }
}

export class StreamError extends LLMError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = "StreamError";
  }
}

export class InvalidToolCallError extends LLMError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = "InvalidToolCallError";
  }
}

export class NoObjectGeneratedError extends LLMError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = "NoObjectGeneratedError";
  }
}

export class ConfigurationError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

// --- Provider Adapter Interface ----------------------------------------------

export interface ProviderAdapter {
  readonly name: string;
  complete(request: Request): Promise<Response>;
  stream(request: Request): AsyncIterable<StreamEvent>;
  close?(): Promise<void>;
  initialize?(): Promise<void>;
  supports_tool_choice?(mode: string): boolean;
}

// --- Middleware ---------------------------------------------------------------

export type MiddlewareNext = (request: Request) => Promise<Response>;
export type StreamMiddlewareNext = (
  request: Request,
) => AsyncIterable<StreamEvent>;

export type Middleware = (
  request: Request,
  next: MiddlewareNext,
) => Promise<Response>;

export type StreamMiddleware = (
  request: Request,
  next: StreamMiddlewareNext,
) => AsyncIterable<StreamEvent>;

// --- Retry Policy ------------------------------------------------------------

export interface RetryPolicy {
  max_retries: number;
  base_delay: number;
  max_delay: number;
  backoff_multiplier: number;
  jitter: boolean;
  on_retry?: (error: Error, attempt: number, delay: number) => void;
}

// --- Model Catalog -----------------------------------------------------------

export interface ModelInfo {
  id: string;
  provider: string;
  display_name: string;
  context_window: number;
  max_output?: number;
  supports_tools: boolean;
  supports_vision: boolean;
  supports_reasoning: boolean;
  input_cost_per_million?: number;
  output_cost_per_million?: number;
  aliases?: string[];
}

// --- Helper: create ProviderError from HTTP status code ----------------------

export function errorFromStatusCode(
  statusCode: number,
  message: string,
  provider: string,
  errorCode?: string,
  raw?: Record<string, unknown>,
  retryAfter?: number,
): ProviderError {
  const base = { message, provider, status_code: statusCode, error_code: errorCode, raw, retry_after: retryAfter };

  // Check message for disambiguation
  const lowerMsg = message.toLowerCase();

  switch (statusCode) {
    case 400:
    case 422:
      if (lowerMsg.includes("context length") || lowerMsg.includes("too many tokens")) {
        return new ContextLengthError(base);
      }
      return new InvalidRequestError(base);
    case 401:
      return new AuthenticationError(base);
    case 403:
      return new AccessDeniedError(base);
    case 404:
      return new NotFoundError(base);
    case 408:
      return new RequestTimeoutError(base);
    case 413:
      return new ContextLengthError(base);
    case 429:
      return new RateLimitError(base);
    case 500:
    case 502:
    case 503:
    case 504:
      return new ServerError(base);
    default: {
      // Message-based classification
      if (lowerMsg.includes("not found") || lowerMsg.includes("does not exist")) {
        return new NotFoundError(base);
      }
      if (lowerMsg.includes("unauthorized") || lowerMsg.includes("invalid key")) {
        return new AuthenticationError(base);
      }
      if (lowerMsg.includes("context length") || lowerMsg.includes("too many tokens")) {
        return new ContextLengthError(base);
      }
      if (lowerMsg.includes("content filter") || lowerMsg.includes("safety")) {
        return new ContentFilterError(base);
      }
      // Default: retryable (unknown errors)
      return new ProviderError({ ...base, retryable: true });
    }
  }
}
