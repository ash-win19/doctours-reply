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
  return text.toLowerCase().replaceAll("$", "").replace(/(\d),(?=\d{3}\b)/g, "$1");
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
  return { ok: true, detail: "matches the Reply schema with a null templateId" };
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

export function countSentences(text: string): number {
  return text
    .replace(URL_PATTERN, "")
    .split(/[.?!]/)
    .filter((part) => part.trim().length > 0).length;
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
    .filter(([path, value]) => !fieldMatches(fieldAt(reply, path), value))
    .map(([path, value]) => `${path} is ${JSON.stringify(fieldAt(reply, path)) ?? "undefined"}, expected ${describe(value)}`);
  return { ok: wrong.length === 0, detail: wrong.length ? wrong.join("; ") : "every field matches" };
}
