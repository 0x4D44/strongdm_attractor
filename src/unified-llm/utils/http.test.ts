import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { httpRequest, httpStreamRequest, raiseForStatus, parseRateLimitHeaders } from './http.js';
import {
  NetworkError,
  RequestTimeoutError,
  AbortError,
  AuthenticationError,
  RateLimitError,
  ServerError,
  InvalidRequestError,
  NotFoundError,
  ContextLengthError,
  ContentFilterError,
} from '../types.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

// ---------------------------------------------------------------------------
// httpRequest
// ---------------------------------------------------------------------------

describe('httpRequest', () => {
  it('makes a POST request with JSON body and parses JSON response', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve('{"result":"ok"}'),
    });

    const resp = await httpRequest({
      url: 'https://api.example.com/v1/chat',
      body: { prompt: 'hello' },
    });

    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ result: 'ok' });
    expect(resp.text).toBe('{"result":"ok"}');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat',
      expect.objectContaining({
        method: 'POST',
        body: '{"prompt":"hello"}',
      }),
    );
  });

  it('uses GET method when specified', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: () => Promise.resolve('plain text'),
    });

    const resp = await httpRequest({
      url: 'https://api.example.com/health',
      method: 'GET',
    });

    expect(resp.status).toBe(200);
    expect(resp.body).toBe('plain text'); // non-JSON falls back to text
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/health',
      expect.objectContaining({ method: 'GET', body: undefined }),
    );
  });

  it('does not send body when body is null', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: () => Promise.resolve('ok'),
    });

    await httpRequest({ url: 'https://api.example.com/ping' });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: undefined }),
    );
  });

  it('merges custom headers with Content-Type', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: () => Promise.resolve('ok'),
    });

    await httpRequest({
      url: 'https://api.example.com/v1/chat',
      headers: { Authorization: 'Bearer sk-test', 'X-Custom': 'val' },
    });

    const callHeaders = mockFetch.mock.calls[0][1].headers;
    expect(callHeaders['Content-Type']).toBe('application/json');
    expect(callHeaders['Authorization']).toBe('Bearer sk-test');
    expect(callHeaders['X-Custom']).toBe('val');
  });

  it('returns parsed body when response is valid JSON', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: () => Promise.resolve('{"a":1}'),
    });

    const resp = await httpRequest({ url: 'https://example.com' });
    expect(resp.body).toEqual({ a: 1 });
  });

  it('returns text as body when response is not valid JSON', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: () => Promise.resolve('not-json'),
    });

    const resp = await httpRequest({ url: 'https://example.com' });
    expect(resp.body).toBe('not-json');
  });

  it('throws RequestTimeoutError when request times out (no external signal)', async () => {
    mockFetch.mockImplementation(() => {
      const err = new DOMException('The operation was aborted', 'AbortError');
      return Promise.reject(err);
    });

    await expect(
      httpRequest({ url: 'https://slow.example.com', timeout: 100 }),
    ).rejects.toThrow(RequestTimeoutError);
  });

  it('throws AbortError when external signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    mockFetch.mockImplementation(() => {
      const err = new DOMException('The operation was aborted', 'AbortError');
      return Promise.reject(err);
    });

    await expect(
      httpRequest({ url: 'https://example.com', signal: controller.signal }),
    ).rejects.toThrow(AbortError);
  });

  it('throws NetworkError on fetch failure (non-abort)', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(
      httpRequest({ url: 'https://unreachable.example.com' }),
    ).rejects.toThrow(NetworkError);
  });

  it('throws NetworkError with cause when error is Error instance', async () => {
    const cause = new TypeError('connection refused');
    mockFetch.mockRejectedValue(cause);

    try {
      await httpRequest({ url: 'https://unreachable.example.com' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).cause).toBe(cause);
    }
  });

  it('handles non-Error thrown values in NetworkError', async () => {
    mockFetch.mockRejectedValue('string error');

    await expect(
      httpRequest({ url: 'https://example.com' }),
    ).rejects.toThrow(NetworkError);
  });

  it('combines external signal with internal timeout using AbortSignal.any', async () => {
    const controller = new AbortController();
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: () => Promise.resolve('ok'),
    });

    await httpRequest({
      url: 'https://example.com',
      signal: controller.signal,
      timeout: 30000,
    });

    // Verify the signal passed to fetch is a combined signal
    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[1].signal).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// httpStreamRequest
// ---------------------------------------------------------------------------

describe('httpStreamRequest', () => {
  it('returns stream body on success', async () => {
    const fakeStream = new ReadableStream();
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: fakeStream,
    });

    const resp = await httpStreamRequest({
      url: 'https://api.example.com/v1/stream',
      body: { prompt: 'hello' },
    });

    expect(resp.status).toBe(200);
    expect(resp.body).toBe(fakeStream);
  });

  it('throws NetworkError when response has no body', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: null,
    });

    await expect(
      httpStreamRequest({ url: 'https://api.example.com/v1/stream' }),
    ).rejects.toThrow(NetworkError);
  });

  it('throws RequestTimeoutError when stream request times out', async () => {
    mockFetch.mockImplementation(() => {
      const err = new DOMException('The operation was aborted', 'AbortError');
      return Promise.reject(err);
    });

    await expect(
      httpStreamRequest({ url: 'https://slow.example.com', timeout: 100 }),
    ).rejects.toThrow(RequestTimeoutError);
  });

  it('throws AbortError when external signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    mockFetch.mockImplementation(() => {
      const err = new DOMException('The operation was aborted', 'AbortError');
      return Promise.reject(err);
    });

    await expect(
      httpStreamRequest({
        url: 'https://example.com',
        signal: controller.signal,
      }),
    ).rejects.toThrow(AbortError);
  });

  it('throws NetworkError on fetch failure (non-abort)', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(
      httpStreamRequest({ url: 'https://unreachable.example.com' }),
    ).rejects.toThrow(NetworkError);
  });

  it('re-throws known error types without wrapping', async () => {
    mockFetch.mockRejectedValue(new AbortError());

    await expect(
      httpStreamRequest({ url: 'https://example.com' }),
    ).rejects.toThrow(AbortError);
  });

  it('re-throws RequestTimeoutError without wrapping', async () => {
    mockFetch.mockRejectedValue(new RequestTimeoutError('custom timeout'));

    await expect(
      httpStreamRequest({ url: 'https://example.com' }),
    ).rejects.toThrow(RequestTimeoutError);
  });

  it('re-throws NetworkError without wrapping', async () => {
    mockFetch.mockRejectedValue(new NetworkError('already network'));

    await expect(
      httpStreamRequest({ url: 'https://example.com' }),
    ).rejects.toThrow(NetworkError);
  });

  it('does not send body when body is null', async () => {
    const fakeStream = new ReadableStream();
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: fakeStream,
    });

    await httpStreamRequest({ url: 'https://example.com' });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: undefined }),
    );
  });
});

// ---------------------------------------------------------------------------
// raiseForStatus
// ---------------------------------------------------------------------------

describe('raiseForStatus', () => {
  it('does nothing for 2xx status codes', () => {
    expect(() =>
      raiseForStatus(200, new Headers(), { ok: true }, 'openai'),
    ).not.toThrow();
    expect(() =>
      raiseForStatus(201, new Headers(), { ok: true }, 'openai'),
    ).not.toThrow();
    expect(() =>
      raiseForStatus(299, new Headers(), { ok: true }, 'openai'),
    ).not.toThrow();
  });

  it('throws AuthenticationError for 401', () => {
    expect(() =>
      raiseForStatus(
        401,
        new Headers(),
        { error: { message: 'Invalid API key' } },
        'openai',
      ),
    ).toThrow(AuthenticationError);
  });

  it('throws NotFoundError for 404', () => {
    expect(() =>
      raiseForStatus(404, new Headers(), { message: 'Not found' }, 'anthropic'),
    ).toThrow(NotFoundError);
  });

  it('throws RateLimitError for 429 with retry-after header', () => {
    const headers = new Headers({ 'retry-after': '5.0' });
    try {
      raiseForStatus(429, headers, { error: { message: 'Rate limited' } }, 'openai');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retry_after).toBe(5.0);
    }
  });

  it('throws ServerError for 500', () => {
    expect(() =>
      raiseForStatus(500, new Headers(), { error: { message: 'Internal error' } }, 'openai'),
    ).toThrow(ServerError);
  });

  it('throws ServerError for 502, 503, 504', () => {
    expect(() => raiseForStatus(502, new Headers(), 'bad gateway', 'openai')).toThrow(ServerError);
    expect(() => raiseForStatus(503, new Headers(), 'unavailable', 'openai')).toThrow(ServerError);
    expect(() => raiseForStatus(504, new Headers(), 'timeout', 'openai')).toThrow(ServerError);
  });

  it('throws InvalidRequestError for 400', () => {
    expect(() =>
      raiseForStatus(400, new Headers(), { error: { message: 'Bad request' } }, 'openai'),
    ).toThrow(InvalidRequestError);
  });

  it('throws ContextLengthError for 400 with context length message', () => {
    expect(() =>
      raiseForStatus(
        400,
        new Headers(),
        { error: { message: 'context length exceeded' } },
        'openai',
      ),
    ).toThrow(ContextLengthError);
  });

  it('throws ContextLengthError for 413', () => {
    expect(() =>
      raiseForStatus(413, new Headers(), { message: 'too large' }, 'openai'),
    ).toThrow(ContextLengthError);
  });

  it('uses body as string when body is a string', () => {
    try {
      raiseForStatus(500, new Headers(), 'raw string error', 'openai');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError);
      expect((err as ServerError).message).toContain('raw string error');
    }
  });

  it('handles error with error.code field', () => {
    try {
      raiseForStatus(
        400,
        new Headers(),
        { error: { message: 'bad', code: 'invalid_model' } },
        'openai',
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidRequestError);
      expect((err as InvalidRequestError).error_code).toBe('invalid_model');
    }
  });

  it('handles error with error.type field when code is absent', () => {
    try {
      raiseForStatus(
        400,
        new Headers(),
        { error: { message: 'bad', type: 'invalid_request_error' } },
        'openai',
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as InvalidRequestError).error_code).toBe('invalid_request_error');
    }
  });

  it('handles retry-after header with non-numeric value', () => {
    const headers = new Headers({ 'retry-after': 'not-a-number' });
    try {
      raiseForStatus(429, headers, { error: { message: 'Rate limited' } }, 'openai');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retry_after).toBeUndefined();
    }
  });

  it('uses JSON.stringify for non-string body without error field', () => {
    try {
      raiseForStatus(500, new Headers(), { something: 'else' }, 'openai');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ServerError).message).toContain('something');
    }
  });

  it('throws RequestTimeoutError for 408', () => {
    expect(() =>
      raiseForStatus(408, new Headers(), { message: 'Timeout' }, 'openai'),
    ).toThrow(RequestTimeoutError);
  });

  it('throws ContextLengthError for 422 with too many tokens message', () => {
    expect(() =>
      raiseForStatus(
        422,
        new Headers(),
        { error: { message: 'too many tokens' } },
        'openai',
      ),
    ).toThrow(ContextLengthError);
  });

  it('classifies unknown status codes by message content', () => {
    expect(() =>
      raiseForStatus(499, new Headers(), { message: 'not found resource' }, 'test'),
    ).toThrow(NotFoundError);

    expect(() =>
      raiseForStatus(499, new Headers(), { message: 'unauthorized access' }, 'test'),
    ).toThrow(AuthenticationError);

    expect(() =>
      raiseForStatus(499, new Headers(), { message: 'content filter triggered' }, 'test'),
    ).toThrow(ContentFilterError);

    expect(() =>
      raiseForStatus(499, new Headers(), { message: 'context length exceeded' }, 'test'),
    ).toThrow(ContextLengthError);
  });
});

// ---------------------------------------------------------------------------
// parseRateLimitHeaders
// ---------------------------------------------------------------------------

describe('parseRateLimitHeaders', () => {
  it('returns undefined when no rate limit headers present', () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    expect(parseRateLimitHeaders(headers)).toBeUndefined();
  });

  it('parses all rate limit headers', () => {
    const headers = new Headers({
      'x-ratelimit-remaining-requests': '99',
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-remaining-tokens': '9000',
      'x-ratelimit-limit-tokens': '10000',
      'x-ratelimit-reset-requests': '2025-01-01T00:00:00Z',
    });

    const info = parseRateLimitHeaders(headers);
    expect(info).toBeDefined();
    expect(info!.requests_remaining).toBe(99);
    expect(info!.requests_limit).toBe(100);
    expect(info!.tokens_remaining).toBe(9000);
    expect(info!.tokens_limit).toBe(10000);
    expect(info!.reset_at).toBeInstanceOf(Date);
  });

  it('handles partial headers', () => {
    const headers = new Headers({
      'x-ratelimit-remaining-requests': '50',
    });

    const info = parseRateLimitHeaders(headers);
    expect(info).toBeDefined();
    expect(info!.requests_remaining).toBe(50);
    expect(info!.requests_limit).toBeUndefined();
    expect(info!.tokens_remaining).toBeUndefined();
    expect(info!.tokens_limit).toBeUndefined();
    expect(info!.reset_at).toBeUndefined();
  });

  it('returns undefined for requests_remaining when only limit is present', () => {
    // Exercises the false branch of `remaining ? parseInt(remaining, 10) : undefined`
    const headers = new Headers({
      'x-ratelimit-limit-requests': '100',
    });

    const info = parseRateLimitHeaders(headers);
    expect(info).toBeDefined();
    expect(info!.requests_remaining).toBeUndefined();
    expect(info!.requests_limit).toBe(100);
  });

  it('returns undefined for tokens_limit when only tokens_remaining present', () => {
    const headers = new Headers({
      'x-ratelimit-remaining-tokens': '5000',
    });

    const info = parseRateLimitHeaders(headers);
    expect(info).toBeDefined();
    expect(info!.tokens_remaining).toBe(5000);
    expect(info!.tokens_limit).toBeUndefined();
  });

  it('returns undefined for reset_at when only tokens headers present', () => {
    const headers = new Headers({
      'x-ratelimit-limit-tokens': '10000',
    });

    const info = parseRateLimitHeaders(headers);
    expect(info).toBeDefined();
    expect(info!.tokens_limit).toBe(10000);
    expect(info!.reset_at).toBeUndefined();
    expect(info!.requests_remaining).toBeUndefined();
    expect(info!.requests_limit).toBeUndefined();
    expect(info!.tokens_remaining).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Uncovered branch coverage
// ---------------------------------------------------------------------------

describe('httpRequest — uncovered branches', () => {
  it('throws AbortError when Error has name "AbortError" (non-DOMException)', async () => {
    const controller = new AbortController();
    controller.abort();

    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    mockFetch.mockRejectedValue(err);

    await expect(
      httpRequest({ url: 'https://example.com', signal: controller.signal }),
    ).rejects.toThrow(AbortError);
  });

  it('throws RequestTimeoutError for Error with name "AbortError" without external signal', async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    mockFetch.mockRejectedValue(err);

    await expect(
      httpRequest({ url: 'https://example.com', timeout: 100 }),
    ).rejects.toThrow(RequestTimeoutError);
  });
});

describe('httpStreamRequest — uncovered branches', () => {
  it('throws AbortError when Error has name "AbortError" (non-DOMException)', async () => {
    const controller = new AbortController();
    controller.abort();

    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    mockFetch.mockRejectedValue(err);

    await expect(
      httpStreamRequest({ url: 'https://example.com', signal: controller.signal }),
    ).rejects.toThrow(AbortError);
  });

  it('throws RequestTimeoutError for Error with name "AbortError" without external signal', async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    mockFetch.mockRejectedValue(err);

    await expect(
      httpStreamRequest({ url: 'https://example.com', timeout: 100 }),
    ).rejects.toThrow(RequestTimeoutError);
  });

  it('handles non-Error thrown values with String() conversion', async () => {
    mockFetch.mockRejectedValue('string error');

    await expect(
      httpStreamRequest({ url: 'https://example.com' }),
    ).rejects.toThrow(NetworkError);
  });

  it('handles non-Error thrown values with undefined cause', async () => {
    mockFetch.mockRejectedValue(42);

    try {
      await httpStreamRequest({ url: 'https://example.com' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).cause).toBeUndefined();
      expect((err as NetworkError).message).toContain('42');
    }
  });
});
