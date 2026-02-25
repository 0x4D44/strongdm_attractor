import { describe, it, expect } from "vitest";
import {
  Role,
  ContentKind,
  StreamEventType,
  Message,
  Usage,
  Response,
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
  errorFromStatusCode,
} from "./types.js";

// =============================================================================
// Enums
// =============================================================================

describe("Role enum", () => {
  it("has correct values", () => {
    expect(Role.SYSTEM).toBe("system");
    expect(Role.USER).toBe("user");
    expect(Role.ASSISTANT).toBe("assistant");
    expect(Role.TOOL).toBe("tool");
    expect(Role.DEVELOPER).toBe("developer");
  });
});

describe("ContentKind enum", () => {
  it("has correct values", () => {
    expect(ContentKind.TEXT).toBe("text");
    expect(ContentKind.IMAGE).toBe("image");
    expect(ContentKind.AUDIO).toBe("audio");
    expect(ContentKind.DOCUMENT).toBe("document");
    expect(ContentKind.TOOL_CALL).toBe("tool_call");
    expect(ContentKind.TOOL_RESULT).toBe("tool_result");
    expect(ContentKind.THINKING).toBe("thinking");
    expect(ContentKind.REDACTED_THINKING).toBe("redacted_thinking");
  });
});

describe("StreamEventType enum", () => {
  it("has correct values", () => {
    expect(StreamEventType.STREAM_START).toBe("stream_start");
    expect(StreamEventType.TEXT_START).toBe("text_start");
    expect(StreamEventType.TEXT_DELTA).toBe("text_delta");
    expect(StreamEventType.TEXT_END).toBe("text_end");
    expect(StreamEventType.REASONING_START).toBe("reasoning_start");
    expect(StreamEventType.REASONING_DELTA).toBe("reasoning_delta");
    expect(StreamEventType.REASONING_END).toBe("reasoning_end");
    expect(StreamEventType.TOOL_CALL_START).toBe("tool_call_start");
    expect(StreamEventType.TOOL_CALL_DELTA).toBe("tool_call_delta");
    expect(StreamEventType.TOOL_CALL_END).toBe("tool_call_end");
    expect(StreamEventType.FINISH).toBe("finish");
    expect(StreamEventType.ERROR).toBe("error");
    expect(StreamEventType.PROVIDER_EVENT).toBe("provider_event");
  });
});

// =============================================================================
// Message
// =============================================================================

describe("Message", () => {
  it("constructs with content parts", () => {
    const msg = new Message({
      role: Role.USER,
      content: [{ kind: ContentKind.TEXT, text: "hello" }],
    });
    expect(msg.role).toBe(Role.USER);
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0].text).toBe("hello");
  });

  it("text getter concatenates text parts", () => {
    const msg = new Message({
      role: Role.ASSISTANT,
      content: [
        { kind: ContentKind.TEXT, text: "Hello " },
        { kind: ContentKind.TEXT, text: "world" },
      ],
    });
    expect(msg.text).toBe("Hello world");
  });

  it("text getter skips non-text parts", () => {
    const msg = new Message({
      role: Role.ASSISTANT,
      content: [
        { kind: ContentKind.TEXT, text: "Hello" },
        { kind: ContentKind.TOOL_CALL, tool_call: { id: "1", name: "fn", arguments: {} } },
        { kind: ContentKind.TEXT, text: " world" },
      ],
    });
    expect(msg.text).toBe("Hello world");
  });

  it("text getter returns empty string for no text parts", () => {
    const msg = new Message({
      role: Role.ASSISTANT,
      content: [{ kind: ContentKind.TOOL_CALL, tool_call: { id: "1", name: "fn", arguments: {} } }],
    });
    expect(msg.text).toBe("");
  });

  it("text getter skips parts where text is null", () => {
    const msg = new Message({
      role: Role.ASSISTANT,
      content: [
        { kind: ContentKind.TEXT }, // text is undefined
        { kind: ContentKind.TEXT, text: "ok" },
      ],
    });
    expect(msg.text).toBe("ok");
  });

  describe("static constructors", () => {
    it("system() creates a system message", () => {
      const msg = Message.system("You are a helper");
      expect(msg.role).toBe(Role.SYSTEM);
      expect(msg.text).toBe("You are a helper");
      expect(msg.content).toHaveLength(1);
      expect(msg.content[0].kind).toBe(ContentKind.TEXT);
    });

    it("user() creates a user message", () => {
      const msg = Message.user("What is 2+2?");
      expect(msg.role).toBe(Role.USER);
      expect(msg.text).toBe("What is 2+2?");
    });

    it("assistant() creates an assistant message", () => {
      const msg = Message.assistant("4");
      expect(msg.role).toBe(Role.ASSISTANT);
      expect(msg.text).toBe("4");
    });

    it("tool_result() creates a tool result message", () => {
      const msg = Message.tool_result("call_1", "result data", false);
      expect(msg.role).toBe(Role.TOOL);
      expect(msg.tool_call_id).toBe("call_1");
      expect(msg.content).toHaveLength(1);
      expect(msg.content[0].kind).toBe(ContentKind.TOOL_RESULT);
      expect(msg.content[0].tool_result?.tool_call_id).toBe("call_1");
      expect(msg.content[0].tool_result?.content).toBe("result data");
      expect(msg.content[0].tool_result?.is_error).toBe(false);
    });

    it("tool_result() defaults is_error to false", () => {
      const msg = Message.tool_result("call_1", "ok");
      expect(msg.content[0].tool_result?.is_error).toBe(false);
    });

    it("tool_result() accepts object content", () => {
      const msg = Message.tool_result("call_1", { key: "value" });
      expect(msg.content[0].tool_result?.content).toEqual({ key: "value" });
    });

    it("tool_result() accepts is_error=true", () => {
      const msg = Message.tool_result("call_1", "error!", true);
      expect(msg.content[0].tool_result?.is_error).toBe(true);
    });
  });

  it("stores optional name property", () => {
    const msg = new Message({
      role: Role.USER,
      content: [{ kind: ContentKind.TEXT, text: "hi" }],
      name: "Alice",
    });
    expect(msg.name).toBe("Alice");
  });
});

// =============================================================================
// Usage
// =============================================================================

describe("Usage", () => {
  it("calculates total_tokens as input + output by default", () => {
    const u = new Usage({ input_tokens: 100, output_tokens: 50 });
    expect(u.total_tokens).toBe(150);
  });

  it("uses explicit total_tokens when provided", () => {
    const u = new Usage({ input_tokens: 100, output_tokens: 50, total_tokens: 200 });
    expect(u.total_tokens).toBe(200);
  });

  it("stores optional fields", () => {
    const u = new Usage({
      input_tokens: 10,
      output_tokens: 20,
      reasoning_tokens: 5,
      cache_read_tokens: 3,
      cache_write_tokens: 2,
      raw: { foo: "bar" },
    });
    expect(u.reasoning_tokens).toBe(5);
    expect(u.cache_read_tokens).toBe(3);
    expect(u.cache_write_tokens).toBe(2);
    expect(u.raw).toEqual({ foo: "bar" });
  });

  describe("add()", () => {
    it("adds two usages together", () => {
      const a = new Usage({ input_tokens: 10, output_tokens: 20 });
      const b = new Usage({ input_tokens: 5, output_tokens: 15 });
      const sum = a.add(b);
      expect(sum.input_tokens).toBe(15);
      expect(sum.output_tokens).toBe(35);
      expect(sum.total_tokens).toBe(50);
    });

    it("adds optional fields when both present", () => {
      const a = new Usage({ input_tokens: 10, output_tokens: 20, reasoning_tokens: 5 });
      const b = new Usage({ input_tokens: 5, output_tokens: 15, reasoning_tokens: 3 });
      const sum = a.add(b);
      expect(sum.reasoning_tokens).toBe(8);
    });

    it("adds optional fields when only one present", () => {
      const a = new Usage({ input_tokens: 10, output_tokens: 20, reasoning_tokens: 5 });
      const b = new Usage({ input_tokens: 5, output_tokens: 15 });
      const sum = a.add(b);
      expect(sum.reasoning_tokens).toBe(5);
    });

    it("returns undefined for optional fields when both absent", () => {
      const a = new Usage({ input_tokens: 10, output_tokens: 20 });
      const b = new Usage({ input_tokens: 5, output_tokens: 15 });
      const sum = a.add(b);
      expect(sum.reasoning_tokens).toBeUndefined();
      expect(sum.cache_read_tokens).toBeUndefined();
      expect(sum.cache_write_tokens).toBeUndefined();
    });

    it("handles cache tokens addition", () => {
      const a = new Usage({ input_tokens: 10, output_tokens: 20, cache_read_tokens: 4, cache_write_tokens: 2 });
      const b = new Usage({ input_tokens: 5, output_tokens: 15, cache_read_tokens: 6 });
      const sum = a.add(b);
      expect(sum.cache_read_tokens).toBe(10);
      expect(sum.cache_write_tokens).toBe(2);
    });
  });

  describe("zero()", () => {
    it("creates a zero usage", () => {
      const u = Usage.zero();
      expect(u.input_tokens).toBe(0);
      expect(u.output_tokens).toBe(0);
      expect(u.total_tokens).toBe(0);
    });
  });
});

// =============================================================================
// Response
// =============================================================================

describe("Response", () => {
  function makeResponse(opts?: Partial<{
    content: import("./types.js").ContentPart[];
    finish_reason: import("./types.js").FinishReason;
  }>) {
    const message = new Message({
      role: Role.ASSISTANT,
      content: opts?.content ?? [{ kind: ContentKind.TEXT, text: "Hello" }],
    });
    return new Response({
      id: "resp_1",
      model: "gpt-4",
      provider: "openai",
      message,
      finish_reason: opts?.finish_reason ?? { reason: "stop", raw: "stop" },
      usage: new Usage({ input_tokens: 10, output_tokens: 20 }),
    });
  }

  it("text getter delegates to message.text", () => {
    const resp = makeResponse();
    expect(resp.text).toBe("Hello");
  });

  it("tool_calls getter extracts tool calls", () => {
    const resp = makeResponse({
      content: [
        { kind: ContentKind.TEXT, text: "Let me help" },
        {
          kind: ContentKind.TOOL_CALL,
          tool_call: { id: "tc_1", name: "search", arguments: { query: "test" } },
        },
      ],
    });
    const calls = resp.tool_calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("tc_1");
    expect(calls[0].name).toBe("search");
    expect(calls[0].arguments).toEqual({ query: "test" });
    expect(calls[0].raw_arguments).toBeUndefined();
  });

  it("tool_calls getter parses string arguments", () => {
    const resp = makeResponse({
      content: [
        {
          kind: ContentKind.TOOL_CALL,
          tool_call: { id: "tc_1", name: "search", arguments: '{"query":"test"}' },
        },
      ],
    });
    const calls = resp.tool_calls;
    expect(calls[0].arguments).toEqual({ query: "test" });
    expect(calls[0].raw_arguments).toBe('{"query":"test"}');
  });

  it("tool_calls getter returns empty for no tool calls", () => {
    const resp = makeResponse();
    expect(resp.tool_calls).toHaveLength(0);
  });

  it("reasoning getter returns thinking text", () => {
    const resp = makeResponse({
      content: [
        { kind: ContentKind.THINKING, thinking: { text: "Let me think..." } },
        { kind: ContentKind.TEXT, text: "Answer" },
      ],
    });
    expect(resp.reasoning).toBe("Let me think...");
  });

  it("reasoning getter concatenates multiple thinking parts", () => {
    const resp = makeResponse({
      content: [
        { kind: ContentKind.THINKING, thinking: { text: "First " } },
        { kind: ContentKind.THINKING, thinking: { text: "second" } },
        { kind: ContentKind.TEXT, text: "Answer" },
      ],
    });
    expect(resp.reasoning).toBe("First second");
  });

  it("reasoning getter returns undefined when no thinking", () => {
    const resp = makeResponse();
    expect(resp.reasoning).toBeUndefined();
  });

  it("stores warnings", () => {
    const message = new Message({
      role: Role.ASSISTANT,
      content: [{ kind: ContentKind.TEXT, text: "hi" }],
    });
    const resp = new Response({
      id: "r1",
      model: "m",
      provider: "p",
      message,
      finish_reason: { reason: "stop" },
      usage: Usage.zero(),
      warnings: [{ message: "truncated", code: "trunc" }],
    });
    expect(resp.warnings).toHaveLength(1);
    expect(resp.warnings[0].message).toBe("truncated");
  });

  it("defaults warnings to empty array", () => {
    const resp = makeResponse();
    expect(resp.warnings).toEqual([]);
  });

  it("stores finish_reason", () => {
    const resp = makeResponse({ finish_reason: { reason: "tool_calls", raw: "tool_calls" } });
    expect(resp.finish_reason.reason).toBe("tool_calls");
  });
});

// =============================================================================
// Error Hierarchy
// =============================================================================

describe("Error Hierarchy", () => {
  describe("LLMError", () => {
    it("is an instance of Error", () => {
      const err = new LLMError("test");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(LLMError);
      expect(err.message).toBe("test");
      expect(err.name).toBe("LLMError");
    });

    it("stores cause", () => {
      const cause = new Error("root");
      const err = new LLMError("wrapper", cause);
      expect(err.cause).toBe(cause);
    });
  });

  describe("ProviderError", () => {
    it("extends LLMError", () => {
      const err = new ProviderError({
        message: "bad",
        provider: "openai",
        status_code: 500,
        retryable: true,
      });
      expect(err).toBeInstanceOf(LLMError);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.provider).toBe("openai");
      expect(err.status_code).toBe(500);
      expect(err.retryable).toBe(true);
    });
  });

  describe("AuthenticationError", () => {
    it("is not retryable", () => {
      const err = new AuthenticationError({ message: "invalid key", provider: "openai" });
      expect(err.retryable).toBe(false);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toBeInstanceOf(LLMError);
      expect(err.name).toBe("AuthenticationError");
    });
  });

  describe("AccessDeniedError", () => {
    it("is not retryable", () => {
      const err = new AccessDeniedError({ message: "forbidden", provider: "openai" });
      expect(err.retryable).toBe(false);
      expect(err.name).toBe("AccessDeniedError");
    });
  });

  describe("NotFoundError", () => {
    it("is not retryable", () => {
      const err = new NotFoundError({ message: "not found", provider: "openai" });
      expect(err.retryable).toBe(false);
      expect(err.name).toBe("NotFoundError");
    });
  });

  describe("InvalidRequestError", () => {
    it("is not retryable", () => {
      const err = new InvalidRequestError({ message: "bad request", provider: "openai" });
      expect(err.retryable).toBe(false);
      expect(err.name).toBe("InvalidRequestError");
    });
  });

  describe("RateLimitError", () => {
    it("is retryable", () => {
      const err = new RateLimitError({ message: "rate limited", provider: "openai" });
      expect(err.retryable).toBe(true);
      expect(err.name).toBe("RateLimitError");
    });
  });

  describe("ServerError", () => {
    it("is retryable", () => {
      const err = new ServerError({ message: "internal error", provider: "openai" });
      expect(err.retryable).toBe(true);
      expect(err.name).toBe("ServerError");
    });
  });

  describe("ContentFilterError", () => {
    it("is not retryable", () => {
      const err = new ContentFilterError({ message: "filtered", provider: "openai" });
      expect(err.retryable).toBe(false);
      expect(err.name).toBe("ContentFilterError");
    });
  });

  describe("ContextLengthError", () => {
    it("is not retryable", () => {
      const err = new ContextLengthError({ message: "too long", provider: "openai" });
      expect(err.retryable).toBe(false);
      expect(err.name).toBe("ContextLengthError");
    });
  });

  describe("QuotaExceededError", () => {
    it("is not retryable", () => {
      const err = new QuotaExceededError({ message: "quota exceeded", provider: "openai" });
      expect(err.retryable).toBe(false);
      expect(err.name).toBe("QuotaExceededError");
    });
  });

  describe("RequestTimeoutError", () => {
    it("is retryable (object init)", () => {
      const err = new RequestTimeoutError({ message: "timeout", provider: "openai" });
      expect(err.retryable).toBe(true);
      expect(err.name).toBe("RequestTimeoutError");
      expect(err).toBeInstanceOf(ProviderError);
    });

    it("is retryable (string init)", () => {
      const err = new RequestTimeoutError("timed out");
      expect(err.retryable).toBe(true);
      expect(err.provider).toBe("unknown");
      expect(err.message).toBe("timed out");
    });
  });

  describe("AbortError", () => {
    it("extends LLMError", () => {
      const err = new AbortError();
      expect(err).toBeInstanceOf(LLMError);
      expect(err.name).toBe("AbortError");
      expect(err.message).toBe("Request was aborted");
    });

    it("accepts custom message", () => {
      const err = new AbortError("custom abort");
      expect(err.message).toBe("custom abort");
    });
  });

  describe("NetworkError", () => {
    it("extends LLMError", () => {
      const err = new NetworkError("connection failed");
      expect(err).toBeInstanceOf(LLMError);
      expect(err.name).toBe("NetworkError");
    });
  });

  describe("StreamError", () => {
    it("extends LLMError", () => {
      const err = new StreamError("stream broken");
      expect(err).toBeInstanceOf(LLMError);
      expect(err.name).toBe("StreamError");
    });
  });

  describe("InvalidToolCallError", () => {
    it("extends LLMError", () => {
      const err = new InvalidToolCallError("bad tool call");
      expect(err).toBeInstanceOf(LLMError);
      expect(err.name).toBe("InvalidToolCallError");
    });
  });

  describe("NoObjectGeneratedError", () => {
    it("extends LLMError", () => {
      const err = new NoObjectGeneratedError("no object");
      expect(err).toBeInstanceOf(LLMError);
      expect(err.name).toBe("NoObjectGeneratedError");
    });
  });

  describe("ConfigurationError", () => {
    it("extends LLMError", () => {
      const err = new ConfigurationError("bad config");
      expect(err).toBeInstanceOf(LLMError);
      expect(err.name).toBe("ConfigurationError");
    });
  });
});

// =============================================================================
// errorFromStatusCode
// =============================================================================

describe("errorFromStatusCode()", () => {
  const base = { provider: "openai" };

  it("400 → InvalidRequestError", () => {
    const err = errorFromStatusCode(400, "bad request", base.provider);
    expect(err).toBeInstanceOf(InvalidRequestError);
    expect(err.retryable).toBe(false);
  });

  it("400 with context length message → ContextLengthError", () => {
    const err = errorFromStatusCode(400, "context length exceeded", base.provider);
    expect(err).toBeInstanceOf(ContextLengthError);
  });

  it("400 with too many tokens message → ContextLengthError", () => {
    const err = errorFromStatusCode(400, "too many tokens in request", base.provider);
    expect(err).toBeInstanceOf(ContextLengthError);
  });

  it("401 → AuthenticationError", () => {
    const err = errorFromStatusCode(401, "unauthorized", base.provider);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.retryable).toBe(false);
  });

  it("403 → AccessDeniedError", () => {
    const err = errorFromStatusCode(403, "forbidden", base.provider);
    expect(err).toBeInstanceOf(AccessDeniedError);
    expect(err.retryable).toBe(false);
  });

  it("404 → NotFoundError", () => {
    const err = errorFromStatusCode(404, "model not found", base.provider);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.retryable).toBe(false);
  });

  it("408 → RequestTimeoutError", () => {
    const err = errorFromStatusCode(408, "request timeout", base.provider);
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect(err.retryable).toBe(true);
  });

  it("413 → ContextLengthError", () => {
    const err = errorFromStatusCode(413, "payload too large", base.provider);
    expect(err).toBeInstanceOf(ContextLengthError);
    expect(err.retryable).toBe(false);
  });

  it("422 → InvalidRequestError", () => {
    const err = errorFromStatusCode(422, "unprocessable", base.provider);
    expect(err).toBeInstanceOf(InvalidRequestError);
    expect(err.retryable).toBe(false);
  });

  it("422 with context length message → ContextLengthError", () => {
    const err = errorFromStatusCode(422, "context length exceeded", base.provider);
    expect(err).toBeInstanceOf(ContextLengthError);
  });

  it("429 → RateLimitError", () => {
    const err = errorFromStatusCode(429, "rate limited", base.provider);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryable).toBe(true);
  });

  it("500 → ServerError", () => {
    const err = errorFromStatusCode(500, "internal server error", base.provider);
    expect(err).toBeInstanceOf(ServerError);
    expect(err.retryable).toBe(true);
  });

  it("502 → ServerError", () => {
    const err = errorFromStatusCode(502, "bad gateway", base.provider);
    expect(err).toBeInstanceOf(ServerError);
    expect(err.retryable).toBe(true);
  });

  it("503 → ServerError", () => {
    const err = errorFromStatusCode(503, "service unavailable", base.provider);
    expect(err).toBeInstanceOf(ServerError);
    expect(err.retryable).toBe(true);
  });

  it("preserves error_code and raw", () => {
    const err = errorFromStatusCode(500, "fail", base.provider, "ERR_INTERNAL", { detail: "x" });
    expect(err.error_code).toBe("ERR_INTERNAL");
    expect(err.raw).toEqual({ detail: "x" });
  });

  it("preserves retry_after", () => {
    const err = errorFromStatusCode(429, "rate limited", base.provider, undefined, undefined, 30);
    expect(err.retry_after).toBe(30);
  });

  describe("message-based fallback for unknown status codes", () => {
    it("not found message → NotFoundError", () => {
      const err = errorFromStatusCode(999, "resource not found", base.provider);
      expect(err).toBeInstanceOf(NotFoundError);
    });

    it("does not exist message → NotFoundError", () => {
      const err = errorFromStatusCode(999, "model does not exist", base.provider);
      expect(err).toBeInstanceOf(NotFoundError);
    });

    it("unauthorized message → AuthenticationError", () => {
      const err = errorFromStatusCode(999, "unauthorized access", base.provider);
      expect(err).toBeInstanceOf(AuthenticationError);
    });

    it("invalid key message → AuthenticationError", () => {
      const err = errorFromStatusCode(999, "invalid key provided", base.provider);
      expect(err).toBeInstanceOf(AuthenticationError);
    });

    it("context length message → ContextLengthError", () => {
      const err = errorFromStatusCode(999, "context length exceeded", base.provider);
      expect(err).toBeInstanceOf(ContextLengthError);
    });

    it("content filter message → ContentFilterError", () => {
      const err = errorFromStatusCode(999, "content filter triggered", base.provider);
      expect(err).toBeInstanceOf(ContentFilterError);
    });

    it("safety message → ContentFilterError", () => {
      const err = errorFromStatusCode(999, "safety system blocked", base.provider);
      expect(err).toBeInstanceOf(ContentFilterError);
    });

    it("unknown message → retryable ProviderError", () => {
      const err = errorFromStatusCode(999, "something unknown", base.provider);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(true);
    });
  });

  it("409 falls through to message-based classification", () => {
    const err = errorFromStatusCode(409, "conflict", base.provider);
    // 409 is not in switch cases, so it's a default retryable ProviderError
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
  });

  it("504 → ServerError", () => {
    const err = errorFromStatusCode(504, "gateway timeout", base.provider);
    expect(err).toBeInstanceOf(ServerError);
    expect(err.retryable).toBe(true);
  });
});

describe("Usage.add — optional field branches", () => {
  it("returns undefined when both optional fields are undefined", () => {
    const a = Usage.zero();
    const b = Usage.zero();
    const result = a.add(b);
    // Both reasoning_tokens are undefined → addOptional returns undefined
    expect(result.reasoning_tokens).toBeUndefined();
    expect(result.cache_read_tokens).toBeUndefined();
    expect(result.cache_write_tokens).toBeUndefined();
  });

  it("returns sum when one side has a value and other is undefined", () => {
    const a = new Usage({ input_tokens: 0, output_tokens: 0, total_tokens: 0, reasoning_tokens: 5 });
    const b = Usage.zero();
    const result = a.add(b);
    expect(result.reasoning_tokens).toBe(5);
  });
});
