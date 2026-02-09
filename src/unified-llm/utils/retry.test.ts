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
