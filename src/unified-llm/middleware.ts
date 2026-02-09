// ============================================================================
// Middleware — Onion/Chain-of-Responsibility Pattern
// ============================================================================

import type {
  Request,
  Response,
  StreamEvent,
  Middleware,
  StreamMiddleware,
  ProviderAdapter,
} from "./types.js";

/**
 * Builds a middleware chain for complete() calls.
 * Middleware runs in registration order for request phase,
 * reverse order for response phase (standard onion pattern).
 */
export function buildMiddlewareChain(
  middlewares: Middleware[],
  finalHandler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  let chain = finalHandler;

  // Build from right to left so the first middleware is outermost
  for (let i = middlewares.length - 1; i >= 0; i--) {
    const mw = middlewares[i];
    const next = chain;
    chain = (request: Request) => mw(request, next);
  }

  return chain;
}

/**
 * Builds a middleware chain for stream() calls.
 */
export function buildStreamMiddlewareChain(
  middlewares: StreamMiddleware[],
  finalHandler: (request: Request) => AsyncIterable<StreamEvent>,
): (request: Request) => AsyncIterable<StreamEvent> {
  let chain = finalHandler;

  for (let i = middlewares.length - 1; i >= 0; i--) {
    const mw = middlewares[i];
    const next = chain;
    chain = (request: Request) => mw(request, next);
  }

  return chain;
}

/**
 * Wraps a Middleware as a StreamMiddleware by passing through events unchanged.
 * This allows complete()-only middleware to be used on stream calls too
 * (they just pass through without modification).
 */
export function wrapMiddlewareForStream(
  middleware: Middleware,
): StreamMiddleware {
  return async function*(request: Request, next: (req: Request) => AsyncIterable<StreamEvent>) {
    // Let the middleware transform the request by capturing what it passes to next()
    let transformedRequest = request;
    const fakeNext = async (req: Request): Promise<Response> => {
      transformedRequest = req;
      return {} as Response;
    };
    try {
      await middleware(request, fakeNext);
    } catch { /* middleware may fail on dummy response — we only care about request transformation */ }
    yield* next(transformedRequest);
  };
}

/**
 * Creates a simple logging middleware for both complete and stream calls.
 */
export function createLoggingMiddleware(
  logger: (msg: string) => void = console.log,
): { complete: Middleware; stream: StreamMiddleware } {
  const complete: Middleware = async (request, next) => {
    const start = Date.now();
    logger(`[LLM] Request: provider=${request.provider ?? "default"} model=${request.model}`);
    const response = await next(request);
    const elapsed = Date.now() - start;
    logger(`[LLM] Response: tokens=${response.usage.total_tokens} latency=${elapsed}ms`);
    return response;
  };

  const stream: StreamMiddleware = (request, next) => {
    logger(`[LLM] Stream: provider=${request.provider ?? "default"} model=${request.model}`);
    return next(request);
  };

  return { complete, stream };
}
