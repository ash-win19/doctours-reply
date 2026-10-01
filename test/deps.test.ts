import { test } from "node:test";
import assert from "node:assert/strict";
import Groq from "groq-sdk";
import { toSetupError } from "../src/deps.ts";
import { SetupError } from "../src/runner.ts";

function apiError(status: number, message: string) {
  return Groq.APIError.generate(status, { error: { message } }, message, new Headers());
}

test("a request too large for the account's token limit is a setup error", () => {
  const error = toSetupError(apiError(413, "Request too large for model on tokens per minute (TPM): Limit 8000"));
  assert.ok(error instanceof SetupError);
  assert.match(error.message, /Limit 8000/);
});

test("a rejected key, missing permission or unknown model is a setup error", () => {
  for (const status of [401, 403, 404]) {
    assert.ok(toSetupError(apiError(status, "nope")) instanceof SetupError, String(status));
  }
});

test("rate limits and server errors are not setup errors", () => {
  for (const status of [429, 500]) {
    assert.equal(toSetupError(apiError(status, "busy")), null, String(status));
  }
  assert.equal(toSetupError(new Error("socket hang up")), null);
});
