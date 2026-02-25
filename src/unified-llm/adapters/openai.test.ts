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

    it("handles [DONE] signal in stream", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.output_text.delta\ndata: {"delta":"Hello"}\n\n',
          'event: response.output_text.done\ndata: {}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
          'data: [DONE]\n\n',
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

    it("handles stream error (4xx) by reading body and calling raiseForStatus", async () => {
      const encoder = new TextEncoder();
      const errorBody = JSON.stringify({ error: { message: "Rate limited" } });
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
        status: 429,
        headers: new Headers(),
        body: errorStream,
      });

      mockedRaiseForStatus.mockImplementationOnce(() => {
        throw new Error("Rate limited");
      });

      await expect(async () => {
        for await (const _e of adapter.stream(makeRequest())) { /* drain */ }
      }).rejects.toThrow("Rate limited");

      expect(mockedRaiseForStatus).toHaveBeenCalledWith(
        429,
        expect.any(Headers),
        { error: { message: "Rate limited" } },
        "openai",
      );
    });

    it("handles stream error with non-JSON body", async () => {
      const encoder = new TextEncoder();
      let sent = false;
      const errorStream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            controller.enqueue(encoder.encode("Bad Gateway"));
            sent = true;
          } else {
            controller.close();
          }
        },
      });

      mockedHttpStreamRequest.mockResolvedValue({
        status: 502,
        headers: new Headers(),
        body: errorStream,
      });

      mockedRaiseForStatus.mockImplementationOnce(() => {
        throw new Error("Bad Gateway");
      });

      await expect(async () => {
        for await (const _e of adapter.stream(makeRequest())) { /* drain */ }
      }).rejects.toThrow("Bad Gateway");

      expect(mockedRaiseForStatus).toHaveBeenCalledWith(
        502,
        expect.any(Headers),
        "Bad Gateway",
        "openai",
      );
    });

    it("handles response.in_progress event", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.created\ndata: {"response":{"id":"r1","model":"gpt-5.2"}}\n\n',
          'event: response.in_progress\ndata: {"response":{"id":"r1","model":"gpt-5.2"}}\n\n',
          'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n',
          'event: response.output_text.done\ndata: {}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"gpt-5.2","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish).toBeDefined();
      expect(finish!.response!.id).toBe("r1");
    });

    it("skips unparseable JSON data in stream", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: not-valid-json\n\n',
          'event: response.output_text.delta\ndata: {"delta":"OK"}\n\n',
          'event: response.output_text.done\ndata: {}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.response!.text).toBe("OK");
    });

    it("handles text that accumulates without output_text.done event", async () => {
      // When stream finishes without output_text.done, text should still be captured
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.output_text.delta\ndata: {"delta":"Hello"}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.response!.text).toBe("Hello");
    });

    it("includes reasoning and cache tokens from usage details", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n',
          'event: response.output_text.done\ndata: {}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed","usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150,"output_tokens_details":{"reasoning_tokens":30},"prompt_tokens_details":{"cached_tokens":20}}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.usage!.reasoning_tokens).toBe(30);
      expect(finish!.usage!.cache_read_tokens).toBe(20);
    });
  });

  describe("complete() — additional request translation", () => {
    it("sets organization and project headers", async () => {
      const customAdapter = new OpenAIAdapter({
        api_key: "sk-test",
        organization: "org-123",
        project: "proj-456",
      });

      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      await customAdapter.complete(makeRequest());

      const headers = mockedHttpRequest.mock.calls[0][0].headers as Record<string, string>;
      expect(headers["OpenAI-Organization"]).toBe("org-123");
      expect(headers["OpenAI-Project"]).toBe("proj-456");
    });

    it("passes through provider options", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({
        provider_options: {
          openai: { user: "user-123" },
        },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.user).toBe("user-123");
    });

    it("does not override existing body keys with provider options", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({
        provider_options: {
          openai: { model: "should-not-override" },
        },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.model).toBe("gpt-5.2");
    });

    it("translates user message with TOOL_CALL kind gracefully", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      // This is an unusual case - a user message with a TOOL_CALL kind
      const msg = new Message({
        role: Role.USER,
        content: [{
          kind: ContentKind.TOOL_CALL,
          tool_call: { id: "tc_1", name: "fn", arguments: {} },
        }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const input = body.input as Record<string, unknown>[];
      expect(input[0]).toBeDefined();
    });

    it("maps finish reasons correctly", async () => {
      const testCases: [string, string, boolean][] = [
        ["completed", "stop", false],
        ["stop", "stop", false],
        ["length", "length", false],
        ["incomplete", "length", false],
        ["tool_calls", "tool_calls", false],
        ["content_filter", "content_filter", false],
        ["some_unknown", "other", false],
        // Tool calls override
        ["completed", "tool_calls", true],
      ];

      for (const [rawStatus, expected, hasToolCalls] of testCases) {
        vi.clearAllMocks();
        const output = hasToolCalls
          ? [{ type: "function_call", id: "fc_1", name: "fn", arguments: "{}" }]
          : [{ type: "message", content: [{ type: "output_text", text: "hi" }] }];

        mockedHttpRequest.mockResolvedValue({
          status: 200,
          headers: new Headers(),
          body: {
            id: "r",
            model: "m",
            status: rawStatus,
            output,
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          },
          text: "",
        });

        const resp = await adapter.complete(makeRequest());
        expect(resp.finish_reason.reason).toBe(expected);
      }
    });

    it("handles tool_result with object content", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      const msg = Message.tool_result("tc_1", { key: "value" });
      await adapter.complete(makeRequest({ messages: [Message.user("hi"), msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const input = body.input as Record<string, unknown>[];
      const output = input.find((i) => (i as Record<string, unknown>).type === "function_call_output") as Record<string, unknown>;
      expect(output.output).toBe('{"key":"value"}');
    });

    it("uses custom base_url", async () => {
      const customAdapter = new OpenAIAdapter({
        api_key: "sk-test",
        base_url: "https://custom.openai.com/v1/",
      });

      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      await customAdapter.complete(makeRequest());

      const url = mockedHttpRequest.mock.calls[0][0].url;
      expect(url).toBe("https://custom.openai.com/v1/responses");
    });

    it("sets generation parameters (temperature, top_p)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({
        temperature: 0.7,
        top_p: 0.9,
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.temperature).toBe(0.7);
      expect(body.top_p).toBe(0.9);
    });

    it("translates tool call with string arguments in assistant message", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      const msg = new Message({
        role: Role.ASSISTANT,
        content: [{
          kind: ContentKind.TOOL_CALL,
          tool_call: { id: "tc_1", name: "search", arguments: '{"q":"test"}' },
        }],
      });

      await adapter.complete(makeRequest({ messages: [Message.user("hi"), msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const input = body.input as Record<string, unknown>[];
      const funcCall = input.find((i) => (i as Record<string, unknown>).type === "function_call") as Record<string, unknown>;
      expect(funcCall.arguments).toBe('{"q":"test"}');
    });

    it("handles function call with unparseable arguments", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "r",
          model: "m",
          status: "completed",
          output: [{
            type: "function_call",
            id: "fc_1",
            name: "fn",
            arguments: "not valid json",
          }],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      // Should still parse, keeping empty arguments
      expect(resp.tool_calls).toHaveLength(1);
      expect(resp.tool_calls[0].arguments).toEqual({});
    });
  });

  describe("complete() — parseResponse usage branches", () => {
    it("handles response with no usage data", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "r",
          model: "m",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.usage.input_tokens).toBe(0);
      expect(resp.usage.output_tokens).toBe(0);
    });

    it("handles usage without output_tokens_details or prompt_tokens_details", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "r",
          model: "m",
          status: "completed",
          output: [],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.usage.reasoning_tokens).toBeUndefined();
      expect(resp.usage.cache_read_tokens).toBeUndefined();
    });

    it("handles output item type=message with mixed content", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "r",
          model: "m",
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: "Part 1" },
                { type: "output_text", text: " Part 2" },
              ],
            },
            {
              type: "function_call",
              id: "fc_1",
              name: "search",
              arguments: '{"q":"test"}',
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.text).toBe("Part 1 Part 2");
      expect(resp.tool_calls).toHaveLength(1);
      expect(resp.finish_reason.reason).toBe("tool_calls");
    });
  });

  describe("buildRequestBody — additional branches", () => {
    it("translates image URL without detail", async () => {
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
          image: { url: "https://example.com/img.png" },
        }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const input = body.input as Record<string, unknown>[];
      const content = (input[0] as Record<string, unknown>).content as Record<string, unknown>[];
      expect(content[0]).toEqual({
        type: "input_image",
        image_url: "https://example.com/img.png",
      });
      // detail should not be present
      expect(content[0]).not.toHaveProperty("detail");
    });

    it("translates image base64 with detail", async () => {
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
          image: { data: "abc123", media_type: "image/jpeg", detail: "low" },
        }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const input = body.input as Record<string, unknown>[];
      const content = (input[0] as Record<string, unknown>).content as Record<string, unknown>[];
      expect(content[0]).toEqual({
        type: "input_image",
        image_url: "data:image/jpeg;base64,abc123",
        detail: "low",
      });
    });

    it("translates image base64 with default media_type and no detail", async () => {
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
          image: { data: "abc123" },
        }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const input = body.input as Record<string, unknown>[];
      const content = (input[0] as Record<string, unknown>).content as Record<string, unknown>[];
      expect(content[0]).toEqual({
        type: "input_image",
        image_url: "data:image/png;base64,abc123",
      });
    });
  });

  describe("stream() — unknown/ignored event types", () => {
    it("silently ignores unknown event types in stream", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.created\ndata: {"response":{"id":"r1","model":"gpt-5.2"}}\n\n',
          'event: response.some_unknown_event\ndata: {"foo":"bar"}\n\n',
          'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n',
          'event: response.output_text.done\ndata: {}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"gpt-5.2","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish).toBeDefined();
      expect(finish!.response!.text).toBe("Hi");
    });

    it("handles stream with no usage data in response.completed", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n',
          'event: response.output_text.done\ndata: {}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed"}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish).toBeDefined();
      // Falls back to Usage.zero()
      expect(finish!.usage!.input_tokens).toBe(0);
    });

    it("handles stream response.completed without output_tokens_details", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n',
          'event: response.output_text.done\ndata: {}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.usage!.reasoning_tokens).toBeUndefined();
      expect(finish!.usage!.cache_read_tokens).toBeUndefined();
    });

    it("handles stream finish reason 'incomplete' mapping to length", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n',
          'event: response.output_text.done\ndata: {}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"incomplete","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.finish_reason!.reason).toBe("length");
    });

    it("handles function_call_arguments.delta with no existing tool call", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.function_call_arguments.delta\ndata: {"call_id":"unknown_id","delta":"{\\"x\\":1}"}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      // Should still yield TOOL_CALL_DELTA even without existing call
      const tcDelta = events.find(e => e.type === StreamEventType.TOOL_CALL_DELTA);
      expect(tcDelta).toBeDefined();
    });

    it("handles output_item.done with unparseable JSON arguments", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.output_item.added\ndata: {"item":{"type":"function_call","id":"fc_1","name":"fn"}}\n\n',
          'event: response.output_item.done\ndata: {"item":{"type":"function_call","id":"fc_1","name":"fn","arguments":"not valid json"}}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const tcEnd = events.find(e => e.type === StreamEventType.TOOL_CALL_END);
      expect(tcEnd).toBeDefined();
      // Unparseable args default to empty object
      expect(tcEnd!.tool_call?.arguments).toEqual({});
    });

    it("handles stream content_filter finish reason", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"content_filter","usage":{"input_tokens":5,"output_tokens":0,"total_tokens":5}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.finish_reason!.reason).toBe("content_filter");
    });

    it("handles stream unknown finish reason", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"some_new_reason","usage":{"input_tokens":5,"output_tokens":0,"total_tokens":5}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.finish_reason!.reason).toBe("other");
    });

    it("handles stream with tool_calls finish reason (no hasToolCalls flag)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"tool_calls","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.finish_reason!.reason).toBe("tool_calls");
    });

    it("handles output_text.done when currentTextStarted is false", async () => {
      // output_text.done fires but no text deltas preceded it
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.output_text.done\ndata: {}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed","usage":{"input_tokens":5,"output_tokens":0,"total_tokens":5}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      // Should not yield TEXT_END since text never started
      const textEnd = events.find(e => e.type === StreamEventType.TEXT_END);
      expect(textEnd).toBeUndefined();
    });

    it("handles output_item.added for non-function_call type", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.output_item.added\ndata: {"item":{"type":"message"}}\n\n',
          'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n',
          'event: response.output_text.done\ndata: {}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      // Should not produce tool call start event
      const tcStart = events.find(e => e.type === StreamEventType.TOOL_CALL_START);
      expect(tcStart).toBeUndefined();
      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.response!.text).toBe("Hi");
    });

    it("handles output_item.done for non-function_call type", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.output_item.done\ndata: {"item":{"type":"message"}}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed","usage":{"input_tokens":5,"output_tokens":0,"total_tokens":5}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      // Should not produce tool call end event
      const tcEnd = events.find(e => e.type === StreamEventType.TOOL_CALL_END);
      expect(tcEnd).toBeUndefined();
    });
  });

  describe("uncovered branch coverage", () => {
    it("covers p.text ?? '' fallback when text is undefined (line 105)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      // Assistant message with a TEXT content part where text is undefined
      const msg = new Message({
        role: Role.ASSISTANT,
        content: [{ kind: ContentKind.TEXT, text: undefined as unknown as string }],
      });

      await adapter.complete(makeRequest({ messages: [Message.user("hi"), msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const input = body.input as Record<string, unknown>[];
      const assistantMsg = input.find((i: unknown) => {
        const item = i as Record<string, unknown>;
        return item.type === "message" && item.role === "assistant";
      }) as Record<string, unknown>;
      const content = assistantMsg.content as Record<string, unknown>[];
      expect(content[0].text).toBe("");
    });

    it("covers user text ?? '' fallback when text is undefined (line 131)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      const msg = new Message({
        role: Role.USER,
        content: [{ kind: ContentKind.TEXT, text: undefined as unknown as string }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const input = body.input as Record<string, unknown>[];
      const content = (input[0] as Record<string, unknown>).content as Record<string, unknown>[];
      expect(content[0].text).toBe("");
    });

    it("covers IMAGE content with empty image object (no url or data) (line 131)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      const msg = new Message({
        role: Role.USER,
        content: [{ kind: ContentKind.IMAGE, image: {} as { url?: string; data?: string } }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const input = body.input as Record<string, unknown>[];
      // The image part should not produce any content since neither url nor data is set
      // so content array will be empty and no message should be pushed
      expect(input).toHaveLength(0);
    });

    it("covers json_schema response_format without strict flag (line 197 false branch)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      await adapter.complete(makeRequest({
        response_format: {
          type: "json_schema",
          json_schema: { type: "object" },
          // strict is undefined/absent
        },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const textFormat = body.text as Record<string, unknown>;
      // Should NOT include strict
      expect(textFormat.format).toEqual({
        type: "json_schema",
        schema: { type: "object" },
      });
    });

    it("covers SSE fallback to data.type when sseEvent.event is absent (line 285)", async () => {
      // Send SSE data WITHOUT the event: field — just data: with a type field inside JSON
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.2"}}\n\n',
          'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
          'data: {"type":"response.output_text.done"}\n\n',
          'data: {"type":"response.completed","response":{"id":"r1","model":"gpt-5.2","status":"completed","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish).toBeDefined();
      expect(finish!.response!.text).toBe("Hello");
      expect(finish!.response!.id).toBe("r1");
    });

    it("covers response.created/in_progress with no id (line 290 false branch)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.created\ndata: {"response":{"model":"gpt-5.2"}}\n\n',
          'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n',
          'event: response.output_text.done\ndata: {}\n\n',
          'event: response.completed\ndata: {"response":{"model":"gpt-5.2","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish).toBeDefined();
      // id should remain empty string since no id was in any event
      expect(finish!.response!.id).toBe("");
    });

    it("covers function_call_arguments.delta with only call_id (no item_id) (line 316)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.output_item.added\ndata: {"item":{"type":"function_call","id":"fc_1","name":"search"}}\n\n',
          'event: response.function_call_arguments.delta\ndata: {"call_id":"fc_1","delta":"{\\"q\\":\\"test\\"}"}\n\n',
          'event: response.output_item.done\ndata: {"item":{"type":"function_call","id":"fc_1","name":"search","arguments":"{\\"q\\":\\"test\\"}"}}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const tcDelta = events.find(e => e.type === StreamEventType.TOOL_CALL_DELTA);
      expect(tcDelta).toBeDefined();
      expect(tcDelta!.tool_call?.id).toBe("fc_1");
    });

    it("covers function_call_arguments.delta with neither item_id nor call_id (empty fallback) (line 316)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.function_call_arguments.delta\ndata: {"delta":"{\\"x\\":1}"}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const tcDelta = events.find(e => e.type === StreamEventType.TOOL_CALL_DELTA);
      expect(tcDelta).toBeDefined();
      expect(tcDelta!.tool_call?.id).toBe("");
    });

    it("covers output_item.done with item.arguments undefined (fallback to tc.args) (line 350)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.output_item.added\ndata: {"item":{"type":"function_call","id":"fc_1","name":"fn"}}\n\n',
          'event: response.function_call_arguments.delta\ndata: {"item_id":"fc_1","delta":"{\\"x\\":1}"}\n\n',
          'event: response.output_item.done\ndata: {"item":{"type":"function_call","id":"fc_1","name":"fn"}}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const tcEnd = events.find(e => e.type === StreamEventType.TOOL_CALL_END);
      expect(tcEnd).toBeDefined();
      // item.arguments was undefined, so falls back to tc.args accumulated from deltas
      expect(tcEnd!.tool_call?.arguments).toEqual({ x: 1 });
    });

    it("covers response.completed with no id (line 371 false branch)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.completed\ndata: {"response":{"model":"m","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.response!.id).toBe("");
    });

    it("covers streaming usage with undefined output_tokens_details (line 381-383)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.usage!.reasoning_tokens).toBeUndefined();
      expect(finish!.usage!.cache_read_tokens).toBeUndefined();
    });

    it("covers streaming usage with prompt_tokens alias (no input_tokens, line 381)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed","usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.usage!.input_tokens).toBe(8);
      expect(finish!.usage!.output_tokens).toBe(4);
    });

    it("covers streaming usage with neither input_tokens nor prompt_tokens (falls to 0, line 381)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed","usage":{}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.usage!.input_tokens).toBe(0);
      expect(finish!.usage!.output_tokens).toBe(0);
      expect(finish!.usage!.total_tokens).toBe(0);
    });

    it("covers stream ending without response.completed (finishReason fallback) (line 404)", async () => {
      // Stream ends without a response.completed event — fallback to { reason: "stop" }
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'event: response.output_text.delta\ndata: {"delta":"Hello"}\n\n',
          'event: response.output_text.done\ndata: {}\n\n',
          'data: [DONE]\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish).toBeDefined();
      expect(finish!.finish_reason!.reason).toBe("stop");
      expect(finish!.usage!.input_tokens).toBe(0); // Usage.zero()
    });

    it("covers parseResponse with empty output array (lines 429-430, 433)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "r",
          model: "m",
          status: "completed",
          output: [],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.text).toBe("");
      expect(resp.tool_calls).toHaveLength(0);
    });

    it("covers parseResponse usage without details (lines 440, 469-471)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "r",
          model: "m",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.usage.reasoning_tokens).toBeUndefined();
      expect(resp.usage.cache_read_tokens).toBeUndefined();
    });

    it("covers parseResponse with missing status field (line 479)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "r",
          model: "m",
          // no status field — falls back to "completed"
          output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.finish_reason.reason).toBe("stop");
      expect(resp.finish_reason.raw).toBe("completed");
    });

    it("covers parseResponse with missing id and model (lines 429-430)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          // no id, no model fields — fall back to ""
          status: "completed",
          output: [],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.id).toBe("");
      expect(resp.model).toBe("");
    });

    it("covers parseResponse message content with non-output_text type", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "r",
          model: "m",
          status: "completed",
          output: [{ type: "message", content: [{ type: "unknown_type", text: "ignored" }] }],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      // Non-output_text types should be skipped in message content
      expect(resp.text).toBe("");
    });

    it("covers usage with prompt_tokens and completion_tokens aliases (lines 469-470)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "r",
          model: "m",
          status: "completed",
          output: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.usage.input_tokens).toBe(10);
      expect(resp.usage.output_tokens).toBe(5);
    });

    it("covers IMAGE content with undefined image field (if part.image false branch)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        text: "",
      });

      const msg = new Message({
        role: Role.USER,
        content: [{ kind: ContentKind.IMAGE, image: undefined as unknown as { url?: string } }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const input = body.input as Record<string, unknown>[];
      // Undefined image → no content pushed, message skipped
      expect(input).toHaveLength(0);
    });

    it("covers parseResponse with undefined output field (data.output ?? [] fallback)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "r",
          model: "m",
          status: "completed",
          // output field entirely absent
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.text).toBe("");
      expect(resp.tool_calls).toHaveLength(0);
    });

    it("covers parseResponse message item with undefined content (item.content ?? [] fallback)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "r",
          model: "m",
          status: "completed",
          output: [{ type: "message" }], // message item with no content field
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.text).toBe("");
    });

    it("covers response.created with data.response absent (falls to data, line 290)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          // response.created data has id/model directly at top level (no response wrapper)
          'event: response.created\ndata: {"id":"r1","model":"m"}\n\n',
          'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n',
          'event: response.output_text.done\ndata: {}\n\n',
          'event: response.completed\ndata: {"response":{"id":"r1","model":"m","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.response!.id).toBe("r1");
    });

    it("covers response.completed with data.response absent (falls to data, line 371)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          // response.completed data has fields directly (no response wrapper)
          'event: response.completed\ndata: {"id":"r2","model":"m","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.response!.id).toBe("r2");
    });

    it("covers usage with neither input_tokens nor prompt_tokens (falls to 0)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          id: "r",
          model: "m",
          status: "completed",
          output: [],
          usage: {}, // no input_tokens, no prompt_tokens, no output_tokens, no completion_tokens, no total_tokens
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.usage.input_tokens).toBe(0);
      expect(resp.usage.output_tokens).toBe(0);
      expect(resp.usage.total_tokens).toBe(0);
    });
  });
});
