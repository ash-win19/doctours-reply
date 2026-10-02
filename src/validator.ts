import { escalationReply, VALIDATION_FAILED } from "./escalation.ts";
import type { Reply } from "./reply.ts";
import { redactCardData } from "./guards.ts";
import type { SubmitOutcome } from "./tool-loop.ts";
import { runTool, type ToolRun, type ToolContext } from "./tools.ts";

// What this turn's tool results said, collected as they arrive. A Reply may only repeat URLs and amounts found here.
export interface TurnEvidence {
  toolUrls: Set<string>;
  // Money values in this turn's tool results: numbers under a price, amount, deposit, fee or cost key, and numbers
  // written next to "$" or "USD" in text. Ids and counts never count.
  amounts: Set<number>;
  // Clinic slugs a tool returned, which build Doctours clinic pages.
  slugs: Set<string>;
  // Card digit runs the guards found in the Patient's raw message, which a Reply must never repeat.
  inputCardDigits: string[];
}

export function emptyEvidence(inputCardDigits: string[] = []): TurnEvidence {
  return { toolUrls: new Set(), amounts: new Set(), slugs: new Set(), inputCardDigits };
}

const URL_PATTERN = /https?:\/\/[^\s<>()"'`]+/g;

// A URL as written in a sentence, without punctuation that ends the sentence.
function cleanUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/, "");
}

function urlsIn(text: string): string[] {
  return (text.match(URL_PATTERN) ?? []).map(cleanUrl);
}

const MONEY_KEY = /price|amount|deposit|fee|cost|balance|total/i;
const AMOUNT_PATTERN = /\$\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?USD\b|\bUSD\s?(\d[\d,]*(?:\.\d+)?)/gi;

function amountsIn(text: string): number[] {
  return [...text.matchAll(AMOUNT_PATTERN)].map((match) => Number((match[1] ?? match[2] ?? match[3]).replaceAll(",", "")));
}

// Walks a tool result for URLs, money values and slugs.
function walk(value: unknown, key: string, evidence: TurnEvidence): void {
  if (Array.isArray(value)) value.forEach((item) => walk(item, key, evidence));
  else if (value && typeof value === "object") {
    for (const [childKey, item] of Object.entries(value)) walk(item, childKey, evidence);
  } else if (typeof value === "number") {
    if (MONEY_KEY.test(key)) evidence.amounts.add(value);
  } else if (typeof value === "string") {
    if (key === "slug") evidence.slugs.add(value);
    for (const url of urlsIn(value)) evidence.toolUrls.add(url);
    for (const amount of amountsIn(value)) evidence.amounts.add(amount);
  }
}

// Adds one tool result to the turn's evidence.
export function collectEvidence(evidence: TurnEvidence, output: unknown): void {
  walk(output, "", evidence);
}

// Runs a tool, adding a successful result to the evidence when the Reply will be validated.
export function runToolForEvidence(
  name: string,
  input: unknown,
  context: ToolContext,
  evidence: TurnEvidence | null,
): ToolRun {
  const raw = runTool(name, input, context);
  const run = evidence ? redactCardData(raw) : raw;
  if (evidence && !run.isError) collectEvidence(evidence, run.output);
  return run;
}

// Links a Reply may carry without a tool returning them this turn. The core prompt lists the same ones.
export const STATIC_URLS = [
  { url: "https://www.doctours.com/consultation", use: "book the free consultation" },
  { url: "https://www.doctours.com/image-upload", use: "intake photos" },
];
export const CLINIC_PAGE_TEMPLATE = "https://www.doctours.com/clinic/{slug}";
const CLINIC_PAGE = /^https:\/\/www\.doctours\.com\/clinic\/([a-z0-9-]+)\/?$/;
export const MAX_ATTACHMENTS = 3;

function isAllowedUrl(url: string, evidence: TurnEvidence): boolean {
  if (evidence.toolUrls.has(url) || STATIC_URLS.some((link) => link.url === url.replace(/\/$/, ""))) return true;
  const slug = url.match(CLINIC_PAGE)?.[1];
  return slug !== undefined && evidence.slugs.has(slug);
}

export type CheckName = "unknown URLs" | "amounts" | "banned phrases" | "attachments" | "response";

export interface Failure {
  name: CheckName;
  detail: string;
}

export interface FixResult {
  reply: Reply;
  fixes: string[];
  // A fix that removed something the Patient may need asks for a repair, so the Reply isn't left pointing at nothing.
  failures?: Failure[];
}

// Any URL that no tool returned this turn and isn't on the static allowlist goes, along with its line.
export function fixUnknownUrls(reply: Reply, evidence: TurnEvidence): FixResult {
  const removed: string[] = [];
  const lines = reply.response.split("\n").filter((line) => {
    const unknown = urlsIn(line).filter((url) => !isAllowedUrl(url, evidence));
    removed.push(...unknown);
    return unknown.length === 0;
  });
  if (removed.length === 0) return { reply, fixes: [] };
  return {
    reply: { ...reply, response: lines.join("\n").trim() },
    fixes: removed.map((url) => `removed ${url}, which no tool returned, and its line`),
    failures: removed.map((url) => ({
      name: "unknown URLs",
      detail: `Removed ${url}: no tool returned it this turn. If the Patient needs it, call the tool that returns it.`,
    })),
  };
}

// Closes the gaps left after removing text from a line: doubled spaces and a space before punctuation.
function closeGaps(line: string): string {
  return line.replace(/[ \t]{2,}/g, " ").replace(/ +([.,;:!?])/g, "$1").trim();
}

// URLs go on the last lines, one per line, in order of first mention. One in a sentence becomes "the link below".
export function fixUrlPlacement(reply: Reply): FixResult {
  const urls = [...new Set(urlsIn(reply.response))];
  if (urls.length === 0) return { reply, fixes: [] };
  const body = reply.response
    .split("\n")
    .filter((line) => !urls.includes(cleanUrl(line.trim())))
    .map((line) =>
      urlsIn(line).length ? closeGaps(line.replace(URL_PATTERN, (url) => url.replace(cleanUrl(url), "the link below"))) : line,
    );
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

function spacedDigits(digits: string): string {
  return digits.split("").join("[ -]?");
}

// Wording that introduces a card's last four digits, such as "ending in" or "last four are".
const CARD_ENDING_WORDS = String.raw`(?:(?:ending|ends)(?:\s+(?:in|with))?\s+|last\s+(?:four|4)(?:\s+digits)?(?:\s+(?:are|is))?[:\s]\s*)`;

// A second safety after redaction: the card numbers the guards found never go back out. Whole runs go anywhere,
// and the last four go where they follow "ending in" style wording, so a matching year in ordinary text stays.
export function fixCardDigits(reply: Reply, evidence: TurnEvidence): FixResult {
  const patterns = evidence.inputCardDigits.flatMap((digits) => [
    ...(digits.length > 4 ? [new RegExp(`(?<!\\d)${spacedDigits(digits)}(?!\\d)`, "g")] : []),
    new RegExp(`(?<=${CARD_ENDING_WORDS})${spacedDigits(digits.slice(-4))}(?!\\d)`, "gi"),
  ]);
  const stripped = patterns.reduce((text, pattern) => text.replace(pattern, ""), reply.response);
  if (stripped === reply.response) return { reply, fixes: [] };
  const response = stripped.split("\n").map(closeGaps).join("\n");
  return { reply: { ...reply, response }, fixes: ["removed card digits from the Patient's message"] };
}

// Fields that must agree with each other, whatever the model wrote. The tool loop already sets templateId.
export function fixFieldConsistency(reply: Reply): FixResult {
  const fixes: string[] = [];
  const fixed = { ...reply };
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
  name: CheckName;
  ok: boolean;
  detail: string;
}

// Amounts a Reply may state without a tool returning them, each with the source rule that sets it.
const POLICY_AMOUNTS = [{ amount: 25, rule: "REVERSIBILITY and OPERATIONAL KNOWLEDGE 6: the Deposit's $25 cancellation fee" }];

const list = (items: string[]) => new Intl.ListFormat("en", { type: "conjunction" }).format(items);

// Every amount next to "$" or "USD" must be a money value in this turn's tool results, or a policy amount.
export function checkAmounts(reply: Reply, evidence: TurnEvidence): NamedCheck {
  const known = new Set([...evidence.amounts, ...POLICY_AMOUNTS.map(({ amount }) => amount)]);
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
  // The sentence is allowed when it also matches this.
  unless?: RegExp;
}

const TIME_WINDOW = String.raw`(?:(?:in|within|about|around|under|over)\s+)?(?:\d+\s*(?:-|to)\s*\d+|a few|a couple(?: of)?|\d+|an?|one|two|three)\s+(?:business\s+)?(?:hours?|days?|weeks?)\b|\blater today\b|\b(?:by\s+)?(?:tomorrow|tonight)\b|\bby (?:the end of (?:the )?(?:day|week)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\bwithin the next\s+(?:\w+\s+)?(?:hours?|days?|weeks?)\b`;
const DELIVERY = String.raw`\b(?:ready|done|finish(?:ed|es)?|complete(?:d)?|back|sent|deliver(?:ed)?)\b`;
// A window tied to the assessment being ready, done, back, sent or delivered, in either order, within one clause.
const TURNAROUND = new RegExp(
  String.raw`\bassessment\b[^.?!,;]{0,40}?${DELIVERY}[^.?!,;]{0,25}?(?:${TIME_WINDOW})|${DELIVERY}[^.?!,;]{0,25}?\bassessment\b[^.?!,;]{0,25}?(?:${TIME_WINDOW})`,
  "i",
);

const HEAD_COVERING = String.raw`(?:hats?|caps?|beanies?|hoods?|headbands?|scarf|scarves|bandanas?|hijabs?|head ?wraps?|head ?coverings?)`;
const ADVICE_VERB = String.raw`(?:bring(?:ing)?|pack(?:ing)?|wear(?:ing)?|buy(?:ing)?|pick(?:ing)? out)`;

// The spec's banned phrases, each next to the source prompt rule that bans it.
export const BANNED_PHRASES: BannedPhrase[] = [
  { pattern: TURNAROUND, rule: "GUIDELINES, No assessment turnaround promises" },
  { pattern: /\bI['’]?ll get back to you\b/i, rule: "CAPABILITIES & CONSTRAINTS: never stall" },
  { pattern: /\ba coordinator will\b/i, rule: "VOICE (SINGLE COMMUNICATOR): never say a coordinator will help" },
  { pattern: /\bsomeone from (?:our|the) team\b/i, rule: "VOICE (SINGLE COMMUNICATOR): never say someone from our team will help" },
  {
    pattern: new RegExp(String.raw`\b${ADVICE_VERB}\b[^.?!]{0,30}?\b${HEAD_COVERING}\b`, "i"),
    // Negated advice, and saying when they can wear one again, are fine.
    unless: new RegExp(
      String.raw`\b(?:don['’]?t|do not|never|avoid|no|not|without)\b[^.?!]{0,20}?\b${ADVICE_VERB}\b|\b(?:two|2)\s+weeks\b|\bagain\b`,
      "i",
    ),
    rule: "GUIDELINES, No head-covering advice: nothing goes on the head for about two weeks after the procedure",
  },
];

export function checkBannedPhrases(reply: Reply): NamedCheck {
  const found: string[] = [];
  for (const sentence of reply.response.split(/(?<=[.!?])\s+|\n/)) {
    for (const { pattern, rule, unless } of BANNED_PHRASES) {
      const match = sentence.match(pattern);
      if (!match || unless?.test(sentence)) continue;
      found.push(`"${match[0]}" (${rule})`);
    }
  }
  return { name: "banned phrases", ok: found.length === 0, detail: found.length ? found.join("; ") : "no banned phrases" };
}

// A Reply carries at most 3 attachments, and only hosted URLs a tool returned this turn.
export function checkAttachments(reply: Reply, evidence: TurnEvidence): NamedCheck {
  const urls = reply.attachmentUrls ?? [];
  const problems = [
    ...(urls.length > MAX_ATTACHMENTS ? [`${urls.length} attachment URLs, at most ${MAX_ATTACHMENTS}`] : []),
    ...urls.filter((url) => !evidence.toolUrls.has(url)).map((url) => `${url} wasn't returned by a tool`),
  ];
  return { name: "attachments", ok: problems.length === 0, detail: problems.length ? problems.join("; ") : "attachments are fine" };
}

// Sanitize before validation. Every delivered Reply must obey
// the attachment contract even if the model never produces a better Reply.
function fixAttachments(reply: Reply, evidence: TurnEvidence): FixResult {
  const check = checkAttachments(reply, evidence);
  if (check.ok) return { reply, fixes: [] };
  const urls = (reply.attachmentUrls ?? []).filter((url) => evidence.toolUrls.has(url)).slice(0, MAX_ATTACHMENTS);
  return {
    reply: { ...reply, attachmentUrls: urls.length ? urls : null },
    fixes: [`filtered attachmentUrls to tool-returned URLs, at most ${MAX_ATTACHMENTS}: ${check.detail}`],
    // The response may refer to removed photos. Let the model revise it or fetch evidence.
    failures: [{ name: check.name, detail: check.detail }],
  };
}

export interface ValidationResult extends FixResult {
  // What still needs the model: fixes that removed something the Patient may need, then checks that fail.
  failures: Failure[];
  checks: NamedCheck[];
}

const FIXES: ((reply: Reply, evidence: TurnEvidence) => FixResult)[] = [
  fixFieldConsistency,
  fixMarkdown,
  fixCardDigits,
  fixUnknownUrls,
  fixUrlPlacement,
  fixAttachments,
];

const CHECKS: ((reply: Reply, evidence: TurnEvidence) => NamedCheck)[] = [
  checkAmounts, checkBannedPhrases, checkAttachments,
  (reply) => ({ name: "response", ok: reply.response.trim().length > 0, detail: reply.response.trim() ? "response is nonempty" : "response is empty" }),
];

// Code fixes first, then the checks that need the model to rewrite. Never changes `escalate`.
export function validate(reply: Reply, evidence: TurnEvidence): ValidationResult {
  const fixes: string[] = [];
  const failures: Failure[] = [];
  let current = reply;
  for (const fix of FIXES) {
    const result = fix(current, evidence);
    current = result.reply;
    fixes.push(...result.fixes);
    failures.push(...(result.failures ?? []));
  }
  const checks = CHECKS.map((check) => check(current, evidence));
  failures.push(...checks.filter((check) => !check.ok).map(({ name, detail }) => ({ name, detail })));
  return { reply: current, fixes, failures, checks };
}

export interface ValidationTrace {
  // One run per submitted Reply: the code fixes applied and every check's result after them.
  runs: { fixes: string[]; checks: NamedCheck[]; failures: Failure[] }[];
  repairRan: boolean;
  // Which version shipped once validation finished.
  shipped: "first" | "repaired" | "escalation" | null;
}

export function emptyValidationTrace(): ValidationTrace {
  return { runs: [], repairRan: false, shipped: null };
}

function repairRequest(failures: Failure[]): string {
  return [
    "Your Reply was not sent. Fix these problems and call submitReply again with the whole Reply:",
    ...failures.map(({ name, detail }) => `- ${name}: ${detail}`),
  ].join("\n");
}

// Only a passing Reply can ship. One bounded repair may fetch fresh evidence; if it
// still fails or never submits, an Operator takes over. Escalation always ends the turn.
export function validatingSubmit(evidence: TurnEvidence, trace: ValidationTrace): (reply: Reply) => SubmitOutcome {
  let repairing = false;
  const fallback = (): Reply => {
    trace.shipped = "escalation";
    return escalationReply(VALIDATION_FAILED, null);
  };
  return (submitted) => {
    if (submitted.escalate) {
      trace.shipped = "escalation";
      return { reply: escalationReply(submitted.escalationReason?.trim() || "Responder requested an Operator", null) };
    }
    const result = validate(submitted, evidence);
    trace.runs.push({ fixes: result.fixes, checks: result.checks, failures: result.failures });
    if (result.failures.length === 0) {
      trace.shipped = repairing ? "repaired" : "first";
      return { reply: result.reply };
    }
    if (repairing) return { reply: fallback() };
    repairing = true;
    trace.repairRan = true;
    return { repair: repairRequest(result.failures), fallback };
  };
}
