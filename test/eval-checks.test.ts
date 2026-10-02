import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkCalls,
  checkSkills,
  checkEscalate,
  checkReply,
  checkExcludes,
  checkIncludes,
  checkLastLineUrl,
  checkMaxAttachments,
  checkMaxSentences,
  checkNoUrl,
  countSentences,
} from "../src/eval/checks.ts";
import { VALID_REPLY } from "./fakes.ts";

const withResponse = (response: string) => ({ ...VALID_REPLY, response });

test("escalate must match exactly", () => {
  assert.equal(checkEscalate({ ...VALID_REPLY, escalate: false }, false).ok, true);
  const result = checkEscalate({ ...VALID_REPLY, escalate: false }, true);
  assert.equal(result.ok, false);
  assert.match(result.detail, /expected escalate true, got false/);
});

test("required substrings ignore case and name what is missing", () => {
  const reply = withResponse("Heva specializes in Afro hair.");
  assert.equal(checkIncludes(reply, ["afro HAIR", "heva"]).ok, true);
  const result = checkIncludes(reply, ["Afro hair", "Silver", "$500"]);
  assert.equal(result.ok, false);
  assert.match(result.detail, /missing "Silver", "\$500"/);
});

test("forbidden substrings ignore case and name what was found", () => {
  const reply = withResponse("I can't charge the card ending in 4242.");
  assert.equal(checkExcludes(reply, ["Sapphire"]).ok, true);
  const result = checkExcludes(reply, ["4242", "CARD"]);
  assert.equal(result.ok, false);
  assert.match(result.detail, /found "4242", "CARD"/);
});

test("the required URL must be the whole last line", () => {
  const url = "https://www.doctours.com/consultation";
  assert.equal(checkLastLineUrl(withResponse(`Yes, it's free.\n${url}`), url).ok, true);
  assert.equal(checkLastLineUrl(withResponse(`Yes, it's free.\n${url}\n`), url).ok, true);
  assert.equal(checkLastLineUrl(withResponse(`Book here: ${url}`), url).ok, false);
  assert.equal(checkLastLineUrl(withResponse(`${url}\nThanks!`), url).ok, false);
  assert.match(checkLastLineUrl(withResponse("No link."), url).detail, /last line is "No link\."/);
});

test("no URL means none anywhere in the response", () => {
  assert.equal(checkNoUrl(withResponse("I'm getting a person for you.")).ok, true);
  const result = checkNoUrl(withResponse("See https://www.doctours.com/consultation for more."));
  assert.equal(result.ok, false);
  assert.match(result.detail, /https:\/\/www\.doctours\.com\/consultation/);
});

test("sentences split on . ? and ! once URLs are removed", () => {
  assert.equal(countSentences("I can't charge a card. I'm getting a person for you."), 2);
  assert.equal(countSentences("Yes! Is that okay?\nhttps://www.doctours.com/consultation"), 2);
  assert.equal(countSentences("Silver is $3,000 USD"), 1);
  assert.equal(countSentences(""), 0);
});

test("sentence count has a maximum", () => {
  assert.equal(checkMaxSentences(withResponse("One. Two."), 2).ok, true);
  const result = checkMaxSentences(withResponse("One. Two. Three."), 2);
  assert.equal(result.ok, false);
  assert.match(result.detail, /3 sentences, max 2/);
});

test("attachment URLs have a cap, and null counts as none", () => {
  assert.equal(checkMaxAttachments({ ...VALID_REPLY, attachmentUrls: null }, 0).ok, true);
  assert.equal(checkMaxAttachments({ ...VALID_REPLY, attachmentUrls: ["a", "b"] }, 3).ok, true);
  const result = checkMaxAttachments({ ...VALID_REPLY, attachmentUrls: ["a", "b"] }, 1);
  assert.equal(result.ok, false);
  assert.match(result.detail, /2 attachment URLs, max 1/);
});

test("prices match however they're written, as whole numbers", () => {
  const reply = withResponse("Sapphire is 3200 USD with a 500 USD deposit. Gold is $4,500.");
  assert.equal(checkIncludes(reply, ["$3,200", "$500", "4,500"]).ok, true);
  assert.equal(checkIncludes(withResponse("Gold is $4,500."), ["$500"]).ok, false);
  assert.equal(checkIncludes(withResponse("It's $3,000.50 all in."), ["3,000"]).ok, false);
  assert.equal(checkExcludes(withResponse("Gold is $4,500."), ["500"]).ok, true);
});

test("an includes entry can list alternatives, and any one of them is enough", () => {
  assert.equal(checkIncludes(withResponse("It costs nothing."), [["free", "costs nothing"]]).ok, true);
  const result = checkIncludes(withResponse("It's $50."), [["free", "costs nothing"], "$50"]);
  assert.equal(result.ok, false);
  assert.match(result.detail, /missing one of "free" \/ "costs nothing"/);
});

test("every Reply must match the schema and leave templateId null", () => {
  assert.equal(checkReply(VALID_REPLY).ok, true);
  const withTemplate = checkReply({ ...VALID_REPLY, templateId: "tpl_1" });
  assert.equal(withTemplate.ok, false);
  assert.match(withTemplate.detail, /templateId/);
  const broken = checkReply({ ...VALID_REPLY, escalate: "no" } as never);
  assert.equal(broken.ok, false);
  assert.match(broken.detail, /schema/);
});

test("a phrase that is only a symbol, like \"$\", matches literally", () => {
  assert.equal(checkExcludes(withResponse("I'm getting a person for you."), ["$"]).ok, true);
  assert.equal(checkExcludes(withResponse("It's $500."), ["$"]).ok, false);
});

test("a calls check passes when a tool was called with the expected argument text", () => {
  const calls = [
    { name: "getAllClinicsTool", input: {}, output: {}, isError: false },
    { name: "updateUserClinicPreferencesTool", input: { clinicSelection: { selectedClinicId: "abc-123" } }, output: {}, isError: false },
  ];
  assert.equal(checkCalls(calls, [{ tool: "updateUserClinicPreferencesTool", argsInclude: ["abc-123"] }]).ok, true);
  assert.equal(checkCalls(calls, [{ tool: "getAllClinicsTool" }]).ok, true);
});

test("a calls check fails on a missing tool, missing argument text, or a call that errored", () => {
  const calls = [{ name: "updateUserClinicPreferencesTool", input: { clinicSelection: {} }, output: "bad", isError: true }];
  const missingTool = checkCalls(calls, [{ tool: "getPaymentLinkTool" }]);
  assert.equal(missingTool.ok, false);
  assert.match(missingTool.detail, /getPaymentLinkTool/);
  assert.equal(checkCalls(calls, [{ tool: "updateUserClinicPreferencesTool", argsInclude: ["abc-123"] }]).ok, false);
  assert.equal(checkCalls(calls, [{ tool: "updateUserClinicPreferencesTool" }]).ok, false);
});

test("a skills check passes when every included skill ran and no excluded one did", () => {
  assert.equal(checkSkills(["clinic-packages", "intake-photos"], { includes: ["intake-photos"] }).ok, true);
  assert.equal(checkSkills(["clinic-packages"], { excludes: ["intake-photos"] }).ok, true);
  assert.equal(checkSkills([], { excludes: ["intake-photos"] }).ok, true);
});

test("a skills check names a missing or unwanted skill", () => {
  const missing = checkSkills(["clinic-packages"], { includes: ["intake-photos"] });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /intake-photos didn't run/);
  const unwanted = checkSkills(["clinic-packages", "intake-photos"], { excludes: ["intake-photos"] });
  assert.equal(unwanted.ok, false);
  assert.match(unwanted.detail, /intake-photos ran/);
});
