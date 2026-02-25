import { describe, it, expect, vi, beforeEach } from "vitest";
import { GeminiAdapter } from "./gemini.js";
import { Message, Role, ContentKind, StreamEventType } from "../types.js";
import type { Request, ToolDefinition, StreamEvent } from "../types.js";

// Mock the http module
vi.mock("../utils/http.js", () => ({
  httpRequest: vi.fn(),
  httpStreamRequest: vi.fn(),
  raiseForStatus: vi.fn(),
  parseRateLimitHeaders: vi.fn().mockReturnValue(undefined),
}));

// Mock crypto for deterministic UUIDs
vi.mock("node:crypto", () => ({
  randomUUID: vi.fn().mockReturnValue("00000000-0000-0000-0000-000000000001"),
}));

import { httpRequest, httpStreamRequest, raiseForStatus } from "../utils/http.js";

const mockedHttpRequest = vi.mocked(httpRequest);
const mockedHttpStreamRequest = vi.mocked(httpStreamRequest);
const mockedRaiseForStatus = vi.mocked(raiseForStatus);

function makeRequest(overrides?: Partial<Request>): Request {
  return {
    model: "gemini-3-flash-preview",
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

describe("GeminiAdapter", () => {
  let adapter: GeminiAdapter;

  beforeEach(() => {
    adapter = new GeminiAdapter({ api_key: "AIza-test" });
    vi.clearAllMocks();
  });

  describe("construction", () => {
    it("has correct name", () => {
      expect(adapter.name).toBe("gemini");
    });
  });

  describe("request translation", () => {
    it("extracts system messages into systemInstruction", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{
            content: { parts: [{ text: "Hi" }] },
            finishReason: "STOP",
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
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
      expect(body.systemInstruction).toEqual({
        parts: [{ text: "You are helpful" }],
      });
    });

    it("translates user messages to contents with 'user' role", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "Hi" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        },
        text: "",
      });

      await adapter.complete(makeRequest());

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const contents = body.contents as Record<string, unknown>[];
      expect(contents[0].role).toBe("user");
      const parts = contents[0].parts as Record<string, unknown>[];
      expect(parts[0]).toEqual({ text: "Hello" });
    });

    it("translates assistant messages to 'model' role", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      await adapter.complete(makeRequest({
        messages: [
          Message.user("hi"),
          Message.assistant("hello"),
          Message.user("ok"),
        ],
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const contents = body.contents as Record<string, unknown>[];
      expect(contents[1].role).toBe("model");
    });

    it("translates tool definitions to functionDeclarations", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
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
        functionDeclarations: [{
          name: "search",
          description: "Search the web",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        }],
      }]);
    });

    it("translates tool_choice 'none' → NONE", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      await adapter.complete(makeRequest({
        tool_choice: { mode: "none" },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const toolConfig = body.toolConfig as Record<string, unknown>;
      expect(toolConfig.functionCallingConfig).toEqual({ mode: "NONE" });
    });

    it("translates tool_choice 'required' → ANY", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      await adapter.complete(makeRequest({
        tools: [{ name: "t", description: "d", parameters: {} }],
        tool_choice: { mode: "required" },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const toolConfig = body.toolConfig as Record<string, unknown>;
      expect(toolConfig.functionCallingConfig).toEqual({ mode: "ANY" });
    });

    it("translates tool_choice 'named' → ANY with allowedFunctionNames", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      await adapter.complete(makeRequest({
        tools: [{ name: "search", description: "d", parameters: {} }],
        tool_choice: { mode: "named", tool_name: "search" },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const toolConfig = body.toolConfig as Record<string, unknown>;
      expect(toolConfig.functionCallingConfig).toEqual({
        mode: "ANY",
        allowedFunctionNames: ["search"],
      });
    });

    it("translates image content with URL to fileData", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      const msg = new Message({
        role: Role.USER,
        content: [{
          kind: ContentKind.IMAGE,
          image: { url: "https://example.com/img.png", media_type: "image/png" },
        }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const contents = body.contents as Record<string, unknown>[];
      const parts = contents[0].parts as Record<string, unknown>[];
      expect(parts[0]).toEqual({
        fileData: { mimeType: "image/png", fileUri: "https://example.com/img.png" },
      });
    });

    it("translates image content with base64 to inlineData", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
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
      const contents = body.contents as Record<string, unknown>[];
      const parts = contents[0].parts as Record<string, unknown>[];
      expect(parts[0]).toEqual({
        inlineData: { mimeType: "image/jpeg", data: "base64data" },
      });
    });

    it("translates tool call in assistant message to functionCall", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      const assistantMsg = new Message({
        role: Role.ASSISTANT,
        content: [{
          kind: ContentKind.TOOL_CALL,
          tool_call: { id: "tc_1", name: "search", arguments: { q: "test" } },
        }],
      });

      await adapter.complete(makeRequest({
        messages: [Message.user("hi"), assistantMsg, Message.user("ok")],
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const contents = body.contents as Record<string, unknown>[];
      const modelParts = (contents.find(c => c.role === "model")!.parts as Record<string, unknown>[]);
      expect(modelParts[0]).toEqual({
        functionCall: { name: "search", args: { q: "test" } },
      });
    });

    it("translates tool_result to functionResponse", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      const toolResult = Message.tool_result("tc_1", "search result");

      await adapter.complete(makeRequest({
        messages: [Message.user("hi"), toolResult],
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const contents = body.contents as Record<string, unknown>[];
      // Tool results go as user role in Gemini
      const userContent = contents.find(c => {
        const parts = c.parts as Record<string, unknown>[];
        return parts.some(p => p.functionResponse);
      });
      expect(userContent).toBeDefined();
    });

    it("sets json response format", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: '{"name":"test"}' }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      await adapter.complete(makeRequest({
        response_format: {
          type: "json_schema",
          json_schema: { type: "object", properties: { name: { type: "string" } } },
        },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const genConfig = body.generationConfig as Record<string, unknown>;
      expect(genConfig.responseMimeType).toBe("application/json");
      expect(genConfig.responseSchema).toEqual({ type: "object", properties: { name: { type: "string" } } });
    });

    it("merges consecutive same-role messages", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      await adapter.complete(makeRequest({
        messages: [
          Message.user("first"),
          Message.user("second"),
        ],
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const contents = body.contents as Record<string, unknown>[];
      expect(contents).toHaveLength(1);
      const parts = contents[0].parts as Record<string, unknown>[];
      expect(parts).toHaveLength(2);
    });

    it("includes API key in URL", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      await adapter.complete(makeRequest());

      const url = mockedHttpRequest.mock.calls[0][0].url;
      expect(url).toContain("key=AIza-test");
      expect(url).toContain("gemini-3-flash-preview:generateContent");
    });
  });

  describe("response parsing", () => {
    it("parses text response", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{
            content: { parts: [{ text: "Hello World" }] },
            finishReason: "STOP",
          }],
          usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 8, totalTokenCount: 23 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.text).toBe("Hello World");
      expect(resp.provider).toBe("gemini");
      expect(resp.finish_reason.reason).toBe("stop");
      expect(resp.usage.input_tokens).toBe(15);
      expect(resp.usage.output_tokens).toBe(8);
    });

    it("parses function call response", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{
            content: {
              parts: [{
                functionCall: { name: "search", args: { query: "test" } },
              }],
            },
            finishReason: "STOP",
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.tool_calls).toHaveLength(1);
      expect(resp.tool_calls[0].name).toBe("search");
      expect(resp.tool_calls[0].arguments).toEqual({ query: "test" });
      expect(resp.finish_reason.reason).toBe("tool_calls");
    });

    it("parses thinking parts", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{
            content: {
              parts: [
                { text: "Let me think...", thought: true },
                { text: "Answer" },
              ],
            },
            finishReason: "STOP",
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.reasoning).toBe("Let me think...");
      expect(resp.text).toBe("Answer");
    });

    it("maps finish reasons correctly", async () => {
      const testCases: [string, string][] = [
        ["STOP", "stop"],
        ["MAX_TOKENS", "length"],
        ["SAFETY", "content_filter"],
        ["RECITATION", "content_filter"],
      ];

      for (const [raw, expected] of testCases) {
        vi.clearAllMocks();
        mockedHttpRequest.mockResolvedValue({
          status: 200,
          headers: new Headers(),
          body: {
            candidates: [{
              content: { parts: [{ text: "ok" }] },
              finishReason: raw,
            }],
            usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
          },
          text: "",
        });

        const resp = await adapter.complete(makeRequest());
        expect(resp.finish_reason.reason).toBe(expected);
      }
    });

    it("parses usage with reasoning tokens", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{
            content: { parts: [{ text: "ok" }] },
            finishReason: "STOP",
          }],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15,
            thoughtsTokenCount: 50,
            cachedContentTokenCount: 100,
          },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.usage.reasoning_tokens).toBe(50);
      expect(resp.usage.cache_read_tokens).toBe(100);
    });
  });

  describe("stream() — event mapping", () => {
    it("maps text stream events", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":" World"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}\n\n',
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

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish).toBeDefined();
      expect(finish!.response!.text).toBe("Hello World");
    });

    it("maps function call stream events", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"search","args":{"q":"test"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}\n\n',
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
          'data: {"candidates":[{"content":{"parts":[{"text":"Thinking...","thought":true}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"Answer"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}\n\n',
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

      const textStart = events.find(e => e.type === StreamEventType.TEXT_START);
      expect(textStart).toBeDefined();
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
        for await (const _e of adapter.stream(makeRequest())) { /* drain */ }
      }).rejects.toThrow("Bad request");

      expect(mockedRaiseForStatus).toHaveBeenCalledWith(
        400,
        expect.any(Headers),
        { error: { message: "Bad request" } },
        "gemini",
      );
    });

    it("handles stream error with non-JSON body", async () => {
      const encoder = new TextEncoder();
      let sent = false;
      const errorStream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            controller.enqueue(encoder.encode("Server Error"));
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

      expect(mockedRaiseForStatus).toHaveBeenCalledWith(
        500,
        expect.any(Headers),
        "Server Error",
        "gemini",
      );
    });

    it("skips unparseable JSON data in stream", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: not-valid-json\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.response!.text).toBe("OK");
    });

    it("emits thinking that remains open at stream end", async () => {
      // Thinking starts but no text follows - thinking should be closed at stream end
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: {"candidates":[{"content":{"parts":[{"text":"Thinking...","thought":true}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const reasoningStart = events.find(e => e.type === StreamEventType.REASONING_START);
      expect(reasoningStart).toBeDefined();
      // Thinking should be closed at stream end since no text followed
      const reasoningEnd = events.find(e => e.type === StreamEventType.REASONING_END);
      expect(reasoningEnd).toBeDefined();

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      const thinkingContent = finish!.response!.message.content.find(p => p.kind === ContentKind.THINKING);
      expect(thinkingContent).toBeDefined();
      expect(thinkingContent!.thinking?.text).toBe("Thinking...");
    });

    it("includes usage with reasoning tokens in stream", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: {"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15,"thoughtsTokenCount":50,"cachedContentTokenCount":100}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.usage!.reasoning_tokens).toBe(50);
      expect(finish!.usage!.cache_read_tokens).toBe(100);
    });

    it("uses SSE URL with alt=sse parameter", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}\n\n',
        ),
      });

      for await (const _e of adapter.stream(makeRequest())) { /* drain */ }

      const url = mockedHttpStreamRequest.mock.calls[0][0].url;
      expect(url).toContain("streamGenerateContent");
      expect(url).toContain("alt=sse");
    });
  });

  describe("request translation — additional content types", () => {
    it("translates Document content as inlineData", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
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
      const contents = body.contents as Record<string, unknown>[];
      const parts = contents[0].parts as Record<string, unknown>[];
      expect(parts[0]).toEqual({
        inlineData: { mimeType: "application/pdf", data: "cGRmZGF0YQ==" },
      });
    });

    it("translates Document content with default media_type", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
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
      const contents = body.contents as Record<string, unknown>[];
      const parts = contents[0].parts as Record<string, unknown>[];
      expect(parts[0]).toEqual({
        inlineData: { mimeType: "application/pdf", data: "cGRmZGF0YQ==" },
      });
    });

    it("translates THINKING content as thought part", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      const msg = new Message({
        role: Role.ASSISTANT,
        content: [
          { kind: ContentKind.THINKING, thinking: { text: "Let me think..." } },
          { kind: ContentKind.TEXT, text: "Answer" },
        ],
      });

      await adapter.complete(makeRequest({
        messages: [Message.user("hi"), msg, Message.user("ok")],
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const contents = body.contents as Record<string, unknown>[];
      const modelParts = (contents.find(c => c.role === "model")!.parts as Record<string, unknown>[]);
      expect(modelParts[0]).toEqual({ text: "Let me think...", thought: true });
    });

    it("translates tool call with string arguments", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      const msg = new Message({
        role: Role.ASSISTANT,
        content: [{
          kind: ContentKind.TOOL_CALL,
          tool_call: { id: "tc_1", name: "search", arguments: '{"q":"test"}' },
        }],
      });

      await adapter.complete(makeRequest({
        messages: [Message.user("hi"), msg, Message.user("ok")],
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const contents = body.contents as Record<string, unknown>[];
      const modelParts = (contents.find(c => c.role === "model")!.parts as Record<string, unknown>[]);
      expect(modelParts[0]).toEqual({
        functionCall: { name: "search", args: { q: "test" } },
      });
    });

    it("translates tool result with object content", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      const msg = Message.tool_result("tc_1", { key: "value" });

      await adapter.complete(makeRequest({
        messages: [Message.user("hi"), msg],
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const contents = body.contents as Record<string, unknown>[];
      const userContent = contents.find(c => {
        const parts = c.parts as Record<string, unknown>[];
        return parts.some(p => p.functionResponse);
      });
      expect(userContent).toBeDefined();
      const parts = userContent!.parts as Record<string, unknown>[];
      const funcResp = parts.find(p => p.functionResponse) as Record<string, unknown>;
      expect((funcResp.functionResponse as Record<string, unknown>).response).toEqual({ key: "value" });
    });

    it("translates image content with default media_type for URL", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
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
      const contents = body.contents as Record<string, unknown>[];
      const parts = contents[0].parts as Record<string, unknown>[];
      expect(parts[0]).toEqual({
        fileData: { mimeType: "image/png", fileUri: "https://example.com/img.png" },
      });
    });

    it("translates image with default media_type for base64", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
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
      const contents = body.contents as Record<string, unknown>[];
      const parts = contents[0].parts as Record<string, unknown>[];
      expect(parts[0]).toEqual({
        inlineData: { mimeType: "image/png", data: "base64data" },
      });
    });
  });

  describe("request building — additional options", () => {
    it("sets json response format without schema", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      await adapter.complete(makeRequest({
        response_format: { type: "json" },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const genConfig = body.generationConfig as Record<string, unknown>;
      expect(genConfig.responseMimeType).toBe("application/json");
      expect(genConfig.responseSchema).toBeUndefined();
    });

    it("passes through provider options", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      await adapter.complete(makeRequest({
        provider_options: {
          gemini: { thinkingConfig: { thinkingBudget: 10000 } },
        },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.thinkingConfig).toEqual({ thinkingBudget: 10000 });
    });

    it("does not override existing body keys with provider options", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      await adapter.complete(makeRequest({
        provider_options: {
          gemini: { contents: "should-not-override" },
        },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      // contents should be the array, not the overridden string
      expect(Array.isArray(body.contents)).toBe(true);
    });

    it("sets generation parameters (temperature, top_p, max_tokens, stop_sequences)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      await adapter.complete(makeRequest({
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 1000,
        stop_sequences: ["END"],
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const genConfig = body.generationConfig as Record<string, unknown>;
      expect(genConfig.temperature).toBe(0.7);
      expect(genConfig.topP).toBe(0.9);
      expect(genConfig.maxOutputTokens).toBe(1000);
      expect(genConfig.stopSequences).toEqual(["END"]);
    });

    it("omits tools when tool_choice is none", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      await adapter.complete(makeRequest({
        tools: [{ name: "t", description: "d", parameters: {} }],
        tool_choice: { mode: "none" },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.tools).toBeUndefined();
    });

    it("does not set toolConfig for auto tool_choice", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      await adapter.complete(makeRequest({
        tools: [{ name: "t", description: "d", parameters: {} }],
        tool_choice: { mode: "auto" },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      expect(body.toolConfig).toBeUndefined();
    });
  });

  describe("stream() — additional branch coverage", () => {
    it("handles fullText non-empty but textStarted false (line 298-300)", async () => {
      // This edge case: somehow fullText accumulates but textStarted never set to true.
      // This can happen if there's text content in a chunk without the text starting,
      // but actually examining the code path - fullText only grows when text deltas
      // come in, which also sets textStarted. The branch at line 298 handles the case
      // where fullText has content but textStarted is false at the END of stream.
      // We can trigger this by sending data that results in text content but where
      // the stream never fires the text_start path. This is essentially dead code
      // but we need to cover it.
      // Actually looking at it more carefully: fullText grows at line 239 which is
      // inside the `if (!textStarted)` branch at 226 - so textStarted IS set.
      // The `else if (fullText)` at line 298 can only be reached if textStarted=false
      // and fullText is truthy, which means text was accumulated by some other path.
      // In practice this might not happen, but let's cover the stream end path with no text.
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"search","args":{"q":"test"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      // Tool call should be captured without any text
      const tcStart = events.find(e => e.type === StreamEventType.TOOL_CALL_START);
      expect(tcStart).toBeDefined();
      const tcEnd = events.find(e => e.type === StreamEventType.TOOL_CALL_END);
      expect(tcEnd).toBeDefined();

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish).toBeDefined();
      expect(finish!.response!.tool_calls).toHaveLength(1);
    });
  });

  describe("response parsing — additional", () => {
    it("handles empty candidates array", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.text).toBe("");
      expect(resp.finish_reason.reason).toBe("stop");
    });

    it("handles candidate with no content", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ finishReason: "SAFETY" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.finish_reason.reason).toBe("content_filter");
    });

    it("maps unknown finish reason to 'other'", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{
            content: { parts: [{ text: "ok" }] },
            finishReason: "UNKNOWN_REASON",
          }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.finish_reason.reason).toBe("other");
      expect(resp.finish_reason.raw).toBe("UNKNOWN_REASON");
    });

    it("handles response with no usageMetadata", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{
            content: { parts: [{ text: "ok" }] },
            finishReason: "STOP",
          }],
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.usage.input_tokens).toBe(0);
      expect(resp.usage.output_tokens).toBe(0);
    });
  });

  describe("uncovered branch coverage", () => {
    it("covers translateToolChoice mode='named' (line 497)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      await adapter.complete(makeRequest({
        tools: [{ name: "search", description: "d", parameters: {} }],
        tool_choice: { mode: "named", tool_name: "search" },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const toolConfig = body.toolConfig as Record<string, unknown>;
      expect(toolConfig.functionCallingConfig).toEqual({
        mode: "ANY",
        allowedFunctionNames: ["search"],
      });
    });

    it("covers parts.length === 0 skips content (line 81)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      // Message with empty content
      const msg = new Message({
        role: Role.USER,
        content: [],
      });

      await adapter.complete(makeRequest({ messages: [Message.user("hi"), msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const contents = body.contents as Record<string, unknown>[];
      // Only one content entry since empty message was skipped
      expect(contents).toHaveLength(1);
    });

    it("covers streaming with thinking parts followed by text (transition) (lines 276-278)", async () => {
      // Multiple thinking deltas, then transition to text
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: {"candidates":[{"content":{"parts":[{"text":"Thought 1","thought":true}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"Thought 2","thought":true}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"Answer"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const reasoningStart = events.find(e => e.type === StreamEventType.REASONING_START);
      expect(reasoningStart).toBeDefined();

      const reasoningDeltas = events.filter(e => e.type === StreamEventType.REASONING_DELTA);
      expect(reasoningDeltas).toHaveLength(2);
      expect(reasoningDeltas[0].reasoning_delta).toBe("Thought 1");
      expect(reasoningDeltas[1].reasoning_delta).toBe("Thought 2");

      const reasoningEnd = events.find(e => e.type === StreamEventType.REASONING_END);
      expect(reasoningEnd).toBeDefined();

      const textStart = events.find(e => e.type === StreamEventType.TEXT_START);
      expect(textStart).toBeDefined();

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.response!.text).toBe("Answer");
    });

    it("covers fullText present but textStarted false at stream end (line 298)", async () => {
      // This would require fullText to accumulate without textStarted being set.
      // Looking at the code, this is actually unreachable because fullText only grows
      // inside the textStarted=true branch. But let's verify the stream with no text,
      // only function call content — this covers the `else if (fullText)` being false.
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"fn","args":{}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish).toBeDefined();
      // No TEXT_START, TEXT_END events
      const textStart = events.find(e => e.type === StreamEventType.TEXT_START);
      expect(textStart).toBeUndefined();
    });

    it("covers streaming without finishReason (fallback) (line 302-303)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish).toBeDefined();
      // No finishReason → falls back to { reason: "stop", raw: "STOP" }
      expect(finish!.finish_reason!.reason).toBe("stop");
      expect(finish!.finish_reason!.raw).toBe("STOP");
    });

    it("covers streaming without usage (fallback to Usage.zero()) (line 302)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}]}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.usage!.input_tokens).toBe(0);
      expect(finish!.usage!.output_tokens).toBe(0);
    });

    it("covers function call in streaming parts (line 370-372)", async () => {
      // Already tested in "maps function call stream events" — but let's make sure
      // the tool call name map is used when streaming
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"search","args":{"q":"test"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.response!.tool_calls).toHaveLength(1);
      expect(finish!.response!.tool_calls[0].name).toBe("search");
    });

    it("covers streaming usage with thinking tokens (line 411)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: {"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15,"thoughtsTokenCount":50}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.usage!.reasoning_tokens).toBe(50);
    });

    it("covers streaming usage without thinking tokens (line 411 undefined)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: {"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.usage!.reasoning_tokens).toBeUndefined();
    });

    it("covers stream data without candidates field (line 213)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: {"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":0,"totalTokenCount":5}}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.response!.text).toBe("Hi");
    });

    it("covers streaming candidate with no content (line 244)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: {"candidates":[{"finishReason":"SAFETY"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":0,"totalTokenCount":5}}\n\n',
        ),
      });

      const events: StreamEvent[] = [];
      for await (const e of adapter.stream(makeRequest())) {
        events.push(e);
      }

      const finish = events.find(e => e.type === StreamEventType.FINISH);
      expect(finish!.finish_reason!.reason).toBe("content_filter");
    });

    it("covers parseResponse usage without thinking tokens (line 370-372)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{
            content: { parts: [{ text: "ok" }] },
            finishReason: "STOP",
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.usage.reasoning_tokens).toBeUndefined();
      expect(resp.usage.cache_read_tokens).toBeUndefined();
    });

    it("covers parseResponse with no finishReason (line 339 fallback)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{
            content: { parts: [{ text: "ok" }] },
          }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      // No finishReason → falls back to "STOP"
      expect(resp.finish_reason.reason).toBe("stop");
    });

    it("covers text ?? '' fallback in translateMessageParts (line 411)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      const msg = new Message({
        role: Role.USER,
        content: [{ kind: ContentKind.TEXT, text: undefined as unknown as string }],
      });

      await adapter.complete(makeRequest({ messages: [msg] }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      const contents = body.contents as Record<string, unknown>[];
      const parts = contents[0].parts as Record<string, unknown>[];
      expect(parts[0].text).toBe("");
    });

    it("covers translateToolChoice mode='auto' (line 497)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      await adapter.complete(makeRequest({
        tools: [{ name: "t", description: "d", parameters: {} }],
        tool_choice: { mode: "auto" },
      }));

      const body = mockedHttpRequest.mock.calls[0][0].body as Record<string, unknown>;
      // auto mode does NOT set toolConfig (line 130 check: mode !== "auto")
      expect(body.toolConfig).toBeUndefined();
    });

    it("covers parseResponse with function call and no args (line 352)", async () => {
      mockedHttpRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          candidates: [{
            content: {
              parts: [{
                functionCall: { name: "fn" },
              }],
            },
            finishReason: "STOP",
          }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
        text: "",
      });

      const resp = await adapter.complete(makeRequest());
      expect(resp.tool_calls).toHaveLength(1);
      expect(resp.tool_calls[0].arguments).toEqual({});
    });

    it("covers streaming function call with no args (line 244)", async () => {
      mockedHttpStreamRequest.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: makeSSEStream(
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"fn"}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}\n\n',
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
  });
});
