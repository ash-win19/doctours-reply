import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseMessages } from "./cli.ts";
import { defaultRunnerDeps, log } from "./deps.ts";
import { ReplySchema } from "./reply.ts";
import { isDraftingFailure, parseMode, runMessages } from "./runner.ts";

// Runs the packet's five messages and checks the output contract plus each expected escalate value.
// The expectations stay here and never reach the model.
const { values } = parseArgs({ options: { mode: { type: "string", default: "baseline" } } });
const mode = parseMode(values.mode);

const messages = parseMessages(readFileSync("fixtures/packet-messages.json", "utf8"));
const expectedEscalate: Record<string, boolean> = JSON.parse(
  readFileSync("fixtures/packet-expected-escalate.json", "utf8"),
);

const replies = await runMessages(messages, mode, defaultRunnerDeps());
const failures: string[] = [];
if (replies.length !== messages.length) {
  failures.push(`expected ${messages.length} replies, got ${replies.length}`);
}
messages.forEach((message, index) => {
  const reply = replies[index];
  const parsed = ReplySchema.safeParse(reply);
  if (!parsed.success) failures.push(`${message.id}: Reply does not match the schema`);
  if (reply?.templateId !== null) failures.push(`${message.id}: templateId is not null`);
  if (reply && isDraftingFailure(reply)) {
    failures.push(`${message.id}: the model never finished a Reply (see its trace)`);
  } else if (reply?.escalate !== expectedEscalate[message.id]) {
    failures.push(`${message.id}: escalate is ${reply?.escalate}, expected ${expectedEscalate[message.id]}`);
  }
  log(`${message.id}: ${JSON.stringify(reply?.response)}`);
});

log(failures.length ? `FAIL\n${failures.join("\n")}` : `PASS: ${messages.length} schema-valid replies`);
process.exitCode = failures.length ? 1 : 0;
