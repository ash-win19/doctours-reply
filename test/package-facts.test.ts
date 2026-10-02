import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPackageFacts } from "../src/eval/package-facts.ts";
import { parseCases, scoreCase } from "../src/eval/cases.ts";
import { VALID_REPLY } from "./fakes.ts";

const facts = [
  { package: "Silver", price: 3000, deposit: 500 },
  { package: "Gold", price: 4500, deposit: 600 },
];
const check = (response: string) => checkPackageFacts({ ...VALID_REPLY, response }, facts);

test("package facts accept ordinary money formats and deposit labels on either side", () => {
  for (const response of [
    "Silver is $3,000 USD with a $500 deposit. Gold is $4,500 USD with a $600 deposit.",
    "Silver: 3000 USD. The deposit is 500 USD. Gold: USD 4500. Deposit: USD 600.",
    "Gold has a $600 deposit and costs $4500. Silver has a $500 deposit and costs $3000.",
  ]) assert.equal(check(response).ok, true, check(response).detail);
});

test("containing all expected numbers does not excuse swapped packages or money roles", () => {
  for (const response of [
    "Silver is $4,500 with a $600 deposit. Gold is $3,000 with a $500 deposit.",
    "Silver is $3,000 with a $600 deposit. Gold is $4,500 with a $500 deposit.",
    "Silver is $500 with a $3,000 deposit. Gold is $600 with a $4,500 deposit.",
    "Silver and Gold prices are $3,000 and $4,500, with $500 and $600 deposits.",
    "Silver is $3,000. Gold is $4,500 with a $600 deposit. The other deposit is $500.",
  ]) assert.equal(check(response).ok, false, response);
});

test("extra contradictory prices and fractional near-matches fail", () => {
  assert.equal(check("Silver is $3,000 with a $500 deposit. Silver costs $999. Gold is $4500 with a $600 deposit.").ok, false);
  assert.equal(check("Silver is $3000.50 with a $500 deposit. Gold is $4500 with a $600 deposit.").ok, false);
});

test("correct remaining balances are distinct from package prices, and wrong balances fail", () => {
  const response = "Silver costs $3,000 with a $500 deposit; the remaining balance is $2,500. Gold costs $4,500 with a $600 deposit; the remaining balance is $3,900.";
  assert.equal(check(response).ok, true, check(response).detail);
  assert.equal(check(response.replace("$2,500", "$2,400")).ok, false);
});

test("package fact checks are parsed and enforced by the case scorer", () => {
  const [evalCase] = parseCases(JSON.stringify([{
    id: "prices", group: "pricing", rule: "fresh package facts", text: "Compare packages", expect: { packageFacts: facts },
  }]), "test");
  const response = "Silver costs $4500 with a $600 deposit. Gold costs $3000 with a $500 deposit.";
  assert.equal(scoreCase(evalCase, { ...VALID_REPLY, response }).passed, false);
});
