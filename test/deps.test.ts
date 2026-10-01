import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "@google/genai";
import { toSetupError } from "../src/deps.ts";
import { SetupError } from "../src/runner.ts";

function apiError(status: number, message: string) {
  return new ApiError({ status, message });
}

test("a rejected key, missing permission or unknown model is a setup error", () => {
  for (const status of [400, 401, 403, 404]) {
    const error = toSetupError(apiError(status, "API key not valid"));
    assert.ok(error instanceof SetupError, String(status));
    assert.match(error.message, /API key not valid/);
  }
});

test("rate limits and server errors are not setup errors", () => {
  for (const status of [429, 500, 503]) {
    assert.equal(toSetupError(apiError(status, "busy")), null, String(status));
  }
  assert.equal(toSetupError(new Error("socket hang up")), null);
});
