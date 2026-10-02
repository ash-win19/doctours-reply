import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBaselineSystemPrompt,
  buildBaselineUserMessage,
  buildCorePrompt,
  buildResponderSystemPrompt,
  buildResponderUserMessage,
} from "../src/prompt.ts";
import { buildStateCard } from "../src/state-card.ts";
import { loadSkillRegistry } from "../src/skills.ts";
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

test("the core prompt fills every placeholder from the Patient context", () => {
  const core = buildCorePrompt(context, [{ id: "payments", description: "Money questions." }]);
  assert.doesNotMatch(core, /\{\{[A-Z_]+\}\}/);
  assert.ok(core.includes(buildStateCard(context)));
  assert.ok(core.includes(context.CHAT_LIST));
  assert.ok(core.includes(context.CLINIC_FLAGS));
  assert.ok(core.includes(context.WORKING_MEMORY));
  assert.ok(
    core.includes(
      "from this list: https://www.doctours.com/consultation (book the free consultation), https://www.doctours.com/image-upload (intake photos), and https://www.doctours.com/clinic/{slug} with a slug",
    ),
  );
  assert.ok(core.includes("at most 3. Otherwise null."));
  assert.match(core, /call loadSkill with one of these ids:\n- payments: Money questions\.\n/);
});

// English prose runs above 4 characters per token, so characters / 4 is a safe upper estimate.
test("the core prompt, with every shipped skill listed for loadSkill, stays under 3k tokens", () => {
  const core = buildCorePrompt(context, loadSkillRegistry().index());
  assert.ok(core.length / 4 < 3000, `core is about ${Math.round(core.length / 4)} tokens`);
});

test("the responder's system prompt is the core, then the Pipeline Status module, then the skills", () => {
  const system = buildResponderSystemPrompt({
    core: "CORE",
    status: "STATUS",
    skills: [
      { id: "a", text: "SKILL A", overrides: [] },
      { id: "b", text: "SKILL B", overrides: ["Overridden rule"] },
    ],
  });
  assert.equal(
    system,
    "CORE\n\nSTATUS\n\n# SKILL: a\nSKILL A\n\n# SKILL: b\nOverrides: Overridden rule\nSKILL B",
  );
  assert.equal(buildResponderSystemPrompt({ core: "CORE", status: null, skills: [] }), "CORE");
});

test("the responder's user message carries the incoming message", () => {
  const message = buildResponderUserMessage("What does Heva cost?", context);
  assert.equal(message, 'Incoming thread message:\n"What does Heva cost?"\nIncoming image count: 0\nTriggering sender: Jordan Hale');
});
