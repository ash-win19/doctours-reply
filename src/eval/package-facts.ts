import type { Reply } from "../reply.ts";
import type { CheckResult } from "./checks.ts";

export interface PackageFact {
  package: string;
  price: number;
  deposit: number;
}

const MONEY = /\$\s*(\d[\d,]*(?:\.\d+)?)|\bUSD\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*USD\b/gi;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A deterministic attribution check for short package summaries, not a semantic judge.
// Each named package owns the text until the next package mention. The nearest
// deposit label on either side of a monetary amount determines its role.
export function checkPackageFacts(reply: Reply, facts: PackageFact[]): CheckResult {
  const names = facts.map((fact) => fact.package);
  const pattern = new RegExp(`\\b(?:${names.map(escape).join("|")})\\b`, "gi");
  const text = reply.response.replace(/https?:\/\/\S+/g, "");
  const mentions = [...text.matchAll(pattern)];
  const problems: string[] = [];
  for (const fact of facts) {
    const found = { price: [] as number[], deposit: [] as number[], balance: [] as number[] };
    for (let i = 0; i < mentions.length; i++) {
      const mention = mentions[i];
      if (mention[0].toLowerCase() !== fact.package.toLowerCase()) continue;
      const segment = text.slice(mention.index! + mention[0].length, mentions[i + 1]?.index ?? text.length);
      const amounts = [...segment.matchAll(MONEY)];
      for (let j = 0; j < amounts.length; j++) {
        const amount = amounts[j];
        const previous = amounts[j - 1];
        const before = segment.slice(previous ? previous.index! + previous[0].length : 0, amount.index);
        const after = segment.slice(amount.index! + amount[0].length, amounts[j + 1]?.index ?? segment.length);
        const prefix = /\bdeposit\s*(?:is|of|:|=|would be)?\s*$/i.test(before);
        const suffix = /^\s*(?:USD\s*)?(?:refundable\s+)?deposit\b/i.test(after);
        const balance = /\b(?:remaining\s+balance|balance|remainder)\s*(?:is|of|:|=|would be)?\s*$/i.test(before)
          || /^\s*(?:USD\s*)?(?:remaining(?:\s+balance)?|balance|remainder)\b/i.test(after);
        const value = Number((amount[1] ?? amount[2] ?? amount[3]).replaceAll(",", ""));
        found[prefix || suffix ? "deposit" : balance ? "balance" : "price"].push(value);
      }
    }
    if (found.balance.some((value) => value !== fact.price - fact.deposit)) {
      problems.push(`${fact.package} remaining balance must be ${fact.price - fact.deposit}`);
    }
    for (const role of ["price", "deposit"] as const) {
      const values = found[role];
      if (!values.includes(fact[role]) || values.some((value) => value !== fact[role])) {
        problems.push(`${fact.package} ${role}: expected ${fact[role]}, found ${values.join(", ") || "none"}`);
      }
    }
  }
  return { ok: problems.length === 0, detail: problems.join("; ") || "each package has its own price and deposit" };
}
