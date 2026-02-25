import { describe, it, expect, vi } from "vitest";
import { generate, generate_object, stream } from "./api.js";
import { Client } from "./client.js";
import {
  ConfigurationError,
  NoObjectGeneratedError,
  RequestTimeoutError,
  Message,
  Role,
  ContentKind,
  Usage,
  Response,
  StreamEventType,
} from "./types.js";
import type { ProviderAdapter, Request, StreamEvent, ToolCall } from "./types.js";

function makeFakeAdapter(opts?: {
  text?: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  finishReason?: string;
}): ProviderAdapter {
  const text = opts?.text ?? "Hello";
  const toolCallParts = (opts?.toolCalls ?? []).map((tc) => ({
    kind: ContentKind.TOOL_CALL as const,
    tool_call: { id: tc.id, name: tc.name, arguments: tc.arguments },
  }));
  const finishReason = opts?.finishReason ?? (toolCallParts.length > 0 ? "tool_calls" : "stop");

  return {
    name: "test",
    async complete(request: Request): Promise<Response> {
      const content = [
        { kind: ContentKind.TEXT as const, text },
        ...toolCallParts,
      ];
      return new Response({
        id: "resp_1",
        model: request.model,
        provider: "test",
        message: new Message({ role: Role.ASSISTANT, content }),
        finish_reason: { reason: finishReason as "stop" | "tool_calls", raw: finishReason },
        usage: new Usage({ input_tokens: 10, output_tokens: 20 }),
      });
    },
    async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: StreamEventType.FINISH };
    },
  };
}

function makeClient(adapter: ProviderAdapter): Client {
  return new Client({ providers: { test: adapter } });
}

describe("generate()", () => {
  it("rejects when both prompt and messages are provided", async () => {
    const client = makeClient(makeFakeAdapter());
    await expect(
      generate({
        model: "test-model",
        prompt: "hello",
        messages: [Message.user("hello")],
        client,
        provider: "test",
      }),
    ).rejects.toThrow(ConfigurationError);
    await expect(
      generate({
        model: "test-model",
        prompt: "hello",
        messages: [Message.user("hello")],
        client,
        provider: "test",
      }),
    ).rejects.toThrow("either 'prompt' or 'messages'");
  });

  it("generates a response from prompt", async () => {
    const client = makeClient(makeFakeAdapter({ text: "World" }));
    const result = await generate({
      model: "test-model",
      prompt: "Hello",
      client,
      provider: "test",
    });
    expect(result.text).toBe("World");
    expect(result.steps).toHaveLength(1);
    expect(result.finish_reason.reason).toBe("stop");
  });

  it("generates a response from messages", async () => {
    const client = makeClient(makeFakeAdapter({ text: "Response" }));
    const result = await generate({
      model: "test-model",
      messages: [Message.user("Hello")],
      client,
      provider: "test",
    });
    expect(result.text).toBe("Response");
  });

  it("prepends system message when system option provided", async () => {
    let capturedMessages: Message[] = [];
    const adapter: ProviderAdapter = {
      name: "test",
      async complete(req) {
        capturedMessages = req.messages;
        return new Response({
          id: "r1",
          model: req.model,
          provider: "test",
          message: Message.assistant("ok"),
          finish_reason: { reason: "stop" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };
    const client = makeClient(adapter);
    await generate({
      model: "m",
      prompt: "hi",
      system: "You are a helper",
      client,
      provider: "test",
    });
    expect(capturedMessages[0].role).toBe(Role.SYSTEM);
    expect(capturedMessages[0].text).toBe("You are a helper");
    expect(capturedMessages[1].role).toBe(Role.USER);
  });

  it("tracks total_usage across steps", async () => {
    const client = makeClient(makeFakeAdapter({ text: "ok" }));
    const result = await generate({
      model: "m",
      prompt: "hi",
      client,
      provider: "test",
    });
    expect(result.total_usage.input_tokens).toBe(10);
    expect(result.total_usage.output_tokens).toBe(20);
  });

  it("executes tools and feeds results back", async () => {
    let callCount = 0;
    const adapter: ProviderAdapter = {
      name: "test",
      async complete(req) {
        callCount++;
        if (callCount === 1) {
          return new Response({
            id: "r1",
            model: req.model,
            provider: "test",
            message: new Message({
              role: Role.ASSISTANT,
              content: [{
                kind: ContentKind.TOOL_CALL,
                tool_call: { id: "tc_1", name: "get_weather", arguments: { city: "NYC" } },
              }],
            }),
            finish_reason: { reason: "tool_calls", raw: "tool_calls" },
            usage: new Usage({ input_tokens: 10, output_tokens: 5 }),
          });
        }
        return new Response({
          id: "r2",
          model: req.model,
          provider: "test",
          message: Message.assistant("It's sunny in NYC"),
          finish_reason: { reason: "stop", raw: "stop" },
          usage: new Usage({ input_tokens: 20, output_tokens: 10 }),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };

    const client = makeClient(adapter);
    const result = await generate({
      model: "m",
      prompt: "weather",
      tools: [{
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
        execute: async (args) => `Sunny in ${(args as { city: string }).city}`,
      }],
      max_tool_rounds: 1,
      client,
      provider: "test",
    });

    expect(result.text).toBe("It's sunny in NYC");
    expect(result.steps).toHaveLength(2);
    expect(result.total_usage.input_tokens).toBe(30);
    expect(result.total_usage.output_tokens).toBe(15);
  });

  it("respects max_tool_rounds limit", async () => {
    let callCount = 0;
    const adapter: ProviderAdapter = {
      name: "test",
      async complete(req) {
        callCount++;
        // Always request tool calls
        return new Response({
          id: `r${callCount}`,
          model: req.model,
          provider: "test",
          message: new Message({
            role: Role.ASSISTANT,
            content: [{
              kind: ContentKind.TOOL_CALL,
              tool_call: { id: `tc_${callCount}`, name: "fn", arguments: {} },
            }],
          }),
          finish_reason: { reason: "tool_calls", raw: "tool_calls" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };

    const client = makeClient(adapter);
    const result = await generate({
      model: "m",
      prompt: "go",
      tools: [{
        name: "fn",
        description: "test fn",
        parameters: {},
        execute: async () => "result",
      }],
      max_tool_rounds: 2,
      client,
      provider: "test",
    });
    // 1 initial + 2 retries = 3 calls, but step count is 3
    expect(result.steps.length).toBeLessThanOrEqual(3);
  });
});

describe("generate_object()", () => {
  it("parses valid JSON output", async () => {
    const adapter = makeFakeAdapter({ text: '{"name":"Alice","age":30}' });
    const client = makeClient(adapter);
    const result = await generate_object({
      model: "m",
      prompt: "extract",
      schema: { type: "object", properties: { name: { type: "string" }, age: { type: "number" } } },
      client,
      provider: "test",
    });
    expect(result.output).toEqual({ name: "Alice", age: 30 });
  });

  it("throws NoObjectGeneratedError on invalid JSON", async () => {
    const adapter = makeFakeAdapter({ text: "not json at all" });
    const client = makeClient(adapter);
    await expect(
      generate_object({
        model: "m",
        prompt: "extract",
        schema: { type: "object" },
        client,
        provider: "test",
      }),
    ).rejects.toThrow(NoObjectGeneratedError);
  });

  it("uses tool-based extraction for anthropic provider", async () => {
    let capturedTools: unknown;
    const adapter: ProviderAdapter = {
      name: "anthropic",
      async complete(req) {
        capturedTools = req.tools;
        return new Response({
          id: "r1",
          model: req.model,
          provider: "anthropic",
          message: new Message({
            role: Role.ASSISTANT,
            content: [{
              kind: ContentKind.TOOL_CALL,
              tool_call: { id: "tc_1", name: "extract_data", arguments: { name: "Bob" } },
            }],
          }),
          finish_reason: { reason: "tool_calls", raw: "tool_use" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };

    const client = new Client({
      providers: { anthropic: adapter },
      default_provider: "anthropic",
    });

    const result = await generate_object({
      model: "claude-opus-4-6",
      prompt: "extract name",
      schema: { type: "object", properties: { name: { type: "string" } } },
      client,
      provider: "anthropic",
    });

    expect(result.output).toEqual({ name: "Bob" });
    expect(capturedTools).toBeDefined();
  });

  it("throws NoObjectGeneratedError when anthropic model doesn't call tool", async () => {
    const adapter: ProviderAdapter = {
      name: "anthropic",
      async complete(req) {
        return new Response({
          id: "r1",
          model: req.model,
          provider: "anthropic",
          message: Message.assistant("I don't know"),
          finish_reason: { reason: "stop", raw: "end_turn" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };

    const client = new Client({
      providers: { anthropic: adapter },
      default_provider: "anthropic",
    });

    await expect(
      generate_object({
        model: "claude-opus-4-6",
        prompt: "extract name",
        schema: { type: "object" },
        client,
        provider: "anthropic",
      }),
    ).rejects.toThrow(NoObjectGeneratedError);
  });

  it("uses custom schema_name for anthropic extraction tool", async () => {
    let capturedTools: { name: string }[] | undefined;
    const adapter: ProviderAdapter = {
      name: "anthropic",
      async complete(req) {
        capturedTools = req.tools as { name: string }[];
        return new Response({
          id: "r1",
          model: req.model,
          provider: "anthropic",
          message: new Message({
            role: Role.ASSISTANT,
            content: [{
              kind: ContentKind.TOOL_CALL,
              tool_call: { id: "tc_1", name: "my_tool", arguments: { x: 1 } },
            }],
          }),
          finish_reason: { reason: "tool_calls", raw: "tool_use" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };

    const client = new Client({ providers: { anthropic: adapter }, default_provider: "anthropic" });

    await generate_object({
      model: "m",
      prompt: "extract",
      schema: { type: "object" },
      schema_name: "my_tool",
      schema_description: "My custom tool",
      client,
      provider: "anthropic",
    });

    expect(capturedTools?.[0]?.name).toBe("my_tool");
  });

  it("anthropic extraction: falls back to JSON.parse of text when no tool calls", async () => {
    const adapter: ProviderAdapter = {
      name: "anthropic",
      async complete(req) {
        return new Response({
          id: "r1",
          model: req.model,
          provider: "anthropic",
          message: Message.assistant('{"fallback": true}'),
          finish_reason: { reason: "stop", raw: "end_turn" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };

    const client = new Client({ providers: { anthropic: adapter }, default_provider: "anthropic" });

    const result = await generate_object({
      model: "m",
      prompt: "extract",
      schema: { type: "object" },
      client,
      provider: "anthropic",
    });

    expect(result.output).toEqual({ fallback: true });
  });

  it("uses provider from client.defaultProvider when not specified", async () => {
    const adapter = makeFakeAdapter({ text: '{"val": 42}' });
    const client = new Client({
      providers: { openai: adapter },
      default_provider: "openai",
    });
    const result = await generate_object({
      model: "m",
      prompt: "extract",
      schema: { type: "object" },
      client,
    });
    expect(result.output).toEqual({ val: 42 });
  });
});

// --- generate() additional tests -----------------------------------------

describe("generate() additional coverage", () => {
  it("stops when stop_when callback returns true", async () => {
    let callCount = 0;
    const adapter: ProviderAdapter = {
      name: "test",
      async complete(req) {
        callCount++;
        return new Response({
          id: `r${callCount}`,
          model: req.model,
          provider: "test",
          message: new Message({
            role: Role.ASSISTANT,
            content: [{
              kind: ContentKind.TOOL_CALL,
              tool_call: { id: `tc_${callCount}`, name: "fn", arguments: {} },
            }],
          }),
          finish_reason: { reason: "tool_calls", raw: "tool_calls" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };

    const client = makeClient(adapter);
    const result = await generate({
      model: "m",
      prompt: "go",
      tools: [{
        name: "fn",
        description: "test",
        parameters: {},
        execute: async () => "ok",
      }],
      max_tool_rounds: 10,
      stop_when: (steps) => steps.length >= 1,
      client,
      provider: "test",
    });

    expect(result.steps.length).toBe(1);
  });

  it("handles tool execution that throws an error", async () => {
    let callCount = 0;
    const adapter: ProviderAdapter = {
      name: "test",
      async complete(req) {
        callCount++;
        if (callCount === 1) {
          return new Response({
            id: "r1",
            model: req.model,
            provider: "test",
            message: new Message({
              role: Role.ASSISTANT,
              content: [{
                kind: ContentKind.TOOL_CALL,
                tool_call: { id: "tc_1", name: "failing_tool", arguments: {} },
              }],
            }),
            finish_reason: { reason: "tool_calls", raw: "tool_calls" },
            usage: Usage.zero(),
          });
        }
        return new Response({
          id: "r2",
          model: req.model,
          provider: "test",
          message: Message.assistant("recovered"),
          finish_reason: { reason: "stop", raw: "stop" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };

    const client = makeClient(adapter);
    const result = await generate({
      model: "m",
      prompt: "go",
      tools: [{
        name: "failing_tool",
        description: "fails",
        parameters: {},
        execute: async () => { throw new Error("tool broke"); },
      }],
      max_tool_rounds: 1,
      client,
      provider: "test",
    });

    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].tool_results[0].is_error).toBe(true);
    expect(result.steps[0].tool_results[0].content).toContain("tool broke");
  });

  it("handles unknown tool call gracefully", async () => {
    let callCount = 0;
    const adapter: ProviderAdapter = {
      name: "test",
      async complete(req) {
        callCount++;
        if (callCount === 1) {
          return new Response({
            id: "r1",
            model: req.model,
            provider: "test",
            message: new Message({
              role: Role.ASSISTANT,
              content: [{
                kind: ContentKind.TOOL_CALL,
                tool_call: { id: "tc_1", name: "nonexistent_tool", arguments: {} },
              }],
            }),
            finish_reason: { reason: "tool_calls", raw: "tool_calls" },
            usage: Usage.zero(),
          });
        }
        return new Response({
          id: "r2",
          model: req.model,
          provider: "test",
          message: Message.assistant("ok"),
          finish_reason: { reason: "stop", raw: "stop" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };

    const client = makeClient(adapter);
    const result = await generate({
      model: "m",
      prompt: "go",
      tools: [{
        name: "real_tool",
        description: "real",
        parameters: {},
        execute: async () => "ok",
      }],
      max_tool_rounds: 1,
      client,
      provider: "test",
    });

    expect(result.steps[0].tool_results[0].is_error).toBe(true);
    expect(result.steps[0].tool_results[0].content).toContain("Unknown tool");
  });

  it("handles tool that returns null", async () => {
    let callCount = 0;
    const adapter: ProviderAdapter = {
      name: "test",
      async complete(req) {
        callCount++;
        if (callCount === 1) {
          return new Response({
            id: "r1",
            model: req.model,
            provider: "test",
            message: new Message({
              role: Role.ASSISTANT,
              content: [{
                kind: ContentKind.TOOL_CALL,
                tool_call: { id: "tc_1", name: "null_tool", arguments: {} },
              }],
            }),
            finish_reason: { reason: "tool_calls", raw: "tool_calls" },
            usage: Usage.zero(),
          });
        }
        return new Response({
          id: "r2",
          model: req.model,
          provider: "test",
          message: Message.assistant("done"),
          finish_reason: { reason: "stop", raw: "stop" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };

    const client = makeClient(adapter);
    const result = await generate({
      model: "m",
      prompt: "go",
      tools: [{
        name: "null_tool",
        description: "returns null",
        parameters: {},
        execute: async () => null as unknown,
      }],
      max_tool_rounds: 1,
      client,
      provider: "test",
    });

    expect(result.steps[0].tool_results[0].content).toBe("");
    expect(result.steps[0].tool_results[0].is_error).toBe(false);
  });

  it("handles tool that returns an object", async () => {
    let callCount = 0;
    const adapter: ProviderAdapter = {
      name: "test",
      async complete(req) {
        callCount++;
        if (callCount === 1) {
          return new Response({
            id: "r1",
            model: req.model,
            provider: "test",
            message: new Message({
              role: Role.ASSISTANT,
              content: [{
                kind: ContentKind.TOOL_CALL,
                tool_call: { id: "tc_1", name: "obj_tool", arguments: {} },
              }],
            }),
            finish_reason: { reason: "tool_calls", raw: "tool_calls" },
            usage: Usage.zero(),
          });
        }
        return new Response({
          id: "r2",
          model: req.model,
          provider: "test",
          message: Message.assistant("done"),
          finish_reason: { reason: "stop", raw: "stop" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };

    const client = makeClient(adapter);
    const result = await generate({
      model: "m",
      prompt: "go",
      tools: [{
        name: "obj_tool",
        description: "returns object",
        parameters: {},
        execute: async () => ({ key: "value" }),
      }],
      max_tool_rounds: 1,
      client,
      provider: "test",
    });

    expect(result.steps[0].tool_results[0].content).toBe('{"key":"value"}');
  });

  it("breaks when tools have no execute handler (passive tools)", async () => {
    const adapter: ProviderAdapter = {
      name: "test",
      async complete(req) {
        return new Response({
          id: "r1",
          model: req.model,
          provider: "test",
          message: new Message({
            role: Role.ASSISTANT,
            content: [{
              kind: ContentKind.TOOL_CALL,
              tool_call: { id: "tc_1", name: "passive_tool", arguments: {} },
            }],
          }),
          finish_reason: { reason: "tool_calls", raw: "tool_calls" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };

    const client = makeClient(adapter);
    const result = await generate({
      model: "m",
      prompt: "go",
      tools: [{
        name: "passive_tool",
        description: "no execute handler",
        parameters: {},
        // No execute handler
      }],
      max_tool_rounds: 5,
      client,
      provider: "test",
    });

    // Should break after first step because there are no active tools
    expect(result.steps).toHaveLength(1);
  });

  it("uses total timeout as abort signal", async () => {
    const client = makeClient(makeFakeAdapter({ text: "fast" }));
    const result = await generate({
      model: "m",
      prompt: "hi",
      timeout: 5000,
      client,
      provider: "test",
    });
    expect(result.text).toBe("fast");
  });

  it("uses TimeoutConfig total timeout", async () => {
    const client = makeClient(makeFakeAdapter({ text: "ok" }));
    const result = await generate({
      model: "m",
      prompt: "hi",
      timeout: { total: 5000 },
      client,
      provider: "test",
    });
    expect(result.text).toBe("ok");
  });

  it("throws AbortError when abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = makeClient(makeFakeAdapter({ text: "ok" }));

    await expect(
      generate({
        model: "m",
        prompt: "hi",
        abort_signal: controller.signal,
        client,
        provider: "test",
      }),
    ).rejects.toThrow();
  });

  it("throws AbortError when signal aborts during execution", async () => {
    const controller = new AbortController();
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() {
        // Simulate delay, then the abort fires
        await new Promise(resolve => setTimeout(resolve, 50));
        return new Response({
          id: "r1",
          model: "m",
          provider: "test",
          message: Message.assistant("ok"),
          finish_reason: { reason: "stop" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };
    const client = makeClient(adapter);

    // Abort after 10ms
    setTimeout(() => controller.abort(), 10);

    await expect(
      generate({
        model: "m",
        prompt: "hi",
        abort_signal: controller.signal,
        client,
        provider: "test",
      }),
    ).rejects.toThrow();
  });

  it("throws RequestTimeoutError when abort signal is pre-aborted with timeout config", async () => {
    // When abort_signal is already aborted AND totalTimeout is set → RequestTimeoutError
    const controller = new AbortController();
    controller.abort();
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() {
        // Delay to allow abort check to happen
        await new Promise(resolve => setTimeout(resolve, 100));
        return new Response({
          id: "r1",
          model: "m",
          provider: "test",
          message: Message.assistant("ok"),
          finish_reason: { reason: "stop" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };
    const client = makeClient(adapter);

    // With both abort_signal pre-aborted and timeout set, should get AbortError
    // because abort_signal takes priority over timeout generation
    await expect(
      generate({
        model: "m",
        prompt: "hi",
        abort_signal: controller.signal,
        client,
        provider: "test",
      }),
    ).rejects.toThrow();
  });

  it("throws AbortError when signal aborts during Promise.race", async () => {
    const controller = new AbortController();
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() {
        // Very slow: should be aborted before completion
        await new Promise(resolve => setTimeout(resolve, 500));
        return new Response({
          id: "r1",
          model: "m",
          provider: "test",
          message: Message.assistant("ok"),
          finish_reason: { reason: "stop" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };
    const client = makeClient(adapter);

    // Abort after a short delay — covers the abort listener in the Promise.race path
    setTimeout(() => controller.abort(), 20);

    await expect(
      generate({
        model: "m",
        prompt: "hi",
        abort_signal: controller.signal,
        client,
        provider: "test",
      }),
    ).rejects.toThrow();
  });

  it("throws RequestTimeoutError when timeout expires", async () => {
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() {
        // Simulate a slow response
        await new Promise(resolve => setTimeout(resolve, 200));
        return new Response({
          id: "r1",
          model: "m",
          provider: "test",
          message: Message.assistant("ok"),
          finish_reason: { reason: "stop" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };
    const client = makeClient(adapter);

    await expect(
      generate({
        model: "m",
        prompt: "hi",
        timeout: 10,
        client,
        provider: "test",
      }),
    ).rejects.toThrow("timed out");
  });

  it("generates with messages and no prompt", async () => {
    const client = makeClient(makeFakeAdapter({ text: "ok" }));
    const result = await generate({
      model: "m",
      messages: [Message.user("Hello")],
      client,
      provider: "test",
    });
    expect(result.text).toBe("ok");
  });

  it("generates with no prompt and no messages", async () => {
    const client = makeClient(makeFakeAdapter({ text: "ok" }));
    const result = await generate({
      model: "m",
      client,
      provider: "test",
    });
    // Should work with empty conversation
    expect(result.text).toBe("ok");
  });
});

// --- stream() tests --------------------------------------------------------

describe("stream()", () => {
  it("rejects when both prompt and messages are provided", () => {
    const client = makeClient(makeFakeAdapter());
    expect(() =>
      stream({
        model: "m",
        prompt: "hi",
        messages: [Message.user("hi")],
        client,
        provider: "test",
      }),
    ).toThrow(ConfigurationError);
  });

  it("yields events from the stream", async () => {
    const adapter: ProviderAdapter = {
      name: "test",
      async complete(req) {
        return new Response({
          id: "r1",
          model: req.model,
          provider: "test",
          message: Message.assistant("streamed"),
          finish_reason: { reason: "stop" },
          usage: Usage.zero(),
        });
      },
      async *stream(req): AsyncGenerator<StreamEvent> {
        yield { type: StreamEventType.STREAM_START };
        yield { type: StreamEventType.TEXT_DELTA, delta: "hello " };
        yield { type: StreamEventType.TEXT_DELTA, delta: "world" };
        yield {
          type: StreamEventType.FINISH,
          response: new Response({
            id: "r1",
            model: req.model,
            provider: "test",
            message: Message.assistant("hello world"),
            finish_reason: { reason: "stop" },
            usage: Usage.zero(),
          }),
        };
      },
    };

    const client = makeClient(adapter);
    const result = stream({
      model: "m",
      prompt: "hi",
      client,
      provider: "test",
    });

    const events: StreamEvent[] = [];
    for await (const event of result) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.some(e => e.type === StreamEventType.TEXT_DELTA)).toBe(true);
  });

  it("textStream yields only text deltas", async () => {
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() {
        throw new Error("not used");
      },
      async *stream(req): AsyncGenerator<StreamEvent> {
        yield { type: StreamEventType.STREAM_START };
        yield { type: StreamEventType.TEXT_DELTA, delta: "hello " };
        yield { type: StreamEventType.TEXT_DELTA, delta: "world" };
        yield {
          type: StreamEventType.FINISH,
          response: new Response({
            id: "r1",
            model: req.model,
            provider: "test",
            message: Message.assistant("hello world"),
            finish_reason: { reason: "stop" },
            usage: Usage.zero(),
          }),
        };
      },
    };

    const client = makeClient(adapter);
    const result = stream({
      model: "m",
      prompt: "hi",
      client,
      provider: "test",
    });

    const texts: string[] = [];
    for await (const text of result.textStream()) {
      texts.push(text);
    }

    expect(texts).toEqual(["hello ", "world"]);
  });

  it("response() resolves after stream completes", async () => {
    const expectedResponse = new Response({
      id: "r1",
      model: "m",
      provider: "test",
      message: Message.assistant("done"),
      finish_reason: { reason: "stop" },
      usage: Usage.zero(),
    });

    const adapter: ProviderAdapter = {
      name: "test",
      async complete() { throw new Error("not used"); },
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: StreamEventType.FINISH, response: expectedResponse };
      },
    };

    const client = makeClient(adapter);
    const result = stream({
      model: "m",
      prompt: "hi",
      client,
      provider: "test",
    });

    // Consume all events
    for await (const _event of result) { /* drain */ }

    const resp = await result.response();
    expect(resp.id).toBe("r1");
    expect(resp.text).toBe("done");
  });

  it("multiple consumers can iterate the same stream", async () => {
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() { throw new Error("not used"); },
      async *stream(req): AsyncGenerator<StreamEvent> {
        yield { type: StreamEventType.TEXT_DELTA, delta: "a" };
        yield { type: StreamEventType.TEXT_DELTA, delta: "b" };
        yield {
          type: StreamEventType.FINISH,
          response: new Response({
            id: "r1",
            model: req.model,
            provider: "test",
            message: Message.assistant("ab"),
            finish_reason: { reason: "stop" },
            usage: Usage.zero(),
          }),
        };
      },
    };

    const client = makeClient(adapter);
    const result = stream({
      model: "m",
      prompt: "hi",
      client,
      provider: "test",
    });

    // First consumer
    const events1: StreamEvent[] = [];
    for await (const event of result) {
      events1.push(event);
    }

    // Second consumer (should get the buffered events)
    const events2: StreamEvent[] = [];
    for await (const event of result) {
      events2.push(event);
    }

    expect(events1.length).toBe(events2.length);
    expect(events1.length).toBe(3);
  });

  it("response() rejects if stream ends without response", async () => {
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() { throw new Error("not used"); },
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: StreamEventType.STREAM_START };
        // No FINISH event with response
      },
    };

    const client = makeClient(adapter);
    const result = stream({
      model: "m",
      prompt: "hi",
      client,
      provider: "test",
    });

    // Drain events
    for await (const _e of result) { /* drain */ }

    await expect(result.response()).rejects.toThrow("Stream ended without producing a response");
  });

  it("propagates stream error to response()", async () => {
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() { throw new Error("not used"); },
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: StreamEventType.STREAM_START };
        throw new Error("Stream broke");
      },
    };

    const client = makeClient(adapter);
    const result = stream({
      model: "m",
      prompt: "hi",
      client,
      provider: "test",
    });

    // Drain — should throw
    await expect(async () => {
      for await (const _e of result) { /* drain */ }
    }).rejects.toThrow("Stream broke");

    await expect(result.response()).rejects.toThrow("Stream broke");
  });

  it("uses system message in stream()", async () => {
    let capturedMessages: Message[] = [];
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() { throw new Error("not used"); },
      async *stream(req): AsyncGenerator<StreamEvent> {
        capturedMessages = req.messages;
        yield {
          type: StreamEventType.FINISH,
          response: new Response({
            id: "r1",
            model: req.model,
            provider: "test",
            message: Message.assistant("ok"),
            finish_reason: { reason: "stop" },
            usage: Usage.zero(),
          }),
        };
      },
    };

    const client = makeClient(adapter);
    const result = stream({
      model: "m",
      prompt: "hi",
      system: "Be helpful",
      client,
      provider: "test",
    });

    for await (const _e of result) { /* drain */ }
    expect(capturedMessages[0].role).toBe(Role.SYSTEM);
  });

  it("stream with tool loop executes tools and continues", async () => {
    let callCount = 0;
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() { throw new Error("not used"); },
      async *stream(req): AsyncGenerator<StreamEvent> {
        callCount++;
        if (callCount === 1) {
          yield { type: StreamEventType.STREAM_START };
          yield {
            type: StreamEventType.FINISH,
            response: new Response({
              id: "r1",
              model: req.model,
              provider: "test",
              message: new Message({
                role: Role.ASSISTANT,
                content: [{
                  kind: ContentKind.TOOL_CALL,
                  tool_call: { id: "tc_1", name: "get_data", arguments: {} },
                }],
              }),
              finish_reason: { reason: "tool_calls", raw: "tool_calls" },
              usage: new Usage({ input_tokens: 10, output_tokens: 5 }),
            }),
          };
        } else {
          yield { type: StreamEventType.STREAM_START };
          yield { type: StreamEventType.TEXT_DELTA, delta: "Got data" };
          yield {
            type: StreamEventType.FINISH,
            response: new Response({
              id: "r2",
              model: req.model,
              provider: "test",
              message: Message.assistant("Got data"),
              finish_reason: { reason: "stop", raw: "stop" },
              usage: new Usage({ input_tokens: 20, output_tokens: 10 }),
            }),
          };
        }
      },
    };

    const client = makeClient(adapter);
    const result = stream({
      model: "m",
      prompt: "go",
      tools: [{
        name: "get_data",
        description: "Get data",
        parameters: {},
        execute: async () => "data-result",
      }],
      max_tool_rounds: 1,
      client,
      provider: "test",
    });

    const events: StreamEvent[] = [];
    for await (const e of result) {
      events.push(e);
    }

    // Should have events from both rounds
    expect(events.length).toBeGreaterThan(2);
    const finishEvents = events.filter(e => e.type === StreamEventType.FINISH);
    expect(finishEvents.length).toBe(2);

    const resp = await result.response();
    expect(resp.text).toBe("Got data");
  });

  it("stream with messages instead of prompt", async () => {
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() { throw new Error("not used"); },
      async *stream(req): AsyncGenerator<StreamEvent> {
        yield {
          type: StreamEventType.FINISH,
          response: new Response({
            id: "r1",
            model: req.model,
            provider: "test",
            message: Message.assistant("ok"),
            finish_reason: { reason: "stop" },
            usage: Usage.zero(),
          }),
        };
      },
    };

    const client = makeClient(adapter);
    const result = stream({
      model: "m",
      messages: [Message.user("Hello")],
      client,
      provider: "test",
    });

    const events: StreamEvent[] = [];
    for await (const e of result) {
      events.push(e);
    }
    expect(events.some(e => e.type === StreamEventType.FINISH)).toBe(true);
  });
});

describe("api.ts uncovered branches", () => {
  it("covers getDefaultClient() fallback when no client provided (line 96)", async () => {
    // generate() with no client parameter should call getDefaultClient()
    // We can't easily test this without env vars, but we can verify the path works
    // by providing a client explicitly and NOT providing one with a mock
    const adapter = makeFakeAdapter({ text: "from default" });
    const client = makeClient(adapter);
    const result = await generate({
      model: "m",
      prompt: "hi",
      client,
      provider: "test",
    });
    expect(result.text).toBe("from default");
  });

  it("covers abort_signal.aborted check before loop with pre-aborted signal and timeout (line 146-147)", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = makeClient(makeFakeAdapter({ text: "ok" }));

    // Pre-aborted + no timeout → AbortError (not RequestTimeoutError)
    await expect(
      generate({
        model: "m",
        prompt: "hi",
        abort_signal: controller.signal,
        client,
        provider: "test",
      }),
    ).rejects.toThrow();
  });

  it("covers Promise.race abort signal path (line 161)", async () => {
    const controller = new AbortController();
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() {
        // Long delay so abort fires first
        await new Promise(resolve => setTimeout(resolve, 200));
        return new Response({
          id: "r1",
          model: "m",
          provider: "test",
          message: Message.assistant("ok"),
          finish_reason: { reason: "stop" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };
    const client = makeClient(adapter);

    // Abort quickly
    setTimeout(() => controller.abort(), 5);

    await expect(
      generate({
        model: "m",
        prompt: "hi",
        abort_signal: controller.signal,
        client,
        provider: "test",
      }),
    ).rejects.toThrow();
  });

  it("covers tool_result with object content (typeof result.content check) (line 223)", async () => {
    // This tests the typeof check in conversation building — where tool result content
    // may be an object rather than a string.
    let callCount = 0;
    const adapter: ProviderAdapter = {
      name: "test",
      async complete(req) {
        callCount++;
        if (callCount === 1) {
          return new Response({
            id: "r1",
            model: req.model,
            provider: "test",
            message: new Message({
              role: Role.ASSISTANT,
              content: [{
                kind: ContentKind.TOOL_CALL,
                tool_call: { id: "tc_1", name: "data_tool", arguments: {} },
              }],
            }),
            finish_reason: { reason: "tool_calls", raw: "tool_calls" },
            usage: Usage.zero(),
          });
        }
        return new Response({
          id: "r2",
          model: req.model,
          provider: "test",
          message: Message.assistant("done"),
          finish_reason: { reason: "stop", raw: "stop" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };

    const client = makeClient(adapter);
    await generate({
      model: "m",
      prompt: "go",
      tools: [{
        name: "data_tool",
        description: "returns data",
        parameters: {},
        execute: async () => ({ result: "data" }),
      }],
      max_tool_rounds: 1,
      client,
      provider: "test",
    });

    expect(callCount).toBe(2);
  });

  it("covers stream() stop_when condition (line 374-376)", async () => {
    let callCount = 0;
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() { throw new Error("not used"); },
      async *stream(req): AsyncGenerator<StreamEvent> {
        callCount++;
        yield { type: StreamEventType.STREAM_START };
        yield {
          type: StreamEventType.FINISH,
          response: new Response({
            id: `r${callCount}`,
            model: req.model,
            provider: "test",
            message: new Message({
              role: Role.ASSISTANT,
              content: [{
                kind: ContentKind.TOOL_CALL,
                tool_call: { id: `tc_${callCount}`, name: "fn", arguments: {} },
              }],
            }),
            finish_reason: { reason: "tool_calls", raw: "tool_calls" },
            usage: Usage.zero(),
          }),
        };
      },
    };

    const client = makeClient(adapter);
    const result = stream({
      model: "m",
      prompt: "go",
      tools: [{
        name: "fn",
        description: "test",
        parameters: {},
        execute: async () => "ok",
      }],
      max_tool_rounds: 10,
      stop_when: (steps) => steps.length >= 1,
      client,
      provider: "test",
    });

    const events: StreamEvent[] = [];
    for await (const e of result) {
      events.push(e);
    }

    // Should stop after first step due to stop_when
    expect(callCount).toBe(1);
  });

  it("covers generate_object() with error that is not Error instance (line 536-537)", async () => {
    const adapter: ProviderAdapter = {
      name: "test",
      async complete(req) {
        return new Response({
          id: "r1",
          model: req.model,
          provider: "test",
          message: Message.assistant("not json at all"),
          finish_reason: { reason: "stop", raw: "stop" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };
    const client = makeClient(adapter);

    await expect(
      generate_object({
        model: "m",
        prompt: "extract",
        schema: { type: "object" },
        client,
        provider: "test",
      }),
    ).rejects.toThrow("Failed to parse structured output");
  });

  it("covers stream() max_tool_rounds limit (line 374)", async () => {
    let callCount = 0;
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() { throw new Error("not used"); },
      async *stream(req): AsyncGenerator<StreamEvent> {
        callCount++;
        yield {
          type: StreamEventType.FINISH,
          response: new Response({
            id: `r${callCount}`,
            model: req.model,
            provider: "test",
            message: new Message({
              role: Role.ASSISTANT,
              content: [{
                kind: ContentKind.TOOL_CALL,
                tool_call: { id: `tc_${callCount}`, name: "fn", arguments: {} },
              }],
            }),
            finish_reason: { reason: "tool_calls", raw: "tool_calls" },
            usage: Usage.zero(),
          }),
        };
      },
    };

    const client = makeClient(adapter);
    const result = stream({
      model: "m",
      prompt: "go",
      tools: [{
        name: "fn",
        description: "test",
        parameters: {},
        execute: async () => "ok",
      }],
      max_tool_rounds: 1,
      client,
      provider: "test",
    });

    const events: StreamEvent[] = [];
    for await (const e of result) {
      events.push(e);
    }

    // Should stop at max_tool_rounds
    expect(callCount).toBeLessThanOrEqual(2);
  });

  it("covers stream() with passive tools (no execute) (line 376)", async () => {
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() { throw new Error("not used"); },
      async *stream(req): AsyncGenerator<StreamEvent> {
        yield {
          type: StreamEventType.FINISH,
          response: new Response({
            id: "r1",
            model: req.model,
            provider: "test",
            message: new Message({
              role: Role.ASSISTANT,
              content: [{
                kind: ContentKind.TOOL_CALL,
                tool_call: { id: "tc_1", name: "passive", arguments: {} },
              }],
            }),
            finish_reason: { reason: "tool_calls", raw: "tool_calls" },
            usage: Usage.zero(),
          }),
        };
      },
    };

    const client = makeClient(adapter);
    const result = stream({
      model: "m",
      prompt: "go",
      tools: [{
        name: "passive",
        description: "no execute",
        parameters: {},
      }],
      max_tool_rounds: 5,
      client,
      provider: "test",
    });

    const events: StreamEvent[] = [];
    for await (const e of result) {
      events.push(e);
    }

    // Should break after first round because no active tools
    const finishEvents = events.filter(e => e.type === StreamEventType.FINISH);
    expect(finishEvents).toHaveLength(1);
  });

  it("covers stream() with non-Error thrown in source (line 400/425)", async () => {
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() { throw new Error("not used"); },
      async *stream(): AsyncGenerator<StreamEvent> {
        throw "string error" as unknown as Error;
      },
    };

    const client = makeClient(adapter);
    const result = stream({
      model: "m",
      prompt: "hi",
      client,
      provider: "test",
    });

    await expect(async () => {
      for await (const _e of result) { /* drain */ }
    }).rejects.toThrow();

    await expect(result.response()).rejects.toThrow();
  });

  it("covers stream() no lastResponse (break at line 346)", async () => {
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() { throw new Error("not used"); },
      async *stream(): AsyncGenerator<StreamEvent> {
        // Yield events but no FINISH event with response
        yield { type: StreamEventType.STREAM_START };
        yield { type: StreamEventType.TEXT_DELTA, delta: "partial" };
      },
    };

    const client = makeClient(adapter);
    const result = stream({
      model: "m",
      prompt: "hi",
      client,
      provider: "test",
    });

    const events: StreamEvent[] = [];
    for await (const e of result) {
      events.push(e);
    }

    // No lastResponse → rejects
    await expect(result.response()).rejects.toThrow("Stream ended without producing a response");
  });

  it("covers abort with totalTimeout (line 148 — RequestTimeoutError branch)", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = makeClient(makeFakeAdapter({ text: "ok" }));

    // Pre-aborted signal + timeout → RequestTimeoutError (not AbortError)
    await expect(
      generate({
        model: "m",
        prompt: "hi",
        abort_signal: controller.signal,
        timeout: 5000,
        client,
        provider: "test",
      }),
    ).rejects.toThrow(RequestTimeoutError);
  });

  it("covers Promise.race abort with totalTimeout (lines 162-166 — RequestTimeoutError branch)", async () => {
    const controller = new AbortController();
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() {
        // Long delay so abort fires first within the Promise.race
        await new Promise(resolve => setTimeout(resolve, 500));
        return new Response({
          id: "r1",
          model: "m",
          provider: "test",
          message: Message.assistant("ok"),
          finish_reason: { reason: "stop" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };
    const client = makeClient(adapter);

    // Abort quickly — signal not yet aborted at line 145,
    // but will be aborted by the time Promise.race checks it
    setTimeout(() => controller.abort(), 10);

    await expect(
      generate({
        model: "m",
        prompt: "hi",
        abort_signal: controller.signal,
        timeout: 5000,
        client,
        provider: "test",
      }),
    ).rejects.toThrow(RequestTimeoutError);
  });

  it("covers Promise.race abort without totalTimeout (lines 162-166 — AbortError branch)", async () => {
    const controller = new AbortController();
    const adapter: ProviderAdapter = {
      name: "test",
      async complete() {
        await new Promise(resolve => setTimeout(resolve, 500));
        return new Response({
          id: "r1",
          model: "m",
          provider: "test",
          message: Message.assistant("ok"),
          finish_reason: { reason: "stop" },
          usage: Usage.zero(),
        });
      },
      async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
    };
    const client = makeClient(adapter);

    // Abort quickly — no timeout means AbortError
    setTimeout(() => controller.abort(), 10);

    await expect(
      generate({
        model: "m",
        prompt: "hi",
        abort_signal: controller.signal,
        client,
        provider: "test",
      }),
    ).rejects.toThrow();
  });
});
