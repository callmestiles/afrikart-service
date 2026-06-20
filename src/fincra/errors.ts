export class FincraError extends Error {
  public readonly status: number;
  public readonly errorType: string | undefined;
  public readonly isRetryable: boolean;

  constructor(message: string, status: number, errorType?: string) {
    super(message);
    this.name = "FincraError";
    this.status = status;
    this.errorType = errorType;
    // Only 503 (provider unavailable) and 429 (rate limit) are retryable
    // 4xx errors represent bad requests that will always fail so we never retry those
    this.isRetryable = status === 503 || status === 429;
  }
}

export class FincraNetworkError extends Error {
  public readonly isRetryable = true; // Network errors are always retryable

  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "FincraNetworkError";
  }
}
