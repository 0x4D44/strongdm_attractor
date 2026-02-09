import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "./client.js";
import {
  ConfigurationError,
  Message,
  Role,
  ContentKind,
  Usage,
  Response,
  StreamEventType,
} from "./types.js";
import type { ProviderAdapter, Request, StreamEvent, Middleware, StreamMiddleware } from "./types.js";

function makeFakeAdapter(name: string, responseText = "hello"): ProviderAdapter {
  return {
    name,
    async complete(request: Request): Promise<Response> {
      return new Response({
        id: "resp_1",
        model: request.model,
        provider: name,
        message: Message.assistant(responseText),
        finish_reason: { reason: "stop" },
        usage: new Usage({ input_tokens: 10, output_tokens: 5 }),
      });
    },
    async *stream(request: Request): AsyncGenerator<StreamEvent> {
      yield { type: StreamEventType.STREAM_START };
      yield { type: StreamEventType.TEXT_DELTA, delta: responseText };
      yield {
        type: StreamEventType.FINISH,
        finish_reason: { reason: "stop" },
        usage: new Usage({ input_tokens: 10, output_tokens: 5 }),
        response: new Response({
          id: "resp_1",
          model: request.model,
          provider: name,
          message: Message.assistant(responseText),
          finish_reason: { reason: "stop" },
          usage: new Usage({ input_tokens: 10, output_tokens: 5 }),
        }),
      };
    },
  };
}

describe("Client", () => {
  describe("constructor", () => {
    it("creates with explicit adapters", () => {
      const client = new Client({
        providers: { openai: makeFakeAdapter("openai") },
      });
      expect(client.providerNames).toEqual(["openai"]);
    });

    it("auto-detects default provider", () => {
      const client = new Client({
        providers: { openai: makeFakeAdapter("openai") },
      });
      expect(client.defaultProvider).toBe("openai");
    });

    it("uses explicit default_provider", () => {
      const client = new Client({
        providers: {
          openai: makeFakeAdapter("openai"),
          anthropic: makeFakeAdapter("anthropic"),
        },
        default_provider: "anthropic",
      });
      expect(client.defaultProvider).toBe("anthropic");
    });

    it("creates with no providers", () => {
      const client = new Client();
      expect(client.providerNames).toEqual([]);
      expect(client.defaultProvider).toBeUndefined();
    });
  });

  describe("registerProvider()", () => {
    it("registers a new provider", () => {
      const client = new Client();
      client.registerProvider("openai", makeFakeAdapter("openai"));
      expect(client.providerNames).toContain("openai");
    });

    it("auto-sets default provider if none set", () => {
      const client = new Client();
      client.registerProvider("anthropic", makeFakeAdapter("anthropic"));
      expect(client.defaultProvider).toBe("anthropic");
    });

    it("does not override existing default provider", () => {
      const client = new Client({
        providers: { openai: makeFakeAdapter("openai") },
      });
      client.registerProvider("anthropic", makeFakeAdapter("anthropic"));
      expect(client.defaultProvider).toBe("openai");
    });
  });

  describe("complete()", () => {
    it("routes to correct adapter by provider", async () => {
      const client = new Client({
        providers: {
          openai: makeFakeAdapter("openai", "openai-response"),
          anthropic: makeFakeAdapter("anthropic", "anthropic-response"),
        },
      });

      const resp = await client.complete({
        model: "gpt-4",
        messages: [Message.user("hi")],
        provider: "anthropic",
      });
      expect(resp.text).toBe("anthropic-response");
      expect(resp.provider).toBe("anthropic");
    });

    it("uses default provider when provider omitted", async () => {
      const client = new Client({
        providers: { openai: makeFakeAdapter("openai", "default-response") },
      });

      const resp = await client.complete({
        model: "gpt-4",
        messages: [Message.user("hi")],
      });
      expect(resp.text).toBe("default-response");
    });

    it("throws ConfigurationError when no provider available", async () => {
      const client = new Client();
      await expect(
        client.complete({ model: "gpt-4", messages: [Message.user("hi")] }),
      ).rejects.toThrow(ConfigurationError);
    });

    it("throws ConfigurationError for unregistered provider", async () => {
      const client = new Client({
        providers: { openai: makeFakeAdapter("openai") },
      });
      await expect(
        client.complete({
          model: "gpt-4",
          messages: [Message.user("hi")],
          provider: "nonexistent",
        }),
      ).rejects.toThrow(ConfigurationError);
    });

    it("fills in provider name on request", async () => {
      let capturedProvider = "";
      const adapter: ProviderAdapter = {
        name: "test-provider",
        async complete(req) {
          capturedProvider = req.provider ?? "";
          return new Response({
            id: "r1",
            model: req.model,
            provider: "test-provider",
            message: Message.assistant("ok"),
            finish_reason: { reason: "stop" },
            usage: Usage.zero(),
          });
        },
        async *stream() { yield { type: StreamEventType.FINISH } as StreamEvent; },
      };
      const client = new Client({ providers: { "test-provider": adapter } });
      await client.complete({ model: "m", messages: [Message.user("hi")] });
      expect(capturedProvider).toBe("test-provider");
    });
  });

  describe("stream()", () => {
    it("routes streaming to correct adapter", async () => {
      const client = new Client({
        providers: { openai: makeFakeAdapter("openai", "streamed") },
      });

      const events: StreamEvent[] = [];
      for await (const e of client.stream({
        model: "gpt-4",
        messages: [Message.user("hi")],
        provider: "openai",
      })) {
        events.push(e);
      }

      expect(events[0].type).toBe(StreamEventType.STREAM_START);
      expect(events[1].delta).toBe("streamed");
      expect(events[2].type).toBe(StreamEventType.FINISH);
    });

    it("throws ConfigurationError for missing provider", () => {
      const client = new Client();
      expect(() =>
        client.stream({ model: "gpt-4", messages: [Message.user("hi")] }),
      ).toThrow(ConfigurationError);
    });
  });

  describe("middleware integration", () => {
    it("applies middleware to complete() calls", async () => {
      const mw: Middleware = async (req, next) => {
        const resp = await next({ ...req, temperature: 0.42 });
        return resp;
      };

      let capturedTemp: number | undefined;
      const adapter: ProviderAdapter = {
        name: "test",
        async complete(req) {
          capturedTemp = req.temperature;
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

      const client = new Client({
        providers: { test: adapter },
        middleware: [mw],
      });
      await client.complete({ model: "m", messages: [Message.user("hi")] });
      expect(capturedTemp).toBe(0.42);
    });

    it("wraps complete middleware for stream calls", async () => {
      let capturedTemp: number | undefined;
      const mw: Middleware = async (req, next) => {
        return next({ ...req, temperature: 0.99 });
      };

      const adapter: ProviderAdapter = {
        name: "test",
        async complete() {
          return new Response({
            id: "r1",
            model: "m",
            provider: "test",
            message: Message.assistant("ok"),
            finish_reason: { reason: "stop" },
            usage: Usage.zero(),
          });
        },
        async *stream(req) {
          capturedTemp = req.temperature;
          yield { type: StreamEventType.FINISH } as StreamEvent;
        },
      };

      const client = new Client({
        providers: { test: adapter },
        middleware: [mw],
      });
      for await (const _e of client.stream({ model: "m", messages: [Message.user("hi")] })) {
        // drain
      }
      expect(capturedTemp).toBe(0.99);
    });

    it("applies stream_middleware to stream calls", async () => {
      const events: string[] = [];
      const smw: StreamMiddleware = async function*(req, next) {
        events.push("before");
        yield* next(req);
        events.push("after");
      };

      const client = new Client({
        providers: { test: makeFakeAdapter("test") },
        stream_middleware: [smw],
      });

      for await (const _e of client.stream({ model: "m", messages: [Message.user("hi")] })) {
        // drain
      }
      expect(events).toContain("before");
      expect(events).toContain("after");
    });
  });

  describe("close()", () => {
    it("calls close on all adapters that have it", async () => {
      const closeFn = vi.fn();
      const adapter: ProviderAdapter = {
        name: "test",
        async complete() { return {} as Response; },
        async *stream() {},
        close: closeFn,
      };
      const client = new Client({ providers: { test: adapter } });
      await client.close();
      expect(closeFn).toHaveBeenCalledOnce();
    });

    it("works when adapters have no close method", async () => {
      const client = new Client({ providers: { test: makeFakeAdapter("test") } });
      await expect(client.close()).resolves.toBeUndefined();
    });
  });

  describe("from_env()", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("registers openai when OPENAI_API_KEY is set", () => {
      process.env.OPENAI_API_KEY = "sk-test";
      const client = Client.from_env();
      expect(client.providerNames).toContain("openai");
    });

    it("registers anthropic when ANTHROPIC_API_KEY is set", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      const client = Client.from_env();
      expect(client.providerNames).toContain("anthropic");
    });

    it("registers gemini when GEMINI_API_KEY is set", () => {
      process.env.GEMINI_API_KEY = "AIza-test";
      const client = Client.from_env();
      expect(client.providerNames).toContain("gemini");
    });

    it("registers gemini when GOOGLE_API_KEY is set", () => {
      process.env.GOOGLE_API_KEY = "AIza-test";
      const client = Client.from_env();
      expect(client.providerNames).toContain("gemini");
    });

    it("registers no providers when no env vars set", () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      const client = Client.from_env();
      expect(client.providerNames).toHaveLength(0);
    });

    it("registers multiple providers", () => {
      process.env.OPENAI_API_KEY = "sk-test";
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      const client = Client.from_env();
      expect(client.providerNames).toContain("openai");
      expect(client.providerNames).toContain("anthropic");
    });
  });
});
