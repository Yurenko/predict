export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MinIntervalLimiter {
  private lastAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  async wait(): Promise<void> {
    const waitFor = this.lastAt + this.minIntervalMs - Date.now();
    if (waitFor > 0) {
      await sleep(waitFor);
    }
    this.lastAt = Date.now();
  }
}

export async function withRetries<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    isRetryable: (error: unknown) => boolean;
    delayMs?: (attempt: number) => number;
  },
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !options.isRetryable(error)) {
        throw error;
      }
      await sleep(options.delayMs?.(attempt) ?? 1000 * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}
