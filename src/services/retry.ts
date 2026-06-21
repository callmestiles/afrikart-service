import { FincraError, FincraNetworkError } from "../fincra/errors";

interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  idempotencyKey?: string;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1000,
};

// Exponential backoff with ±20% jitter so concurrent callers don't retry in lockstep
function getDelay(attempt: number, baseDelayMs: number): number {
  const exponential = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = exponential * 0.2 * (Math.random() * 2 - 1);
  return Math.round(exponential + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;

      const isRetryable =
        err instanceof FincraError
          ? err.isRetryable
          : err instanceof FincraNetworkError
            ? err.isRetryable
            : false;

      if (!isRetryable) {
        // 4xx — bad request, retrying won't help
        throw err;
      }

      if (attempt === opts.maxAttempts) {
        console.warn(
          `[retry] All ${opts.maxAttempts} attempts failed`,
          opts.idempotencyKey
            ? `(idempotency key: ${opts.idempotencyKey})`
            : "",
        );
        throw err;
      }

      const delay = getDelay(attempt, opts.baseDelayMs);
      console.warn(
        `[retry] Attempt ${attempt}/${opts.maxAttempts} failed — retrying in ${delay}ms`,
        err instanceof Error ? `(${err.message})` : "",
      );

      await sleep(delay);
    }
  }

  throw lastError;
}
