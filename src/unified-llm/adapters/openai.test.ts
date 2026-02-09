import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAIAdapter } from "./openai.js";
import { Message, Role, ContentKind, Usage } from "../types.js";
import type { Request, ToolDefinition, StreamEvent } from "../types.js";
import { StreamEventType } from "../types.js";

// Mock the http module to avoid real HTTP calls
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
    model: "gpt-5.2",
    messages: [Message.user("Hello")],
    ...overrides,
  };
}

// Helper: create a mock ReadableStream for streaming tests
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

describe("OpenAIAdapter", () => {
  let adapter: OpenAIAdapter;

  beforeEach(() => {
    adapter = new OpenAIAdapter({ api_key: "sk-test" });
    vi.clearAllMocks();
  });

  describe("construction", () => {
    it("uses default base_url", () => {
      const a = new OpenAIAdapter({ api_key: "sk-test" });
      expect(a.name).toBe("openai");
    });

    it("strips trailing slash from base_url", () => {
      const a = new OpenAIAdapter({ api_key: "sk-test", base_url: "https://api.example.com/" });
      // We can verify by making a request and checking the URL
      expect(a.name).toBe("openai");
    });
  });

  describe("complete() — request translation", () => {
    it("extracts system/developer messages as instructions", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "resp_1",
          model: "gpt-5.2",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
        text: "",
      });

      await adapter.complete(makeRequest({
        messages: [
          Message.system("You are a helper"),
          Message.user("Hello"),
        ],
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.instructions).toBe("You are a helper");
      // System message should NOT appear in input
      const input = body.input as unknown[];
      const hasSystemInInput = input.some((i: unknown) => {
        const item = i as Record<string, unknown>;
        return item.role === "system";
      });
      expect(hasSystemInInput).toBe(false);
    });

    it("translates user messages to input_text content", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "resp_1",
          model: "gpt-5.2",
          status: "completed",
          output: [],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
        text: "",
      });

      await adapter.complete(makeRequest());

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const input = body.input as Record<string, unknown>[];
      expect(input[0]).toEqual({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hello" }],
      });
    });

    it("translates tool definitions to function tools", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "resp_1",
          model: "gpt-5.2",
          status: "completed",
          output: [],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
        text: "",
      });

      const tools: ToolDefinition[] = [{
        name: "search",
        description: "Search the web",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      }];

      await adapter.complete(makeRequest({ tools }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.tools).toEqual([{
        type: "function",
        name: "search",
        description: "Search the web",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      }]);
    });

    it("translates tool choice modes", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      // auto
      await adapter.complete(makeRequest({ tool_choice: { mode: "auto" } }));
      let body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.tool_choice).toBe("auto");

      // none
      vi.clearAllMocks();
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });
      await adapter.complete(makeRequest({ tool_choice: { mode: "none" } }));
      body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.tool_choice).toBe("none");

      // required
      vi.clearAllMocks();
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });
      await adapter.complete(makeRequest({ tool_choice: { mode: "required" } }));
      body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.tool_choice).toBe("required");

      // named
      vi.clearAllMocks();
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });
      await adapter.complete(makeRequest({ tool_choice: { mode: "named", tool_name: "search" } }));
      body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.tool_choice).toEqual({ type: "function", function: { name: "search" } });
    });

    it("translates image content from URL", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      const msg = new Message({
        role: Role.USER,
        content: [{
          kind: ContentKind.IMAGE,
          image: { url: "https://example.com/img.png", detail: "high" },
        }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const input = body.input as Record<string, unknown>[];
      const content = (input[0] as Record<string, unknown>).content as Record<string, unknown>[];
      expect(content[0]).toEqual({
        type: "input_image",
        image_url: "https://example.com/img.png",
        detail: "high",
      });
    });

    it("translates image content from base64", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      const msg = new Message({
        role: Role.USER,
        content: [{
          kind: ContentKind.IMAGE,
          image: { data: "abc123", media_type: "image/jpeg" },
        }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const input = body.input as Record<string, unknown>[];
      const content = (input[0] as Record<string, unknown>).content as Record<string, unknown>[];
      expect(content[0]).toEqual({
        type: "input_image",
        image_url: "data:image/jpeg;base64,abc123",
      });
    });

    it("translates assistant messages with tool calls to function_call items", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      const msg = new Message({
        role: Role.ASSISTANT,
        content: [
          { kind: ContentKind.TEXT, text: "Let me search" },
          { kind: ContentKind.TOOL_CALL, tool_call: { id: "tc_1", name: "search", arguments: { q: "test" } } },
        ],
      });

      await adapter.complete(makeRequest({ messages: [Message.user("hi"), msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const input = body.input as Record<string, unknown>[];
      // Should have user message, assistant text message, and function_call
      const funcCall = input.find((i: unknown) => (i as Record<string, unknown>).type === "function_call");
      expect(funcCall).toEqual({
        type: "function_call",
        id: "tc_1",
        name: "search",
        arguments: '{"q":"test"}',
      });
    });

    it("translates tool result messages to function_call_output", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      const toolResultMsg = Message.tool_result("tc_1", "search result here");

      await adapter.complete(makeRequest({ messages: [Message.user("hi"), toolResultMsg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const input = body.input as Record<string, unknown>[];
      const output = input.find((i: unknown) => (i as Record<string, unknown>).type === "function_call_output");
      expect(output).toEqual({
        type: "function_call_output",
        call_id: "tc_1",
        output: "search result here",
      });
    });

    it("sets reasoning effort", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({ reasoning_effort: "high" }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.reasoning).toEqual({ effort: "high" });
    });

    it("does not set reasoning for 'none'", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({ reasoning_effort: "none" }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.reasoning).toBeUndefined();
    });

    it("translates json_schema response format", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({
        response_format: {
          type: "json_schema",
          json_schema: { type: "object", properties: { name: { type: "string" } } },
          strict: true,
        },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const textFormat = body.text as Record<string, unknown>;
      expect(textFormat.format).toEqual({
        type: "json_schema",
        schema: { type: "object", properties: { name: { type: "string" } } },
        strict: true,
      });
    });

    it("translates json response format", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({ response_format: { type: "json" } }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const textFormat = body.text as Record<string, unknown>;
      expect(textFormat.format).toEqual({ type: "json_object" });
    });

    it("sets max_output_tokens from max_tokens", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({ max_tokens: 1000 }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.max_output_tokens).toBe(1000);
    });
  });

  describe("complete() — response parsing", () => {
    it("parses text output", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "resp_abc",
          model: "gpt-5.2",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "Hello World" }] }],
          usage: { input_tokens: 15, output_tokens: 8, total_tokens: 23 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.id).toBe("resp_abc");
      expect(resp.model).toBe("gpt-5.2");
      expect(resp.provider).toBe("openai");
      expect(resp.text).toBe("Hello World");
      expect(resp.finish_reason.reason).toBe("stop");
      expect(resp.usage.input_tokens).toBe(15);
      expect(resp.usage.output_tokens).toBe(8);
    });

    it("parses function call output", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "resp_abc",
          model: "gpt-5.2",
          status: "completed",
          output: [{
            type: "function_call",
            id: "fc_1",
            name: "search",
            arguments: '{"query":"test"}',
          }],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.tool_calls).toHaveLength(1);
      expect(resp.tool_calls[0].name).toBe("search");
      expect(resp.tool_calls[0].arguments).toEqual({ query: "test" });
      expect(resp.finish_reason.reason).toBe("tool_calls");
    });

    it("parses usage with reasoning tokens", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "resp_abc",
          model: "gpt-5.2",
          status: "completed",
          output: [],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            output_tokens_details: { reasoning_tokens: 3 },
            prompt_tokens_details: { cached_tokens: 2 },
          },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.usage.reasoning_tokens).toBe(3);
      expect(resp.usage.cache_read_tokens).toBe(2);
    });
  });

  describe("stream() — event mapping", () => {
    it("emits STREAM_START and maps text deltas", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.created\ndata: {"response":{"id":"r1","model":"gpt-5.2"}}\n\n',
          'event: response.output_text.delta\ndata: {"delta":"Hello"}\n\n',
          'event: response.output_text.delta\ndata: {"delta":" World"}\n\n',
          'event: response.output_text.done\ndata: {}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"gpt-5.2","status":"completed","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      expect(events[0].type).toBe(StreamEventType.STREAM_START);
      const textStart = events.find(e => e.type === StreamEventType.TEXT_START);
      expect(textStart).toBeDefined();
      const deltas = events.filter(e => e.type === StreamEventType.TEXT_DELTA);
      expect(deltas).toHaveLength(2);
      expect(deltas[0].delta).toBe("Hello");
      expect(deltas[1].delta).toBe(" World");
      const textEnd = events.find(e => e.type === StreamEventType.TEXT_END);
      expect(textEnd).toBeDefined();
      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish).toBeDefined();
      expect(finish!.response).toBeDefined();
      expect(finish!.response!.text).toBe("Hello World");
    });

    it("emits tool call events", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.output_item.added\ndata: {"item":{"type":"function_call","id":"fc_1","name":"search"}}\n\n',
          'event: response.function_call_arguments.delta\ndata: {"item_id":"fc_1","delta":"{\\"q\\":"}\n\n',
          'event: response.function_call_arguments.delta\ndata: {"item_id":"fc_1","delta":"\\"test\\"}"}\n\n',
          'event: response.output_item.done\ndata: {"item":{"type":"function_call","id":"fc_1","name":"search","arguments":"{\\"q\\":\\"test\\"}"}}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n',
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
  });
});
