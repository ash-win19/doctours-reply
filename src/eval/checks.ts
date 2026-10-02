import { z } from "zod";
import type { ToolCallTrace } from "../model-calls.ts";
import { ReplySchema, type Reply } from "../reply.ts";

export interface CheckResult {
  ok: boolean;
  detail: string;
}

export interface NamedCheck extends CheckResult {
  name: string;
}

// One required text, or a list of alternatives where any one is enough.
export type Phrase = string | string[];

const URL_PATTERN = /https?:\/\/\S+/g;
const NUMBER_PATTERN = /^\d+(\.\d+)?$/;

function quoted(values: string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

// Lowercases, drops "$" and digit-grouping commas, so "$3,000" and "3000 USD" read the same.
function normalize(text: string): string {
  return text.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[–—]/g, "-").toLowerCase().replaceAll("$", "").replace(/(\d),(?=\d{3}\b)/g, "$1");
}

// Numbers match whole, so "500" doesn't match inside "4,500" or "500.50". Anything else is a substring.
function mentions(text: string, phrase: string): boolean {
  const needle = normalize(phrase).trim();
  // A phrase made only of what normalize drops, such as "$", is matched as written.
  if (!needle) return text.toLowerCase().includes(phrase.toLowerCase());
  const haystack = normalize(text);
  if (!NUMBER_PATTERN.test(needle)) return haystack.includes(needle);
  const escaped = needle.replace(".", "\\.");
  return new RegExp(`(?<![\\d.])${escaped}(?!\\.?\\d)`).test(haystack);
}

export function checkReply(reply: Reply): CheckResult {
  const parsed = ReplySchema.safeParse(reply);
  if (!parsed.success) return { ok: false, detail: `does not match the Reply schema: ${z.prettifyError(parsed.error)}` };
  if (reply.templateId !== null) return { ok: false, detail: `templateId is ${JSON.stringify(reply.templateId)}, not null` };
  if (!reply.response.trim()) return { ok: false, detail: "response is empty" };
  if (reply.escalate ? !reply.escalationReason?.trim() : reply.escalationReason !== null) {
    return { ok: false, detail: "escalationReason must be nonempty exactly when escalate is true" };
  }
  if (reply.escalate && (countSentences(reply.response) !== 1 || reply.response.length > 180)) {
    return { ok: false, detail: "escalation must be one short sentence" };
  }
  if ((reply.attachmentUrls?.length ?? 0) > 3) return { ok: false, detail: "more than three attachments" };
  if (!reply.shouldFollowUp && reply.followUpTiming !== null) return { ok: false, detail: "unexpected follow-up timing" };
  const lines = reply.response.trim().split("\n");
  const firstUrl = lines.findIndex((line) => /https?:\/\//.test(line));
  if (firstUrl >= 0 && lines.slice(firstUrl).some((line) => !/^https?:\/\/\S+$/.test(line.trim()))) {
    return { ok: false, detail: "URLs must be alone on the final lines" };
  }
  return { ok: true, detail: "matches the Reply schema with a null templateId" };
}

export function checkAttachmentEvidence(reply: Reply, calls: ToolCallTrace[]): CheckResult {
  const returned = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") for (const url of value.match(/https?:\/\/[^\s<>"']+/g) ?? []) returned.add(url);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  // Agent summaries and submitted replies are not packet-tool evidence.
  for (const call of calls) if (!call.isError && call.name.endsWith("Tool")) visit(call.output);
  const missing = (reply.attachmentUrls ?? []).filter((url) => !returned.has(url));
  return { ok: missing.length === 0, detail: missing.length ? `attachments not returned this turn: ${missing.join(", ")}` : "attachments came from this turn's tools" };
}

export function checkEscalate(reply: Reply, expected: boolean): CheckResult {
  return {
    ok: reply.escalate === expected,
    detail: `expected escalate ${expected}, got ${reply.escalate}`,
  };
}

export function checkIncludes(reply: Reply, required: Phrase[]): CheckResult {
  const missing = required
    .map((phrase) => (Array.isArray(phrase) ? phrase : [phrase]))
    .filter((alternatives) => !alternatives.some((alternative) => mentions(reply.response, alternative)))
    .map((alternatives) => (alternatives.length > 1 ? `one of ${alternatives.map((a) => `"${a}"`).join(" / ")}` : `"${alternatives[0]}"`));
  return { ok: missing.length === 0, detail: missing.length ? `missing ${missing.join(", ")}` : "has every required text" };
}

export function checkExcludes(reply: Reply, forbidden: string[]): CheckResult {
  const found = forbidden.filter((phrase) => mentions(reply.response, phrase));
  return { ok: found.length === 0, detail: found.length ? `found ${quoted(found)}` : "has no forbidden text" };
}

export function checkLastLineUrl(reply: Reply, url: string): CheckResult {
  const lastLine = reply.response.trimEnd().split("\n").at(-1)?.trim() ?? "";
  return { ok: lastLine === url, detail: `expected last line ${url}, last line is "${lastLine}"` };
}

export function checkNoUrl(reply: Reply): CheckResult {
  const urls = reply.response.match(URL_PATTERN) ?? [];
  return { ok: urls.length === 0, detail: urls.length ? `has URL ${urls.join(", ")}` : "has no URL" };
}

// Sentences split on ".", "?" and "!" after removing URLs.
function sentences(text: string): string[] {
  return text
    .replace(URL_PATTERN, "")
    .split(/[.?!]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function countSentences(text: string): number {
  return sentences(text).length;
}

// The Reply's first sentence mentions one of the alternatives, so the answer leads with it.
export function checkLeadsWith(reply: Reply, alternatives: string[]): CheckResult {
  const [first = ""] = sentences(reply.response);
  const ok = alternatives.some((alternative) => mentions(first, alternative));
  return { ok, detail: `${ok ? "leads with" : "doesn't lead with"} one of ${quoted(alternatives)}; first sentence is "${first}"` };
}

export function checkMaxSentences(reply: Reply, max: number): CheckResult {
  const count = countSentences(reply.response);
  return { ok: count <= max, detail: `${count} sentences, max ${max}` };
}

export function checkMaxAttachments(reply: Reply, max: number): CheckResult {
  const count = reply.attachmentUrls?.length ?? 0;
  return { ok: count <= max, detail: `${count} attachment URLs, max ${max}` };
}

export interface ExpectedCall {
  tool: string;
  // Texts that must appear in the call's JSON arguments, such as a clinic id.
  argsInclude?: string[];
}

// Every expected tool must have run without error, with arguments holding each expected text.
export function checkCalls(calls: ToolCallTrace[], expected: ExpectedCall[]): CheckResult {
  const missing = expected.filter(
    ({ tool, argsInclude = [] }) =>
      !calls.some(
        (call) => call.name === tool && !call.isError && argsInclude.every((text) => JSON.stringify(call.input).includes(text)),
      ),
  );
  const describe = ({ tool, argsInclude }: ExpectedCall) => (argsInclude?.length ? `${tool} with ${quoted(argsInclude)}` : tool);
  return {
    ok: missing.length === 0,
    detail: missing.length ? `no successful call to ${missing.map(describe).join(", ")}` : "made every expected tool call",
  };
}

// An exact value, "*" for any non-empty value, or a list of acceptable strings. Strings compare ignoring case.
export type FieldExpectation = boolean | number | null | string | string[];

function fieldAt(reply: Reply, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value == null ? undefined : (value as Record<string, unknown>)[key]), reply);
}

function fieldMatches(actual: unknown, expected: FieldExpectation): boolean {
  if (expected === "*") return actual != null && actual !== "";
  const accepted = Array.isArray(expected) ? expected : [expected];
  return accepted.some((value) =>
    typeof value === "string" && typeof actual === "string" ? value.toLowerCase() === actual.toLowerCase() : value === actual,
  );
}

// Each dotted path into the Reply, such as "workingMemoryUpdates.promisesMade", must hold the expected value.
export function checkFields(reply: Reply, expected: Record<string, FieldExpectation>): CheckResult {
  const describe = (value: FieldExpectation) =>
    value === "*" ? "a value" : Array.isArray(value) ? `one of ${quoted(value)}` : JSON.stringify(value);
  const wrong = Object.entries(expected)
    .map(([path, value]) => ({ path, value, actual: fieldAt(reply, path) }))
    .filter(({ value, actual }) => !fieldMatches(actual, value))
    .map(({ path, value, actual }) => `${path} is ${JSON.stringify(actual) ?? "undefined"}, expected ${describe(value)}`);
  return { ok: wrong.length === 0, detail: wrong.length ? wrong.join("; ") : "every field matches" };
}

export interface ExpectedSkills {
  includes?: string[];
  excludes?: string[];
}

// Every included skill ran, and no excluded one did.
export function checkSkills(skills: string[], { includes = [], excludes = [] }: ExpectedSkills): CheckResult {
  const problems = [
    ...includes.filter((id) => !skills.includes(id)).map((id) => `${id} didn't run`),
    ...excludes.filter((id) => skills.includes(id)).map((id) => `${id} ran`),
  ];
  const ran = skills.length ? skills.join(", ") : "none";
  return { ok: problems.length === 0, detail: problems.length ? `${problems.join(", ")} (skills that ran: ${ran})` : `skills that ran: ${ran}` };
}
