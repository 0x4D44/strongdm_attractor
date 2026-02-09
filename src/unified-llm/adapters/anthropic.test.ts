import { describe, it, expect, vi, beforeEach } from "vitest";
import { AnthropicAdapter } from "./anthropic.js";
import { Message, Role, ContentKind, StreamEventType } from "../types.js";
import type { Request, ToolDefinition, StreamEvent } from "../types.js";

// Mock the http module
vi.mock("../utils/http.js", () => ({
  httpRequest: vi.fn(),
  httpStreamRequest: vi.fn(),
  raiseForStatus: vi.fn(),
  parseRateLimitHeaders: vi.fn().mockReturnValue(undefined),
}));

import { httpRequest, httpStreamRequest } from "../utils/http.js";

const mockedHttpRequest = vi.mocked(httpRequest);
const mockedHttpStreamRequest = vi.mocked(httpStreamRequest);

function makeRequest(overrides?: Partial<Request>): Request {
  return {
    model: "claude-opus-4-6",
    messages: [Message.user("Hello")],
    ...overrides,
  };
}

function makeSSEStream(...lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = lines.join("");
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        controller.enqueue(encoder.encode(text));
        sent = true;
      } else {
        controller.close();
      }
    },
  });
}

describe("AnthropicAdapter", () => {
  let adapter: AnthropicAdapter;

  beforeEach(() => {
    adapter = new AnthropicAdapter({ api_key: "sk-ant-test" });
    vi.clearAllMocks();
  });

  describe("construction", () => {
    it("has correct name", () => {
      expect(adapter.name).toBe("anthropic");
    });
  });

  describe("request translation", () => {
    it("extracts system messages into body.system", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "msg_1",
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "Hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        text: "",
      });

      await adapter.complete(makeRequest({
        messages: [
          Message.system("You are helpful"),
          Message.user("Hello"),
        ],
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const system = body.system as Record<string, unknown>[];
      expect(system).toHaveLength(1);
      expect(system[0].type).toBe("text");
      expect(system[0].text).toBe("You are helpful");
      // Auto cache_control on last system block
      expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    });

    it("translates user text messages", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "msg_1",
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "Hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        text: "",
      });

      await adapter.complete(makeRequest());

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      expect(messages[0].role).toBe("user");
      const content = messages[0].content as Record<string, unknown>[];
      expect(content[0]).toMatchObject({ type: "text", text: "Hello" });
    });

    it("sets max_tokens (required for Anthropic)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "msg_1",
          model: "claude-opus-4-6",
          content: [],
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        text: "",
      });

      await adapter.complete(makeRequest());

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.max_tokens).toBe(4096); // default
    });

    it("uses explicit max_tokens", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "msg_1",
          model: "claude-opus-4-6",
          content: [],
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        text: "",
      });

      await adapter.complete(makeRequest({ max_tokens: 8192 }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.max_tokens).toBe(8192);
    });

    it("translates tool definitions with input_schema", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "msg_1",
          model: "claude-opus-4-6",
          content: [],
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        text: "",
      });

      const tools: ToolDefinition[] = [{
        name: "search",
        description: "Search",
        parameters: { type: "object" },
      }];

      await adapter.complete(makeRequest({ tools }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const bodyTools = body.tools as Record<string, unknown>[];
      expect(bodyTools[0]).toMatchObject({
        name: "search",
        description: "Search",
        input_schema: { type: "object" },
      });
    });

    it("translates tool_choice 'auto' → {type: 'auto'}", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({
        tools: [{ name: "t", description: "d", parameters: {} }],
        tool_choice: { mode: "auto" },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.tool_choice).toEqual({ type: "auto" });
    });

    it("translates tool_choice 'required' → {type: 'any'}", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({
        tools: [{ name: "t", description: "d", parameters: {} }],
        tool_choice: { mode: "required" },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.tool_choice).toEqual({ type: "any" });
    });

    it("translates tool_choice 'named' → {type: 'tool', name: ...}", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({
        tools: [{ name: "search", description: "d", parameters: {} }],
        tool_choice: { mode: "named", tool_name: "search" },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.tool_choice).toEqual({ type: "tool", name: "search" });
    });

    it("omits tools when tool_choice is 'none'", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({
        tools: [{ name: "t", description: "d", parameters: {} }],
        tool_choice: { mode: "none" },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
    });

    it("translates image content with URL", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      const msg = new Message({
        role: Role.USER,
        content: [{
          kind: ContentKind.IMAGE,
          image: { url: "https://example.com/img.png" },
        }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      const content = messages[0].content as Record<string, unknown>[];
      expect(content[0]).toMatchObject({
        type: "image",
        source: { type: "url", url: "https://example.com/img.png" },
      });
      // Auto-cache adds cache_control to last content block of last user message
      expect(content[0].cache_control).toEqual({ type: "ephemeral" });
    });

    it("translates image content with base64", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      const msg = new Message({
        role: Role.USER,
        content: [{
          kind: ContentKind.IMAGE,
          image: { data: "base64data", media_type: "image/jpeg" },
        }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      const content = messages[0].content as Record<string, unknown>[];
      expect(content[0]).toMatchObject({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "base64data" },
      });
      // Auto-cache adds cache_control to last content block of last user message
      expect(content[0].cache_control).toEqual({ type: "ephemeral" });
    });

    it("translates tool result messages", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      const msgs = [
        Message.user("hi"),
        new Message({
          role: Role.ASSISTANT,
          content: [{
            kind: ContentKind.TOOL_CALL,
            tool_call: { id: "tc_1", name: "search", arguments: { q: "test" } },
          }],
        }),
        Message.tool_result("tc_1", "result here"),
      ];

      await adapter.complete(makeRequest({ messages: msgs }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      // tool_result should be role: "user" with tool_result content
      const userMsg = messages.find(m => {
        const content = m.content as Record<string, unknown>[];
        return content.some(c => c.type === "tool_result");
      });
      expect(userMsg).toBeDefined();
    });

    it("translates thinking content blocks", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      const msg = new Message({
        role: Role.ASSISTANT,
        content: [
          { kind: ContentKind.THINKING, thinking: { text: "Let me think...", signature: "sig123" } },
          { kind: ContentKind.TEXT, text: "Answer" },
        ],
      });

      await adapter.complete(makeRequest({ messages: [Message.user("hi"), msg, Message.user("ok")] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      const assistantMsg = messages.find(m => m.role === "assistant");
      expect(assistantMsg).toBeDefined();
      const content = assistantMsg!.content as Record<string, unknown>[];
      const thinkingBlock = content.find(c => c.type === "thinking");
      expect(thinkingBlock).toBeDefined();
      expect(thinkingBlock!.thinking).toBe("Let me think...");
      expect(thinkingBlock!.signature).toBe("sig123");
    });

    it("sets beta headers for thinking", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({
        provider_options: {
          anthropic: { thinking: { type: "enabled", budget_tokens: 10000 } },
        },
      }));

      const headers = mockedHttpRequest.mock.calls[0][0].headers as Record<string, string>;
      expect(headers["anthropic-beta"]).toContain("interleaved-thinking-2025-05-14");
    });

    it("merges consecutive same-role messages", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({
        messages: [
          Message.user("first"),
          Message.user("second"),
        ],
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      // Should be merged into one user message
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
      const content = messages[0].content as Record<string, unknown>[];
      expect(content).toHaveLength(2);
    });
  });

  describe("response parsing", () => {
    it("parses text response", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "msg_abc",
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "Hello World" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 15, output_tokens: 8 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.id).toBe("msg_abc");
      expect(resp.text).toBe("Hello World");
      expect(resp.finish_reason.reason).toBe("stop");
      expect(resp.usage.input_tokens).toBe(15);
    });

    it("parses tool_use response", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "msg_abc",
          model: "claude-opus-4-6",
          content: [{
            type: "tool_use",
            id: "tu_1",
            name: "search",
            input: { query: "test" },
          }],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.tool_calls).toHaveLength(1);
      expect(resp.tool_calls[0].name).toBe("search");
      expect(resp.tool_calls[0].arguments).toEqual({ query: "test" });
      expect(resp.finish_reason.reason).toBe("tool_calls");
    });

    it("parses thinking blocks", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "msg_abc",
          model: "claude-opus-4-6",
          content: [
            { type: "thinking", thinking: "Let me think...", signature: "sig" },
            { type: "text", text: "Answer" },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 20 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.reasoning).toBe("Let me think...");
      expect(resp.text).toBe("Answer");
    });

    it("parses cache token usage", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "msg_abc",
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 20,
          },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.usage.cache_read_tokens).toBe(50);
      expect(resp.usage.cache_write_tokens).toBe(20);
    });

    it("maps finish reasons correctly", async () => {
      const testCases: [string, string][] = [
        ["end_turn", "stop"],
        ["stop_sequence", "stop"],
        ["max_tokens", "length"],
        ["tool_use", "tool_calls"],
      ];

      for (const [raw, expected] of testCases) {
        vi.clearAllMocks();
        mockedHttpRequest.mockResolvedValue({
          status: 200,
          headers: new Headers(),
          body: {
            id: "m",
            model: "m",
            content: raw === "tool_use"
              ? [{ type: "tool_use", id: "t1", name: "fn", input: {} }]
              : [{ type: "text", text: "hi" }],
            stop_reason: raw,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
          text: "",
        });

        const resp = await adapter.complete(makeRequest());
        expect(resp.finish_reason.reason).toBe(expected);
      }
    });
  });

  describe("stream() — event mapping", () => {
    it("maps Anthropic stream events correctly", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4-6","usage":{"input_tokens":10}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" World"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      expect(events[0].type).toBe(StreamEventType.STREAM_START);
      expect(events[1].type).toBe(StreamEventType.TEXT_START);
      expect(events[2].type).toBe(StreamEventType.TEXT_DELTA);
      expect(events[2].delta).toBe("Hello");
      expect(events[3].type).toBe(StreamEventType.TEXT_DELTA);
      expect(events[3].delta).toBe(" World");
      expect(events[4].type).toBe(StreamEventType.TEXT_END);

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish).toBeDefined();
      expect(finish!.response!.text).toBe("Hello World");
    });

    it("maps tool_use stream events", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"m","usage":{"input_tokens":10}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"search"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"\\"test\\"}"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const tcStart = events.find(e => e.type === StreamEventType.TOOL_CALL_START);
      expect(tcStart).toBeDefined();
      expect(tcStart!.tool_call?.name).toBe("search");

      const tcEnd = events.find(e => e.type === StreamEventType.TOOL_CALL_END);
      expect(tcEnd).toBeDefined();
      expect(tcEnd!.tool_call?.arguments).toEqual({ q: "test" });
    });

    it("maps thinking stream events", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"m","usage":{"input_tokens":10}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Thinking..."}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Answer"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const reasoningStart = events.find(e => e.type === StreamEventType.REASONING_START);
      expect(reasoningStart).toBeDefined();

      const reasoningDelta = events.find(e => e.type === StreamEventType.REASONING_DELTA);
      expect(reasoningDelta).toBeDefined();
      expect(reasoningDelta!.reasoning_delta).toBe("Thinking...");

      const reasoningEnd = events.find(e => e.type === StreamEventType.REASONING_END);
      expect(reasoningEnd).toBeDefined();
    });
  });
});
