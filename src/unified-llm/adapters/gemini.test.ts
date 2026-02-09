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

import { httpRequest, httpStreamRequest } from "../utils/http.js";

const mockedHttpRequest = vi.mocked(httpRequest);
const mockedHttpStreamRequest = vi.mocked(httpStreamRequest);

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
  });
});
