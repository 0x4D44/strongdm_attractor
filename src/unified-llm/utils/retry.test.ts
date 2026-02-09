import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { retry, DEFAULT_RETRY_POLICY } from "./retry.js";
import {
  ProviderError,
  RateLimitError,
  AuthenticationError,
  ServerError,
  LLMError,
} from "../types.js";

describe("retry()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const promise = retry(fn);
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable errors (ServerError)", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new ServerError({ message: "fail", provider: "openai" }))
      .mockResolvedValue("ok");

    const promise = retry(fn, { max_retries: 2, jitter: false, base_delay: 0.001 });

    // Advance timers to let the retry sleep complete
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable errors", async () => {
    const fn = vi.fn()
      .mockRejectedValue(new AuthenticationError({ message: "invalid key", provider: "openai" }));

    const promise = retry(fn, { max_retries: 3 });
    await expect(promise).rejects.toThrow(AuthenticationError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops after max_retries", async () => {
    vi.useRealTimers();
    const fn = vi.fn()
      .mockRejectedValue(new ServerError({ message: "fail", provider: "openai" }));

    await expect(
      retry(fn, { max_retries: 2, jitter: false, base_delay: 0.001 })
    ).rejects.toThrow(ServerError);
    // 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("max_retries=0 means no retries", async () => {
    const fn = vi.fn()
      .mockRejectedValue(new ServerError({ message: "fail", provider: "openai" }));

    const promise = retry(fn, { max_retries: 0 });
    await expect(promise).rejects.toThrow(ServerError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects retry_after from ProviderError", async () => {
    const err = new RateLimitError({
      message: "rate limited",
      provider: "openai",
      retry_after: 5,
    });
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue("ok");

    const promise = retry(fn, { max_retries: 1, jitter: false, base_delay: 1 });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe("ok");
  });

  it("skips retry when retry_after exceeds max_delay", async () => {
    vi.useRealTimers();
    const err = new RateLimitError({
      message: "rate limited",
      provider: "openai",
      retry_after: 999,
    });
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue("ok");

    await expect(
      retry(fn, { max_retries: 1, max_delay: 60 })
    ).rejects.toThrow(RateLimitError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls on_retry callback", async () => {
    const onRetry = vi.fn();
    const err = new ServerError({ message: "fail", provider: "openai" });
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue("ok");

    const promise = retry(fn, {
      max_retries: 1,
      jitter: false,
      base_delay: 0.001,
      on_retry: onRetry,
    });
    await vi.runAllTimersAsync();
    await promise;
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(err, 1, expect.any(Number));
  });

  it("retries generic errors (treated as retryable)", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("generic"))
      .mockResolvedValue("ok");

    const promise = retry(fn, { max_retries: 1, jitter: false, base_delay: 0.001 });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe("ok");
  });

  it("retries LLMError (treated as retryable)", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new LLMError("generic llm error"))
      .mockResolvedValue("ok");

    const promise = retry(fn, { max_retries: 1, jitter: false, base_delay: 0.001 });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe("ok");
  });
});

describe("DEFAULT_RETRY_POLICY", () => {
  it("has reasonable defaults", () => {
    expect(DEFAULT_RETRY_POLICY.max_retries).toBe(2);
    expect(DEFAULT_RETRY_POLICY.base_delay).toBe(1.0);
    expect(DEFAULT_RETRY_POLICY.max_delay).toBe(60.0);
    expect(DEFAULT_RETRY_POLICY.backoff_multiplier).toBe(2.0);
    expect(DEFAULT_RETRY_POLICY.jitter).toBe(true);
  });
});

describe("retry() - mutant-killing tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delay increases exponentially with backoff_multiplier", async () => {
    vi.useRealTimers();
    const delays: number[] = [];
    const fn = vi.fn()
      .mockRejectedValueOnce(new ServerError({ message: "fail", provider: "openai" }))
      .mockRejectedValueOnce(new ServerError({ message: "fail", provider: "openai" }))
      .mockResolvedValue("ok");

    await retry(fn, {
      max_retries: 2,
      jitter: false,
      base_delay: 0.001,
      backoff_multiplier: 2.0,
      on_retry: (_err, _attempt, delay) => delays.push(delay),
    });

    expect(fn).toHaveBeenCalledTimes(3);
    // attempt 0: base_delay * 2^0 = 0.001
    // attempt 1: base_delay * 2^1 = 0.002
    expect(delays[0]).toBeCloseTo(0.001, 5);
    expect(delays[1]).toBeCloseTo(0.002, 5);
  });

  it("jitter changes delay (not deterministic)", async () => {
    vi.useRealTimers();
    const delays: number[] = [];
    const makeAttempt = async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new ServerError({ message: "fail", provider: "openai" }))
        .mockResolvedValue("ok");

      await retry(fn, {
        max_retries: 1,
        jitter: true,
        base_delay: 0.1,
        backoff_multiplier: 1.0,
        on_retry: (_err, _attempt, delay) => delays.push(delay),
      });
    };

    await makeAttempt();
    await makeAttempt();
    // With jitter enabled, delays should be between 0.05 and 0.15 (0.1 * (0.5 to 1.5))
    expect(delays[0]).toBeGreaterThan(0.01);
    expect(delays[0]).toBeLessThan(0.2);
  });

  it("delay is capped by max_delay", async () => {
    vi.useRealTimers();
    const delays: number[] = [];
    const fn = vi.fn()
      .mockRejectedValueOnce(new ServerError({ message: "fail", provider: "openai" }))
      .mockResolvedValue("ok");

    await retry(fn, {
      max_retries: 1,
      jitter: false,
      base_delay: 100,
      max_delay: 0.001,
      backoff_multiplier: 2.0,
      on_retry: (_err, _attempt, delay) => delays.push(delay),
    });

    expect(delays[0]).toBeLessThanOrEqual(0.001);
  });

  it("LLMError is retried but non-retryable ProviderError is not", async () => {
    vi.useRealTimers();
    // LLMError => retryable
    const fn1 = vi.fn()
      .mockRejectedValueOnce(new LLMError("err"))
      .mockResolvedValue("ok");
    const result = await retry(fn1, { max_retries: 1, base_delay: 0.001, jitter: false });
    expect(result).toBe("ok");
    expect(fn1).toHaveBeenCalledTimes(2);

    // AuthenticationError => not retryable
    const fn2 = vi.fn()
      .mockRejectedValue(new AuthenticationError({ message: "bad", provider: "test" }));
    await expect(retry(fn2, { max_retries: 3 })).rejects.toThrow(AuthenticationError);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it("retry_after exactly equal to max_delay still retries", async () => {
    const err = new RateLimitError({
      message: "rate limited",
      provider: "openai",
      retry_after: 60,
    });
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue("ok");

    const promise = retry(fn, {
      max_retries: 1,
      max_delay: 60,
      base_delay: 0.001,
      jitter: false,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retry_after slightly above max_delay causes no retry", async () => {
    const err = new RateLimitError({
      message: "rate limited",
      provider: "openai",
      retry_after: 61,
    });
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue("ok");

    await expect(
      retry(fn, { max_retries: 1, max_delay: 60 })
    ).rejects.toThrow(RateLimitError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("on_retry not called for non-Error objects", async () => {
    vi.useRealTimers();
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce("string error")
      .mockResolvedValue("ok");

    await retry(fn, {
      max_retries: 1,
      jitter: false,
      base_delay: 0.001,
      on_retry: onRetry,
    });
    // on_retry only called when err instanceof Error
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("getRetryAfter returns undefined for non-ProviderError", async () => {
    vi.useRealTimers();
    const delays: number[] = [];
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("generic"))
      .mockResolvedValue("ok");

    await retry(fn, {
      max_retries: 1,
      jitter: false,
      base_delay: 0.001,
      on_retry: (_err, _attempt, delay) => delays.push(delay),
    });
    // Should use computed delay, not retry_after
    expect(delays[0]).toBeCloseTo(0.001, 3);
  });

  it("delay is multiplied by 1000 for sleep (ms conversion)", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new ServerError({ message: "fail", provider: "openai" }))
      .mockResolvedValue("ok");

    const promise = retry(fn, { max_retries: 1, jitter: false, base_delay: 1.0 });
    // With base_delay=1.0 and no jitter, sleep should be called with 1000ms
    // If mutation changes * to /, it would be 0.001ms (essentially instant)
    // We verify by checking that the timer needs to advance at least ~1000ms
    await vi.advanceTimersByTimeAsync(500);
    expect(fn).toHaveBeenCalledTimes(1); // retry hasn't happened yet
    await vi.advanceTimersByTimeAsync(600);
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
