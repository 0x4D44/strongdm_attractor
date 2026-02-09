// ============================================================================
// HTTP Client Helpers
// ============================================================================

import {
  NetworkError,
  RequestTimeoutError,
  AbortError,
  errorFromStatusCode,
} from "../types.js";
import type { RateLimitInfo } from "../types.js";

export interface HttpRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

export async function httpRequest(opts: HttpRequestOptions): Promise<HttpResponse> {
  const { url, method = "POST", headers = {}, body, timeout = 120_000, signal } = opts;

  const controller = new AbortController();
  const combinedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;

  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: combinedSignal,
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    return {
      status: response.status,
      headers: response.headers,
      body: parsed,
      text,
    };
  } catch (err: unknown) {
    if (err instanceof DOMException || (err instanceof Error && err.name === "AbortError")) {
      if (signal?.aborted) {
        throw new AbortError();
      }
      throw new RequestTimeoutError(`Request to ${url} timed out after ${timeout}ms`);
    }
    throw new NetworkError(
      `Network error requesting ${url}: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function httpStreamRequest(opts: HttpRequestOptions): Promise<{
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
}> {
  const { url, method = "POST", headers = {}, body, timeout = 120_000, signal } = opts;

  const controller = new AbortController();
  const combinedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;

  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: combinedSignal,
    });

    clearTimeout(timer);

    if (!response.body) {
      throw new NetworkError(`No response body from ${url}`);
    }

    return {
      status: response.status,
      headers: response.headers,
      body: response.body,
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof AbortError || err instanceof RequestTimeoutError || err instanceof NetworkError) {
      throw err;
    }
    if (err instanceof DOMException || (err instanceof Error && err.name === "AbortError")) {
      if (signal?.aborted) {
        throw new AbortError();
      }
      throw new RequestTimeoutError(`Stream request to ${url} timed out after ${timeout}ms`);
    }
    throw new NetworkError(
      `Network error streaming ${url}: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined,
    );
  }
}

export function raiseForStatus(
  status: number,
  headers: Headers,
  body: unknown,
  provider: string,
): void {
  if (status >= 200 && status < 300) return;

  const bodyObj = body as Record<string, unknown> | undefined;
  const errorBody = bodyObj?.error as Record<string, unknown> | undefined;
  const message =
    (errorBody?.message as string) ??
    (bodyObj?.message as string) ??
    (typeof body === "string" ? body : JSON.stringify(body));
  const errorCode =
    (errorBody?.code as string) ?? (errorBody?.type as string) ?? undefined;

  let retryAfter: number | undefined;
  const retryAfterHeader = headers.get("retry-after");
  if (retryAfterHeader) {
    retryAfter = parseFloat(retryAfterHeader);
    if (isNaN(retryAfter)) retryAfter = undefined;
  }

  throw errorFromStatusCode(
    status,
    message,
    provider,
    errorCode,
    typeof body === "object" ? (body as Record<string, unknown>) : undefined,
    retryAfter,
  );
}

export function parseRateLimitHeaders(headers: Headers): RateLimitInfo | undefined {
  const remaining = headers.get("x-ratelimit-remaining-requests");
  const limit = headers.get("x-ratelimit-limit-requests");
  const tokensRemaining = headers.get("x-ratelimit-remaining-tokens");
  const tokensLimit = headers.get("x-ratelimit-limit-tokens");
  const resetAt = headers.get("x-ratelimit-reset-requests");

  if (!remaining && !limit && !tokensRemaining && !tokensLimit) return undefined;

  return {
    requests_remaining: remaining ? parseInt(remaining, 10) : undefined,
    requests_limit: limit ? parseInt(limit, 10) : undefined,
    tokens_remaining: tokensRemaining ? parseInt(tokensRemaining, 10) : undefined,
    tokens_limit: tokensLimit ? parseInt(tokensLimit, 10) : undefined,
    reset_at: resetAt ? new Date(resetAt) : undefined,
  };
}
