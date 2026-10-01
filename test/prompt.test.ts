import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBaselineSystemPrompt, buildBaselineUserMessage } from "../src/prompt.ts";
import * as context from "../src/context.ts";

test("system prompt fills every placeholder", () => {
  const prompt = buildBaselineSystemPrompt();
  assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/);
});

test("string constants go in verbatim", () => {
  const prompt = buildBaselineSystemPrompt();
  assert.ok(prompt.includes(context.PATIENT_SUMMARY));
  assert.ok(prompt.includes(context.CHAT_LIST));
  assert.ok(prompt.includes(`<working_memory_data>\n${context.WORKING_MEMORY}\n</working_memory_data>`));
  assert.ok(prompt.includes("You are responding in a chat thread as Alex."));
});

test("non-string constants are JSON-stringified", () => {
  const prompt = buildBaselineSystemPrompt();
  assert.ok(prompt.includes("Assessment Clinic Recommendations: 2 clinic(s)"));
  assert.ok(prompt.includes("Patient Images: 5 uploaded"));
});

test("user message fills the human message and conversation summary", () => {
  const message = buildBaselineUserMessage("Is the consultation free?");
  assert.ok(message.startsWith('Incoming thread message:\n"Is the consultation free?"\n'));
  assert.ok(message.endsWith(`Recent conversation summary:\n${context.RECENT_CONVERSATION_SUMMARY}`));
  assert.doesNotMatch(message, /\{\{/);
});

test("placeholder-like text in the human message is left alone", () => {
  const message = buildBaselineUserMessage("what is {{RECENT_CONVERSATION_SUMMARY}}?");
  assert.ok(message.includes('"what is {{RECENT_CONVERSATION_SUMMARY}}?"'));
});
