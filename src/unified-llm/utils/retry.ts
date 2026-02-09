// ============================================================================
// Retry Logic with Exponential Backoff
// ============================================================================

import { ProviderError, LLMError } from "../types.js";
import type { RetryPolicy } from "../types.js";

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  max_retries: 2,
  base_delay: 1.0,
  max_delay: 60.0,
  backoff_multiplier: 2.0,
  jitter: true,
};

function computeDelay(attempt: number, policy: RetryPolicy): number {
  let delay = Math.min(
    policy.base_delay * Math.pow(policy.backoff_multiplier, attempt),
    policy.max_delay,
  );
  if (policy.jitter) {
    // +/- 50% jitter
    delay = delay * (0.5 + Math.random());
  }
  return delay;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ProviderError) {
    return error.retryable;
  }
  // Unknown errors default to retryable
  if (error instanceof LLMError) {
    return true;
  }
  return true;
}

function getRetryAfter(error: unknown): number | undefined {
  if (error instanceof ProviderError) {
    return error.retry_after;
  }
  return undefined;
}

export async function retry<T>(
  fn: () => Promise<T>,
  policy: Partial<RetryPolicy> = {},
): Promise<T> {
  const p: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...policy };

  let lastError: unknown;

  for (let attempt = 0; attempt <= p.max_retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      // Don't retry if we've used all attempts
      if (attempt >= p.max_retries) break;

      // Don't retry non-retryable errors
      if (!isRetryable(err)) break;

      // Compute delay
      let delay = computeDelay(attempt, p);

      // Check Retry-After header
      const retryAfter = getRetryAfter(err);
      if (retryAfter !== undefined) {
        if (retryAfter > p.max_delay) {
          // Retry-After exceeds max_delay, don't retry
          break;
        }
        delay = retryAfter;
      }

      // Invoke on_retry callback
      if (p.on_retry && err instanceof Error) {
        p.on_retry(err, attempt + 1, delay);
      }

      // Wait
      await sleep(delay * 1000);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
