import { test } from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { toSetupError } from "../src/deps.ts";
import { SetupError } from "../src/runner.ts";

function apiError(status: number, message: string, code?: string) {
  return OpenAI.APIError.generate(status, { error: { message, code } }, message, new Headers());
}

test("a rejected key, missing permission, unknown model or bad request is a setup error", () => {
  for (const status of [400, 401, 403, 404]) {
    const error = toSetupError(apiError(status, "Incorrect API key provided"));
    assert.ok(error instanceof SetupError, String(status));
    assert.match(error.message, /Incorrect API key provided/);
  }
});

test("running out of credit is a setup error, not a rate limit to retry", () => {
  const error = toSetupError(apiError(429, "You exceeded your current quota", "insufficient_quota"));
  assert.ok(error instanceof SetupError);
  assert.match(error.message, /quota/);
});

test("rate limits and server errors are not setup errors", () => {
  assert.equal(toSetupError(apiError(429, "Rate limit reached", "rate_limit_exceeded")), null);
  assert.equal(toSetupError(apiError(500, "server error")), null);
  assert.equal(toSetupError(new Error("socket hang up")), null);
});
