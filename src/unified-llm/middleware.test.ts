import { describe, it, expect, vi } from "vitest";
import {
  buildMiddlewareChain,
  buildStreamMiddlewareChain,
  wrapMiddlewareForStream,
  createLoggingMiddleware,
} from "./middleware.js";
import type { Middleware, StreamMiddleware } from "./types.js";
import { Message, Role, ContentKind, Usage, Response, StreamEventType } from "./types.js";
import type { Request, StreamEvent } from "./types.js";

function makeRequest(overrides?: Partial<Request>): Request {
  return {
    model: "test-model",
    messages: [Message.user("hello")],
    ...overrides,
  };
}

function makeResponse(text = "response"): Response {
  return new Response({
    id: "resp_1",
    model: "test-model",
    provider: "test",
    message: Message.assistant(text),
    finish_reason: { reason: "stop" },
    usage: new Usage({ input_tokens: 10, output_tokens: 20 }),
  });
}

describe("buildMiddlewareChain()", () => {
  it("passes through with empty middleware list", async () => {
    const resp = makeResponse();
    const handler = buildMiddlewareChain([], async () => resp);
    const result = await handler(makeRequest());
    expect(result).toBe(resp);
  });

  it("middleware can modify request before passing to next", async () => {
    const mw: Middleware = async (req, next) => {
      return next({ ...req, model: "modified-model" });
    };
    let capturedModel = "";
    const handler = buildMiddlewareChain([mw], async (req) => {
      capturedModel = req.model;
      return makeResponse();
    });
    await handler(makeRequest());
    expect(capturedModel).toBe("modified-model");
  });

  it("middleware can modify response after calling next", async () => {
    const mw: Middleware = async (req, next) => {
      const resp = await next(req);
      return new Response({
        ...resp,
        id: "modified_id",
        message: resp.message,
        finish_reason: resp.finish_reason,
        usage: resp.usage,
      });
    };
    const handler = buildMiddlewareChain([mw], async () => makeResponse());
    const result = await handler(makeRequest());
    expect(result.id).toBe("modified_id");
  });

  it("runs middleware in registration order (first = outermost)", async () => {
    const order: string[] = [];
    const mw1: Middleware = async (req, next) => {
      order.push("mw1-before");
      const resp = await next(req);
      order.push("mw1-after");
      return resp;
    };
    const mw2: Middleware = async (req, next) => {
      order.push("mw2-before");
      const resp = await next(req);
      order.push("mw2-after");
      return resp;
    };
    const handler = buildMiddlewareChain([mw1, mw2], async () => {
      order.push("handler");
      return makeResponse();
    });
    await handler(makeRequest());
    expect(order).toEqual(["mw1-before", "mw2-before", "handler", "mw2-after", "mw1-after"]);
  });

  it("three middleware compose correctly", async () => {
    const tags: string[] = [];
    const makeMw = (tag: string): Middleware => async (req, next) => {
      tags.push(`${tag}-req`);
      const resp = await next(req);
      tags.push(`${tag}-resp`);
      return resp;
    };

    const handler = buildMiddlewareChain(
      [makeMw("a"), makeMw("b"), makeMw("c")],
      async () => {
        tags.push("handler");
        return makeResponse();
      },
    );
    await handler(makeRequest());
    expect(tags).toEqual(["a-req", "b-req", "c-req", "handler", "c-resp", "b-resp", "a-resp"]);
  });
});

describe("buildStreamMiddlewareChain()", () => {
  it("passes through with empty middleware list", async () => {
    const events: StreamEvent[] = [
      { type: StreamEventType.STREAM_START },
      { type: StreamEventType.TEXT_DELTA, delta: "hi" },
      { type: StreamEventType.FINISH },
    ];
    async function* gen() { yield* events; }
    const handler = buildStreamMiddlewareChain([], () => gen());

    const collected: StreamEvent[] = [];
    for await (const e of handler(makeRequest())) {
      collected.push(e);
    }
    expect(collected).toHaveLength(3);
    expect(collected[1].delta).toBe("hi");
  });

  it("stream middleware can modify request", async () => {
    let capturedModel = "";
    const mw: StreamMiddleware = async function*(req, next) {
      yield* next({ ...req, model: "stream-modified" });
    };
    async function* gen(req: Request) {
      capturedModel = req.model;
      yield { type: StreamEventType.FINISH } as StreamEvent;
    }

    const handler = buildStreamMiddlewareChain([mw], gen);
    const collected: StreamEvent[] = [];
    for await (const e of handler(makeRequest())) {
      collected.push(e);
    }
    expect(capturedModel).toBe("stream-modified");
  });
});

describe("wrapMiddlewareForStream()", () => {
  it("wraps a request-modifying middleware to work with streams", async () => {
    const mw: Middleware = async (req, next) => {
      return next({ ...req, temperature: 0.5 });
    };

    const wrapped = wrapMiddlewareForStream(mw);

    let capturedTemp: number | undefined;
    async function* gen(req: Request) {
      capturedTemp = req.temperature;
      yield { type: StreamEventType.FINISH } as StreamEvent;
    }

    const handler = buildStreamMiddlewareChain([wrapped], gen);
    for await (const _e of handler(makeRequest())) { /* drain */ }
    expect(capturedTemp).toBe(0.5);
  });

  it("passes through events unchanged", async () => {
    const mw: Middleware = async (req, next) => next(req);
    const wrapped = wrapMiddlewareForStream(mw);

    const events: StreamEvent[] = [
      { type: StreamEventType.TEXT_DELTA, delta: "hello" },
      { type: StreamEventType.FINISH },
    ];
    async function* gen() { yield* events; }

    const handler = buildStreamMiddlewareChain([wrapped], gen);
    const collected: StreamEvent[] = [];
    for await (const e of handler(makeRequest())) {
      collected.push(e);
    }
    expect(collected).toHaveLength(2);
    expect(collected[0].delta).toBe("hello");
  });
});

describe("createLoggingMiddleware()", () => {
  it("logs request and response", async () => {
    const logs: string[] = [];
    const { complete } = createLoggingMiddleware((msg) => logs.push(msg));

    const handler = buildMiddlewareChain([complete], async () => makeResponse());
    await handler(makeRequest({ provider: "openai" }));

    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("Request");
    expect(logs[0]).toContain("openai");
    expect(logs[1]).toContain("Response");
    expect(logs[1]).toContain("tokens=");
  });

  it("stream middleware logs and passes through", async () => {
    const logs: string[] = [];
    const { stream } = createLoggingMiddleware((msg) => logs.push(msg));

    async function* gen() {
      yield { type: StreamEventType.FINISH } as StreamEvent;
    }

    const handler = buildStreamMiddlewareChain([stream], gen);
    const collected: StreamEvent[] = [];
    for await (const e of handler(makeRequest({ provider: "anthropic" }))) {
      collected.push(e);
    }
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Stream");
    expect(collected).toHaveLength(1);
  });
});
