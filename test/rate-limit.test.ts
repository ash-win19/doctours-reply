import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "@google/genai";
import { createRateLimiter, retryDelayMs, withRetries } from "../src/rate-limit.ts";
import { SetupError } from "../src/runner.ts";

// A clock that only moves when something sleeps on it.
function fakeClock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
    sleeps,
  };
}

function quotaError(retryDelay: string, quotaId = "GenerateRequestsPerMinutePerProjectPerModel-FreeTier") {
  const body = {
    error: {
      code: 429,
      message: "You exceeded your current quota",
      status: "RESOURCE_EXHAUSTED",
      details: [
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId }] },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
      ],
    },
  };
  return new ApiError({ status: 429, message: JSON.stringify(body) });
}

test("lets the first N requests in a minute through at once", async () => {
  const clock = fakeClock();
  const acquire = createRateLimiter(3, clock);
  await Promise.all([acquire(), acquire(), acquire()]);
  assert.equal(clock.now(), 0);
});

test("holds the next request until the oldest one is a minute old", async () => {
  const clock = fakeClock();
  const acquire = createRateLimiter(2, clock);
  await acquire();
  await clock.sleep(10_000);
  await acquire();
  await acquire();
  assert.equal(clock.now(), 60_000);
});

test("reads the delay Gemini asks for", () => {
  assert.equal(retryDelayMs(quotaError("29.11s")), 29_110);
  assert.equal(retryDelayMs(new ApiError({ status: 503, message: "overloaded" })), null);
});

test("retries a rate limit after the delay Gemini asks for", async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await withRetries(
    async () => {
      calls += 1;
      if (calls === 1) throw quotaError("29s");
      return "ok";
    },
    { ...clock, attempts: 3, log: () => {} },
  );
  assert.equal(result, "ok");
  assert.deepEqual(clock.sleeps, [29_000]);
});

test("backs off exponentially on overload, capped at a minute", async () => {
  const clock = fakeClock();
  await assert.rejects(
    withRetries(
      async () => {
        throw new ApiError({ status: 503, message: "high demand" });
      },
      { ...clock, attempts: 8, log: () => {} },
    ),
    /high demand/,
  );
  assert.deepEqual(clock.sleeps, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
});

test("a used-up daily quota stops the run instead of retrying", async () => {
  const clock = fakeClock();
  await assert.rejects(
    withRetries(
      async () => {
        throw quotaError("3600s", "GenerateRequestsPerDayPerProjectPerModel-FreeTier");
      },
      { ...clock, attempts: 5, log: () => {} },
    ),
    (error: unknown) => error instanceof SetupError && /daily/i.test(error.message),
  );
  assert.deepEqual(clock.sleeps, []);
});

test("does not retry other errors", async () => {
  const clock = fakeClock();
  let calls = 0;
  await assert.rejects(
    withRetries(
      async () => {
        calls += 1;
        throw new ApiError({ status: 400, message: "bad request" });
      },
      { ...clock, attempts: 5, log: () => {} },
    ),
  );
  assert.equal(calls, 1);
});
