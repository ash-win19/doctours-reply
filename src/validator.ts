import type { Reply } from "./reply.ts";
import type { SubmitOutcome } from "./tool-loop.ts";

// What this turn's tool results said, collected as they arrive. A Reply may only repeat URLs and amounts found here.
export interface TurnEvidence {
  toolUrls: Set<string>;
  // Every tool result this turn, as JSON text.
  toolText: string;
  // Clinic slugs a tool returned, which build Doctours clinic pages.
  slugs: Set<string>;
  // Card digit runs in the Patient's raw message, which a Reply must never repeat.
  inputCardDigits: string[];
}

export function emptyEvidence(inputCardDigits: string[] = []): TurnEvidence {
  return { toolUrls: new Set(), toolText: "", slugs: new Set(), inputCardDigits };
}

const URL_PATTERN = /https?:\/\/[^\s<>()"'`]+/g;

// A URL as written in a sentence, without punctuation that ends the sentence.
function cleanUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/, "");
}

function urlsIn(text: string): string[] {
  return (text.match(URL_PATTERN) ?? []).map(cleanUrl);
}

function collectSlugs(value: unknown, slugs: Set<string>): void {
  if (Array.isArray(value)) value.forEach((item) => collectSlugs(item, slugs));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "slug" && typeof item === "string") slugs.add(item);
      else collectSlugs(item, slugs);
    }
  }
}

// Adds one tool result to the turn's evidence.
export function collectEvidence(evidence: TurnEvidence, output: unknown): void {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? null);
  evidence.toolText += `${text}\n`;
  for (const url of urlsIn(text)) evidence.toolUrls.add(url);
  collectSlugs(output, evidence.slugs);
}

// Links a Reply may carry without a tool returning them this turn.
const STATIC_URLS = ["https://www.doctours.com/consultation", "https://www.doctours.com/image-upload"];
const CLINIC_PAGE = /^https:\/\/www\.doctours\.com\/clinic\/([a-z0-9-]+)\/?$/;

function isAllowedUrl(url: string, evidence: TurnEvidence): boolean {
  if (evidence.toolUrls.has(url) || STATIC_URLS.includes(url.replace(/\/$/, ""))) return true;
  const slug = url.match(CLINIC_PAGE)?.[1];
  return slug !== undefined && evidence.slugs.has(slug);
}

export interface FixResult {
  reply: Reply;
  fixes: string[];
}

// Any URL that no tool returned this turn and isn't on the static allowlist goes, along with its line.
export function fixUnknownUrls(reply: Reply, evidence: TurnEvidence): FixResult {
  const fixes: string[] = [];
  const lines = reply.response.split("\n").filter((line) => {
    const unknown = urlsIn(line).filter((url) => !isAllowedUrl(url, evidence));
    for (const url of unknown) fixes.push(`removed ${url}, which no tool returned, and its line`);
    return unknown.length === 0;
  });
  return { reply: fixes.length ? { ...reply, response: lines.join("\n").trim() } : reply, fixes };
}

// Tidies what's left after removing text from a line: doubled spaces and a space before punctuation.
function tidy(line: string): string {
  return line.replace(/[ \t]{2,}/g, " ").replace(/ +([.,;:!?])/g, "$1").trim();
}

// URLs go on the last lines, one per line, in order of first mention. One in a sentence becomes "the link below".
export function fixUrlPlacement(reply: Reply): FixResult {
  const urls = [...new Set(urlsIn(reply.response))];
  if (urls.length === 0) return { reply, fixes: [] };
  const body = reply.response
    .split("\n")
    .filter((line) => !urls.includes(cleanUrl(line.trim())))
    .map((line) => (urlsIn(line).length ? tidy(line.replace(URL_PATTERN, (url) => url.replace(cleanUrl(url), "the link below"))) : line));
  const response = [body.join("\n").trimEnd(), ...urls].join("\n").trim();
  if (response === reply.response.trim()) return { reply, fixes: [] };
  return { reply: { ...reply, response }, fixes: ["moved URLs to the last lines"] };
}

const MARKDOWN_LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
const INLINE_MARKERS: [RegExp, string][] = [
  [/\*\*(.+?)\*\*/g, "$1"],
  [/__(.+?)__/g, "$1"],
  [/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "$1"],
  [/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "$1"],
  [/`/g, ""],
];

function stripMarkdown(line: string): string {
  const plain = line.replace(/^#{1,6}\s+/, "").replace(/^\s*[-*+]\s+/, "").replace(MARKDOWN_LINK, "$1 $2");
  // Odd parts are URLs, which keep their underscores and asterisks.
  return plain
    .split(/(https?:\/\/[^\s<>()"'`]+)/)
    .map((part, index) => (index % 2 ? part : INLINE_MARKERS.reduce((text, [pattern, to]) => text.replace(pattern, to), part)))
    .join("");
}

// The Reply is read as plain SMS, so markdown would show as raw characters.
export function fixMarkdown(reply: Reply): FixResult {
  const response = reply.response.split("\n").map(stripMarkdown).join("\n");
  if (response === reply.response) return { reply, fixes: [] };
  return { reply: { ...reply, response }, fixes: ["stripped markdown"] };
}

function digitPattern(digits: string): RegExp {
  return new RegExp(`(?<!\\d)${digits.split("").join("[ -]?")}(?!\\d)`, "g");
}

// A second safety after redaction: the Patient's card digits, and their last four, never go back out.
export function fixCardDigits(reply: Reply, evidence: TurnEvidence): FixResult {
  const patterns = evidence.inputCardDigits.flatMap((digits) => [digitPattern(digits), digitPattern(digits.slice(-4))]);
  const stripped = patterns.reduce((text, pattern) => text.replace(pattern, ""), reply.response);
  if (stripped === reply.response) return { reply, fixes: [] };
  const response = stripped.split("\n").map(tidy).join("\n");
  return { reply: { ...reply, response }, fixes: ["removed card digits from the Patient's message"] };
}

// Fields that must agree with each other, whatever the model wrote.
export function fixFieldConsistency(reply: Reply): FixResult {
  const fixes: string[] = [];
  const fixed = { ...reply };
  if (fixed.templateId !== null) {
    fixed.templateId = null;
    fixes.push("set templateId to null");
  }
  if (!fixed.escalate && fixed.escalationReason !== null) {
    fixed.escalationReason = null;
    fixes.push("set escalationReason to null because escalate is false");
  }
  if (!fixed.shouldFollowUp && fixed.followUpTiming !== null) {
    fixed.followUpTiming = null;
    fixes.push("set followUpTiming to null because shouldFollowUp is false");
  }
  if (fixed.attachmentUrls?.length === 0) {
    fixed.attachmentUrls = null;
    fixes.push("set empty attachmentUrls to null");
  }
  return { reply: fixes.length ? fixed : reply, fixes };
}

export interface NamedCheck {
  name: string;
  ok: boolean;
  detail: string;
}

// Amounts a Reply may state without a tool returning them, each with the source rule that sets it.
const POLICY_AMOUNTS = [{ amount: 25, rule: "REVERSIBILITY and OPERATIONAL KNOWLEDGE 6: the Deposit's $25 cancellation fee" }];

const AMOUNT_PATTERN = /\$\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?USD\b|\bUSD\s?(\d[\d,]*(?:\.\d+)?)/gi;

const list = (items: string[]) => new Intl.ListFormat("en", { type: "conjunction" }).format(items);

// Every amount next to "$" or "USD" must appear as a number in this turn's tool results, or be a policy amount.
export function checkAmounts(reply: Reply, evidence: TurnEvidence): NamedCheck {
  const known = new Set([
    ...(evidence.toolText.match(/\d+(?:\.\d+)?/g) ?? []).map(Number),
    ...POLICY_AMOUNTS.map(({ amount }) => amount),
  ]);
  const unknown = [...reply.response.matchAll(AMOUNT_PATTERN)]
    .filter((match) => !known.has(Number((match[1] ?? match[2] ?? match[3]).replaceAll(",", ""))))
    .map((match) => match[0].trim());
  const policy = `the policy amounts (${POLICY_AMOUNTS.map(({ amount }) => `$${amount}`).join(", ")})`;
  return {
    name: "amounts",
    ok: unknown.length === 0,
    detail: unknown.length
      ? `${list(unknown)} ${unknown.length === 1 ? "isn't" : "aren't"} in this turn's tool results or ${policy}`
      : "every amount is in this turn's tool results or the policy amounts",
  };
}

interface BannedPhrase {
  pattern: RegExp;
  // The source rule that bans it.
  rule: string;
  // The phrase only counts when the same sentence also matches this.
  onlyWith?: RegExp;
  // The sentence is allowed when it also matches this.
  unless?: RegExp;
}

const TIME_WINDOW =
  /\b(?:\d+\s*(?:-|to)\s*\d+|a few|a couple(?: of)?|\d+|one|two|three)\s+(?:business\s+)?(?:hours?|days?|weeks?)\b|\blater today\b|\bby (?:tomorrow|tonight|the end of (?:the )?(?:day|week)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\bwithin (?:a|an|one|\d+|a few|the next)\s+(?:\w+\s+)?(?:hours?|days?|weeks?)\b|\btomorrow\b/i;

// Phrases no Reply may send, each next to the source prompt rule that bans it.
export const BANNED_PHRASES: BannedPhrase[] = [
  { pattern: TIME_WINDOW, onlyWith: /\bassessment\b/i, rule: "GUIDELINES, No assessment turnaround promises" },
  { pattern: /\bI['’]?ll get back to you\b|\blet me (?:look into|check)\b|\bI['’]?ll find out\b/i, rule: "CAPABILITIES & CONSTRAINTS: never stall" },
  { pattern: /\ba coordinator will\b/i, rule: "VOICE (SINGLE COMMUNICATOR): never say a coordinator will help" },
  { pattern: /\bsomeone from (?:our|the) team\b|\ba (?:team member|specialist) will\b/i, rule: "VOICE (SINGLE COMMUNICATOR): never say someone from our team will help" },
  {
    pattern:
      /\b(?:bring|pack|wear|buy|pick out|get|use|grab)\b[^.?!]{0,30}?\b(?:hats?|caps?|beanies?|hoods?|headbands?|scarf|scarves|bandanas?|hijabs?|head ?wraps?|head ?coverings?)\b/i,
    unless: /\b(?:two|2)\s+weeks\b|\bagain\b/i,
    rule: "GUIDELINES, No head-covering advice: nothing goes on the head for about two weeks after the procedure",
  },
];

export function checkBannedPhrases(reply: Reply): NamedCheck {
  const found: string[] = [];
  for (const sentence of reply.response.split(/(?<=[.!?])\s+|\n/)) {
    for (const { pattern, rule, onlyWith, unless } of BANNED_PHRASES) {
      const match = sentence.match(pattern);
      if (!match || (onlyWith && !onlyWith.test(sentence)) || unless?.test(sentence)) continue;
      found.push(`"${match[0]}" (${rule})`);
    }
  }
  return { name: "banned phrases", ok: found.length === 0, detail: found.length ? found.join("; ") : "no banned phrases" };
}

const MAX_ATTACHMENTS = 3;

// A Reply carries at most 3 attachments, and only hosted URLs a tool returned this turn.
export function checkAttachments(reply: Reply, evidence: TurnEvidence): NamedCheck {
  const urls = reply.attachmentUrls ?? [];
  const problems = [
    ...(urls.length > MAX_ATTACHMENTS ? [`${urls.length} attachment URLs, at most ${MAX_ATTACHMENTS}`] : []),
    ...urls.filter((url) => !evidence.toolUrls.has(url)).map((url) => `${url} wasn't returned by a tool`),
  ];
  return { name: "attachments", ok: problems.length === 0, detail: problems.length ? problems.join("; ") : "attachments are fine" };
}

export interface ValidationResult extends FixResult {
  // Checks that still fail after the code fixes. These are what a repair turn is asked to fix.
  failures: { name: string; detail: string }[];
  checks: NamedCheck[];
}

const FIXES: ((reply: Reply, evidence: TurnEvidence) => FixResult)[] = [
  fixFieldConsistency,
  fixMarkdown,
  fixCardDigits,
  fixUnknownUrls,
  fixUrlPlacement,
];

const CHECKS: ((reply: Reply, evidence: TurnEvidence) => NamedCheck)[] = [checkAmounts, checkBannedPhrases, checkAttachments];

// Code fixes first, then the checks that need the model to rewrite. Never changes `escalate`.
export function validate(reply: Reply, evidence: TurnEvidence): ValidationResult {
  const fixes: string[] = [];
  let current = reply;
  for (const fix of FIXES) {
    const result = fix(current, evidence);
    current = result.reply;
    fixes.push(...result.fixes);
  }
  const checks = CHECKS.map((check) => check(current, evidence));
  const failures = checks.filter((check) => !check.ok).map(({ name, detail }) => ({ name, detail }));
  return { reply: current, fixes, failures, checks };
}

export interface ValidationTrace {
  // One run per submitted Reply: the code fixes applied and every check's result after them.
  runs: { fixes: string[]; checks: NamedCheck[] }[];
  repairRan: boolean;
  // Which version shipped once validation finished.
  shipped: "first" | "repaired" | null;
}

export function emptyValidationTrace(): ValidationTrace {
  return { runs: [], repairRan: false, shipped: null };
}

function repairRequest(failures: ValidationResult["failures"]): string {
  return [
    "Your Reply was not sent. Fix these problems and call submitReply again with the whole Reply:",
    ...failures.map(({ name, detail }) => `- ${name}: ${detail}`),
  ].join("\n");
}

// Validates each submitted Reply. While checks still fail after the code fixes, the model gets one repair turn,
// and then the version with fewer failures ships. Failures that remain stay in the trace.
export function validatingSubmit(evidence: TurnEvidence, trace: ValidationTrace): (reply: Reply) => SubmitOutcome {
  let first: ValidationResult | null = null;
  return (submitted) => {
    const result = validate(submitted, evidence);
    trace.runs.push({ fixes: result.fixes, checks: result.checks });
    if (first) {
      const repairedIsBetter = result.failures.length <= first.failures.length;
      trace.shipped = repairedIsBetter ? "repaired" : "first";
      return { reply: repairedIsBetter ? result.reply : first.reply };
    }
    trace.shipped = "first";
    if (result.failures.length === 0) return { reply: result.reply };
    first = result;
    trace.repairRan = true;
    return { repair: repairRequest(result.failures), fallback: result.reply };
  };
}
