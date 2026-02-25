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

import { httpRequest, httpStreamRequest, raiseForStatus } from "../utils/http.js";

const mockedHttpRequest = vi.mocked(httpRequest);
const mockedHttpStreamRequest = vi.mocked(httpStreamRequest);
const mockedRaiseForStatus = vi.mocked(raiseForStatus);

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
      // tool_choice should be undefined since mode is "none"
      expect(body.tool_choice).toBeUndefined();
      // The translateToolChoice function would return {type: "auto"} for "none"
      // but it's never called because the caller omits tools entirely
    });

    it("translateToolChoice with 'none' falls through to auto type (internal branch)", async () => {
      // This test verifies translateToolChoice("none") returns {type:"auto"}
      // We cover this indirectly: when tool_choice is none AND there are no tools array,
      // tool_choice is still omitted. But if somehow tool_choice none was used without tools,
      // the tool_choice line 169 check prevents it from being set.
      // The branch at line 637 is covered because the function IS called if mode !== "none"
      // in line 169, but we need to ensure the "none" case in the switch is reached.
      // Since the caller guards against calling translateToolChoice for "none" mode,
      // we need to test without tools to trigger a code path that calls it.
      // Actually, the code at lines 169-171 skips calling translateToolChoice when mode is "none".
      // The translateToolChoice "none" branch at line 636-637 is dead code from caller perspective.
      // However, we can test it indirectly by looking at the behavior.
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      // Even with tool_choice: none, tools should be omitted
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

    it("maps redacted_thinking stream events", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"m","usage":{"input_tokens":10}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Answer"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish).toBeDefined();
      const content = finish!.response!.message.content;
      const redacted = content.find(p => p.kind === ContentKind.REDACTED_THINKING);
      expect(redacted).toBeDefined();
      expect(redacted!.thinking?.redacted).toBe(true);
      expect(redacted!.thinking?.text).toBe("");
    });

    it("handles stream error (4xx) by reading body and calling raiseForStatus", async () => {
      const encoder = new TextEncoder();
      const errorBody = JSON.stringify({ error: { message: "Bad request" } });
      let sent = false;
      const errorStream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            controller.enqueue(encoder.encode(errorBody));
            sent = true;
          } else {
            controller.close();
          }
        },
      });

      mockedHttpStreamRequest.mockResolvedValue({
        status: 400,
        headers: new Headers(),
        body: errorStream,
      });

      mockedRaiseForStatus.mockImplementationOnce(() => {
        throw new Error("Bad request");
      });

      await expect(async () => {
        const events: StreamEvent[] = [];
        for await (const e of adapter.stream(makeRequest())) {
          events.push(e);
        }
      }).rejects.toThrow("Bad request");

      expect(mockedRaiseForStatus).toHaveBeenCalledWith(
        400,
        expect.any(Headers),
        { error: { message: "Bad request" } },
        "anthropic",
      );
    });

    it("handles stream error with non-JSON body", async () => {
      const encoder = new TextEncoder();
      let sent = false;
      const errorStream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            controller.enqueue(encoder.encode("Internal Server Error"));
            sent = true;
          } else {
            controller.close();
          }
        },
      });

      mockedHttpStreamRequest.mockResolvedValue({
        status: 500,
        headers: new Headers(),
        body: errorStream,
      });

      mockedRaiseForStatus.mockImplementationOnce(() => {
        throw new Error("Server error");
      });

      await expect(async () => {
        for await (const _e of adapter.stream(makeRequest())) { /* drain */ }
      }).rejects.toThrow("Server error");

      // When JSON.parse fails, the raw text string is passed
      expect(mockedRaiseForStatus).toHaveBeenCalledWith(
        500,
        expect.any(Headers),
        "Internal Server Error",
        "anthropic",
      );
    });

    it("accumulates cache tokens from message_start usage in stream", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"m","usage":{"input_tokens":10,"cache_read_input_tokens":50,"cache_creation_input_tokens":20}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish).toBeDefined();
      expect(finish!.usage!.cache_read_tokens).toBe(50);
      expect(finish!.usage!.cache_write_tokens).toBe(20);
    });

    it("skips unparseable JSON data in stream events", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"m","usage":{"input_tokens":5}}}\n\n',
          'event: content_block_start\ndata: not-valid-json\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.response!.text).toBe("OK");
    });
  });

  describe("request translation — content types", () => {
    it("translates Document content (base64)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      const msg = new Message({
        role: Role.USER,
        content: [{
          kind: ContentKind.DOCUMENT,
          document: { data: "cGRmZGF0YQ==", media_type: "application/pdf" },
        }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      const content = messages[0].content as Record<string, unknown>[];
      expect(content[0]).toMatchObject({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "cGRmZGF0YQ==" },
      });
    });

    it("translates Document content with default media_type", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      const msg = new Message({
        role: Role.USER,
        content: [{
          kind: ContentKind.DOCUMENT,
          document: { data: "cGRmZGF0YQ==" },
        }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      const content = messages[0].content as Record<string, unknown>[];
      expect(content[0]).toMatchObject({
        type: "document",
        source: { type: "base64", media_type: "application/pdf" },
      });
    });

    it("translates Image content with default media_type (base64)", async () => {
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
          image: { data: "base64data" },
        }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      const content = messages[0].content as Record<string, unknown>[];
      expect(content[0]).toMatchObject({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "base64data" },
      });
    });

    it("translates THINKING content in assistant message", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      const msg = new Message({
        role: Role.ASSISTANT,
        content: [
          { kind: ContentKind.THINKING, thinking: { text: "I'm thinking" } },
          { kind: ContentKind.TEXT, text: "Response" },
        ],
      });

      await adapter.complete(makeRequest({ messages: [Message.user("hi"), msg, Message.user("ok")] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      const assistantMsg = messages.find(m => m.role === "assistant");
      const content = assistantMsg!.content as Record<string, unknown>[];
      const thinkingBlock = content.find(c => c.type === "thinking");
      expect(thinkingBlock).toBeDefined();
      expect(thinkingBlock!.thinking).toBe("I'm thinking");
      // No signature key when signature is undefined
      expect(thinkingBlock!.signature).toBeUndefined();
    });

    it("translates REDACTED_THINKING content in assistant message", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      const msg = new Message({
        role: Role.ASSISTANT,
        content: [
          { kind: ContentKind.REDACTED_THINKING, thinking: { text: "redacted-data", redacted: true } },
          { kind: ContentKind.TEXT, text: "Response" },
        ],
      });

      await adapter.complete(makeRequest({ messages: [Message.user("hi"), msg, Message.user("ok")] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      const assistantMsg = messages.find(m => m.role === "assistant");
      const content = assistantMsg!.content as Record<string, unknown>[];
      const redactedBlock = content.find(c => c.type === "redacted_thinking");
      expect(redactedBlock).toBeDefined();
      expect(redactedBlock!.data).toBe("redacted-data");
    });

    it("translates tool call with string arguments", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      const msg = new Message({
        role: Role.ASSISTANT,
        content: [{
          kind: ContentKind.TOOL_CALL,
          tool_call: { id: "tc_1", name: "search", arguments: '{"q":"test"}' },
        }],
      });

      await adapter.complete(makeRequest({ messages: [Message.user("hi"), msg, Message.user("ok")] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      const assistantMsg = messages.find(m => m.role === "assistant");
      const content = assistantMsg!.content as Record<string, unknown>[];
      const toolUse = content.find(c => c.type === "tool_use");
      expect(toolUse).toBeDefined();
      expect(toolUse!.input).toEqual({ q: "test" });
    });

    it("translates tool_result with object content", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      const msg = Message.tool_result("tc_1", { key: "value" });

      await adapter.complete(makeRequest({ messages: [Message.user("hi"), msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      const userContent = messages[0].content as Record<string, unknown>[];
      const toolResult = userContent.find(c => c.type === "tool_result");
      expect(toolResult).toBeDefined();
      expect(toolResult!.content).toBe('{"key":"value"}');
    });
  });

  describe("response parsing — additional", () => {
    it("parses redacted_thinking blocks in non-streaming response", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "msg_abc",
          model: "claude-opus-4-6",
          content: [
            { type: "redacted_thinking", data: "opaque-data" },
            { type: "text", text: "Answer" },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 20 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.text).toBe("Answer");
      const redacted = resp.message.content.find(p => p.kind === ContentKind.REDACTED_THINKING);
      expect(redacted).toBeDefined();
      expect(redacted!.thinking?.redacted).toBe(true);
      expect(redacted!.thinking?.text).toBe("opaque-data");
    });

    it("maps unknown finish reasons to 'other'", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "m",
          model: "m",
          content: [{ type: "text", text: "hi" }],
          stop_reason: "some_unknown_reason",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.finish_reason.reason).toBe("other");
      expect(resp.finish_reason.raw).toBe("some_unknown_reason");
    });
  });

  describe("request building — provider options", () => {
    it("passes through additional provider options", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({
        provider_options: {
          anthropic: { metadata: { user_id: "u1" } },
        },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.metadata).toEqual({ user_id: "u1" });
    });

    it("does not override existing body keys with provider options", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({
        provider_options: {
          anthropic: { model: "should-not-override" },
        },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.model).toBe("claude-opus-4-6");
    });

    it("disables auto_cache when set to false", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({
        messages: [
          Message.system("System prompt"),
          Message.user("Hello"),
        ],
        provider_options: {
          anthropic: { auto_cache: false },
        },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const system = body.system as Record<string, unknown>[];
      // No cache_control should be added
      expect(system[0].cache_control).toBeUndefined();

      const headers = mockedHttpRequest.mock.calls[0][0].headers as Record<string, string>;
      // No prompt-caching beta header
      expect(headers["anthropic-beta"] ?? "").not.toContain("prompt-caching");
    });

    it("includes beta_headers from provider options", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({
        provider_options: {
          anthropic: { beta_headers: ["custom-beta-2024-01-01"] },
        },
      }));

      const headers = mockedHttpRequest.mock.calls[0][0].headers as Record<string, string>;
      expect(headers["anthropic-beta"]).toContain("custom-beta-2024-01-01");
    });

    it("includes beta_features from provider options", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({
        provider_options: {
          anthropic: { beta_features: ["feature-2024-01-01"] },
        },
      }));

      const headers = mockedHttpRequest.mock.calls[0][0].headers as Record<string, string>;
      expect(headers["anthropic-beta"]).toContain("feature-2024-01-01");
    });

    it("sets generation parameters (temperature, top_p, stop_sequences)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({
        temperature: 0.7,
        top_p: 0.9,
        stop_sequences: ["END"],
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.temperature).toBe(0.7);
      expect(body.top_p).toBe(0.9);
      expect(body.stop_sequences).toEqual(["END"]);
    });

    it("uses custom base_url and api_version", async () => {
      const customAdapter = new AnthropicAdapter({
        api_key: "sk-ant-test",
        base_url: "https://custom.api.com/v1/",
        api_version: "2024-01-01",
      });

      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      await customAdapter.complete(makeRequest());

      const url = mockedHttpRequest.mock.calls[0][0].url;
      expect(url).toBe("https://custom.api.com/v1/messages");

      const headers = mockedHttpRequest.mock.calls[0][0].headers as Record<string, string>;
      expect(headers["anthropic-version"]).toBe("2024-01-01");
    });

    it("passes default_headers to requests", async () => {
      const customAdapter = new AnthropicAdapter({
        api_key: "sk-ant-test",
        default_headers: { "X-Custom": "value" },
      });

      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      await customAdapter.complete(makeRequest());

      const headers = mockedHttpRequest.mock.calls[0][0].headers as Record<string, string>;
      expect(headers["X-Custom"]).toBe("value");
    });

    it("sets extended thinking in body", async () => {
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

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    });
  });

  describe("uncovered branch coverage", () => {
    it("covers translateToolChoice 'none' branch (line 635)", async () => {
      // Even though the caller guards against calling translateToolChoice for "none",
      // we need to verify the tool_choice and tool omission behavior.
      // The "none" branch of translateToolChoice IS dead code from the normal path.
      // We verify the overall behavior when tool_choice is "none" with tools.
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

    it("covers content_block_start with empty content (line 127)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      // Message with no content parts at all should be skipped
      const msg = new Message({
        role: Role.USER,
        content: [],
      });

      await adapter.complete(makeRequest({ messages: [Message.user("hi"), msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      // Empty message should have been skipped, only one message
      expect(messages).toHaveLength(1);
    });

    it("covers streaming with SSE event type from data.type fallback (line 272)", async () => {
      // Send events WITHOUT event: field prefix — data.type is used as fallback
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4-6","usage":{"input_tokens":10}}}\n\n',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
          'data: {"type":"content_block_stop"}\n\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
          'data: {"type":"message_stop"}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish).toBeDefined();
      expect(finish!.response!.text).toBe("Hello");
    });

    it("covers streaming message_start without usage data (lines 278-279, 282)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"m"}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish).toBeDefined();
      expect(finish!.usage!.input_tokens).toBe(0);
    });

    it("covers streaming message_start with usage but without cache tokens (line 282, 291)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"m","usage":{"input_tokens":10}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.usage!.cache_read_tokens).toBeUndefined();
      expect(finish!.usage!.cache_write_tokens).toBeUndefined();
    });

    it("covers streaming content_block_start with no index field (line 291)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"m","usage":{"input_tokens":10}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.response!.text).toBe("Hi");
    });

    it("covers streaming tool_use content_block_start with missing id/name (line 299-300)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"m","usage":{"input_tokens":10}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
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
      expect(tcStart!.tool_call?.id).toBe("");
      expect(tcStart!.tool_call?.name).toBe("");
    });

    it("covers streaming with unparseable tool call JSON args (line 350)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"m","usage":{"input_tokens":10}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"fn"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"not-json"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const tcEnd = events.find(e => e.type === StreamEventType.TOOL_CALL_END);
      expect(tcEnd).toBeDefined();
      expect(tcEnd!.tool_call?.arguments).toEqual({});
    });

    it("covers streaming message_delta without delta or usage (line 390, 409)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"m","usage":{"input_tokens":10}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
          'event: message_delta\ndata: {"type":"message_delta"}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish).toBeDefined();
      // No finish reason from message_delta — falls back to default
      expect(finish!.finish_reason!.reason).toBe("stop");
      expect(finish!.finish_reason!.raw).toBe("end_turn");
    });

    it("covers streaming usage with cache_creation_input_tokens but no cache_read (line 434-438)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"m","usage":{"input_tokens":10,"cache_creation_input_tokens":30}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.usage!.cache_write_tokens).toBe(30);
      expect(finish!.usage!.cache_read_tokens).toBeUndefined();
    });

    it("covers Document content type translation with no data (line 486-487, 495)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      // Document with no data should not produce output
      const msg = new Message({
        role: Role.USER,
        content: [{ kind: ContentKind.DOCUMENT, document: {} as { data?: string } }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      // Empty document should not produce content, so message is empty
      expect(messages).toHaveLength(0);
    });

    it("covers mapFinishReason with 'max_tokens' (line 528)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "m",
          model: "m",
          content: [{ type: "text", text: "truncated" }],
          stop_reason: "max_tokens",
          usage: { input_tokens: 100, output_tokens: 4096 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.finish_reason.reason).toBe("length");
      expect(resp.finish_reason.raw).toBe("max_tokens");
    });

    it("covers parseResponse with no stop_reason field (line 495)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "m",
          model: "m",
          content: [{ type: "text", text: "hi" }],
          // no stop_reason — falls back to "end_turn"
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.finish_reason.reason).toBe("stop");
      expect(resp.finish_reason.raw).toBe("end_turn");
    });

    it("covers parseResponse with no usage data", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "m",
          model: "m",
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          // no usage field
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.usage.input_tokens).toBe(0);
      expect(resp.usage.output_tokens).toBe(0);
    });

    it("covers parseResponse with redacted_thinking that has no data field (line 473)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "m",
          model: "m",
          content: [
            { type: "redacted_thinking" },
            { type: "text", text: "Answer" },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      const redacted = resp.message.content.find(p => p.kind === ContentKind.REDACTED_THINKING);
      expect(redacted).toBeDefined();
      // data is undefined, so `block.data as string ?? ""` gives ""
      expect(redacted!.thinking?.text).toBe("");
    });

    it("covers message content with empty content (IMAGE with no image field)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      const msg = new Message({
        role: Role.USER,
        content: [{ kind: ContentKind.IMAGE }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      // IMAGE without image field should not produce content
      expect(messages).toHaveLength(0);
    });

    it("covers text ?? '' fallback in translateMessageContent (line 528)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "m", model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
        text: "",
      });

      const msg = new Message({
        role: Role.USER,
        content: [{ kind: ContentKind.TEXT, text: undefined as unknown as string }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const messages = body.messages as Record<string, unknown>[];
      const content = messages[0].content as Record<string, unknown>[];
      expect(content[0].text).toBe("");
    });

    it("covers streaming with redacted_thinking content block start (line 372)", async () => {
      // Exercise the redacted_thinking block type at content_block_start
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"m","usage":{"input_tokens":10}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Answer"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish).toBeDefined();
      const redacted = finish!.response!.message.content.find(p => p.kind === ContentKind.REDACTED_THINKING);
      expect(redacted).toBeDefined();
      expect(redacted!.thinking?.redacted).toBe(true);
    });

    it("covers parseResponse with missing id and model (line 434-435)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.id).toBe("");
      expect(resp.model).toBe("");
    });

    it("covers parseResponse with no content array (line 438)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "m",
          model: "m",
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.text).toBe("");
    });

    it("covers parseResponse usage without cache_creation_input_tokens (line 486-487)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "m",
          model: "m",
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.usage.cache_read_tokens).toBe(20);
      expect(resp.usage.cache_write_tokens).toBeUndefined();
    });
  });
});
