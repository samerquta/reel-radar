export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  isTransient?: (error: unknown) => boolean;
}

export function defaultIsTransientError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const status = (error as { statusCode?: number; status?: number })?.statusCode ??
    (error as { status?: number })?.status;

  if (status === 401 || status === 403 || status === 404 || status === 400) {
    return false;
  }
  if (status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('temporarily unavailable')
  );
}

export async function withExponentialBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const isTransient = options.isTransient ?? defaultIsTransientError;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      throw new Error('Operation cancelled via AbortSignal');
    }
    try {
      return await operation(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !isTransient(err) || options.signal?.aborted) {
        throw err;
      }
      const expDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jitter = Math.random() * expDelay * 0.3;
      const waitMs = Math.round(expDelay + jitter);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastError;
}

export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runner(): Promise<void> {
    while (nextIndex < items.length) {
      if (signal?.aborted) {
        throw new Error('Operation cancelled via AbortSignal');
      }
      const current = nextIndex++;
      results[current] = await worker(items[current]!, current);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runner()));
  return results;
}
