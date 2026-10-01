import type { Reply } from "../reply.ts";

export interface CheckResult {
  ok: boolean;
  detail: string;
}

const URL_PATTERN = /https?:\/\/\S+/g;

function quoted(values: string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

export function checkEscalate(reply: Reply, expected: boolean): CheckResult {
  return {
    ok: reply.escalate === expected,
    detail: `expected escalate ${expected}, got ${reply.escalate}`,
  };
}

export function checkIncludes(reply: Reply, required: string[]): CheckResult {
  const response = reply.response.toLowerCase();
  const missing = required.filter((value) => !response.includes(value.toLowerCase()));
  return { ok: missing.length === 0, detail: missing.length ? `missing ${quoted(missing)}` : "has every required text" };
}

export function checkExcludes(reply: Reply, forbidden: string[]): CheckResult {
  const response = reply.response.toLowerCase();
  const found = forbidden.filter((value) => response.includes(value.toLowerCase()));
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
