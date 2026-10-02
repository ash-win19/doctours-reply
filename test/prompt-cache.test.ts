import { test } from "node:test";
import assert from "node:assert/strict";
import { PACKET_CONTEXT, loadContext } from "../src/patient-context.ts";
import { respond, skillsRun } from "../src/pipeline.ts";
import { buildCorePrompt, buildResponderSystemPrompt, formatSkill } from "../src/prompt.ts";
import { cachedDeveloperMessage, responderCachePlan } from "../src/prompt-cache.ts";
import { loadSkillRegistry, statusModule } from "../src/skills.ts";
import { functionCall, scriptedModel, systemText, triageDecision, VALID_REPLY } from "./fakes.ts";

test("cache blocks preserve the exact composed prompt and mark core plus status before skills", () => {
  const registry = loadSkillRegistry();
  for (const patient of [PACKET_CONTEXT, loadContext("evals/contexts/lead.json")]) {
    const core = buildCorePrompt(patient, registry.index());
    const status = statusModule(patient.PIPELINE_STATUS);
    const skills = registry.resolve(["payments"]);
    const plan = responderCachePlan(core, status, skills.map(formatSkill), patient.SUPABASE_CHAT_ID);
    assert.equal(plan.blocks.map(({ text }) => text).join("\n\n"), buildResponderSystemPrompt({ core, status, skills }));
    assert.equal(plan.blocks.filter(({ cache }) => cache).length, 3);
    assert.equal(plan.blocks[0].section, "core rules");
    assert.ok(!plan.blocks[0].text.includes(patient.CHAT_LIST || "No messages yet."));
    assert.equal(plan.blocks[2].section, "Pipeline Status");
    assert.ok(plan.blocks.slice(3).every(({ cache }) => !cache));
    assert.equal(systemText({ model: "fake", input: [cachedDeveloperMessage(plan)] }), buildResponderSystemPrompt({ core, status, skills }));
  }
});

test("the cache key stays stable for the Patient and differs for another Patient", () => {
  const key = (chat: string) => responderCachePlan("core", "status", [], chat).key;
  assert.equal(key("one"), key("one"));
  assert.notEqual(key("one"), key("two"));
  assert.ok(!key("one").includes("one"));
});

test("cached responder rounds preserve the prefix, and traces include required skills", async () => {
  const model = scriptedModel([
    [functionCall("submitTriage", triageDecision({ skills: ["payments"] }))],
    [functionCall("getClinicPackagesTool", { clinicId: "heva" })],
    [functionCall("submitReply", VALID_REPLY)],
  ]);
  const { trace } = await respond("How do I pay?", "default", {
    create: model.create, responderModel: "fake", triageModel: "fake", context: PACKET_CONTEXT,
  });
  for (const request of model.requests.slice(1)) {
    assert.equal(request.instructions, undefined);
    assert.deepEqual(request.prompt_cache_options, { mode: "implicit" });
    assert.equal(request.prompt_cache_key, model.requests[1].prompt_cache_key);
    assert.deepEqual((request.input as unknown[])[0], (model.requests[1].input as unknown[])[0]);
  }
  assert.deepEqual(skillsRun(trace), ["clinic-packages", "payments"]);
});

test("cache-off and explicit baseline mode keep the original request shape", async () => {
  for (const mode of ["default", "baseline"] as const) {
    const model = scriptedModel([
      ...(mode === "default" ? [[functionCall("submitTriage", triageDecision())]] : []),
      [functionCall("submitReply", VALID_REPLY)],
    ]);
    await respond("Is it free?", mode, {
      create: model.create, responderModel: "fake", triageModel: "fake", context: PACKET_CONTEXT, promptCache: mode === "baseline",
    });
    for (const request of model.requests) {
      assert.equal(typeof request.instructions, "string");
      assert.equal(request.prompt_cache_key, undefined);
      assert.equal(request.prompt_cache_options, undefined);
    }
  }
});
