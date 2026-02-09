import { describe, it, expect, vi } from "vitest";
import { generate, generate_object } from "./api.js";
import { Client } from "./client.js";
import {
  ConfigurationError,
  NoObjectGeneratedError,
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
});
