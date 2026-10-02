import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { defaultRunnerDeps, log } from "./deps.ts";
import { parseMode, type Mode } from "./pipeline.ts";
import { runMessages, type HumanMessage } from "./runner.ts";

const MessagesSchema = z.array(z.object({ id: z.string(), text: z.string() }));

export interface CliArgs {
  mode: Mode;
  out: string | undefined;
  inputPath: string | undefined;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { mode: { type: "string" }, out: { type: "string" } },
    allowPositionals: true,
  });
  const mode = parseMode(values.mode);
  if (positionals.length > 1) {
    throw new Error("Pass at most one input file");
  }
  return { mode, out: values.out, inputPath: positionals[0] };
}

export function parseMessages(raw: string): HumanMessage[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("Input is not valid JSON");
  }
  const parsed = MessagesSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Input must be a JSON array of {id: string, text: string}\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.inputPath && process.stdin.isTTY) {
    throw new Error("Pass a messages file or pipe the messages into stdin");
  }
  const raw = args.inputPath ? readFileSync(args.inputPath, "utf8") : readFileSync(process.stdin.fd, "utf8");
  const messages = parseMessages(raw);
  const { results } = await runMessages(messages, args.mode, defaultRunnerDeps());
  const replies = results.map((result) => result.reply);
  const output = `${JSON.stringify(replies, null, 2)}\n`;
  if (args.out) {
    writeFileSync(args.out, output);
    log(`Wrote ${replies.length} replies to ${args.out}`);
  } else {
    process.stdout.write(output);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
