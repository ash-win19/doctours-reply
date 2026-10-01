import { ApiError } from "@google/genai";
import { SetupError } from "./runner.ts";

const MINUTE_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
const RETRYABLE_STATUSES = new Set([429, 500, 503, 504]);

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// Lets at most perMinute requests start in any rolling minute. Callers queue in arrival order.
export function createRateLimiter(perMinute: number, clock: Clock): () => Promise<void> {
  const starts: number[] = [];
  let queue: Promise<void> = Promise.resolve();
  return () => {
    const turn = queue.then(async () => {
      for (;;) {
        const now = clock.now();
        while (starts.length > 0 && now - starts[0] >= MINUTE_MS) starts.shift();
        if (starts.length < perMinute) {
          starts.push(now);
          return;
        }
        await clock.sleep(MINUTE_MS - (now - starts[0]));
      }
    });
    queue = turn;
    return turn;
  };
}

// The "retryDelay" Gemini puts in a 429's RetryInfo, such as "29.11s".
export function retryDelayMs(error: unknown): number | null {
  if (!(error instanceof ApiError)) return null;
  const match = error.message.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/);
  return match ? Math.round(Number(match[1]) * 1000) : null;
}

function isDailyQuota(error: ApiError): boolean {
  return error.status === 429 && /PerDay/.test(error.message);
}

export interface RetryOptions extends Clock {
  attempts: number;
  log: (line: string) => void;
}

// Retries rate limits and overloads. A rate limit waits as long as Gemini asks; anything else backs off exponentially.
export async function withRetries<T>(request: () => Promise<T>, { attempts, log, sleep }: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof ApiError) || !RETRYABLE_STATUSES.has(error.status)) throw error;
      if (isDailyQuota(error)) {
        throw new SetupError(`Gemini's free daily request quota is used up for this model. Try again tomorrow.\n${error.message}`);
      }
      if (attempt >= attempts) throw error;
      const delay = retryDelayMs(error) ?? Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);
      log(`Gemini ${error.status}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1} of ${attempts})`);
      await sleep(delay);
    }
  }
}
