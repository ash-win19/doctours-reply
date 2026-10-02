import { z } from "zod";

// Parses JSON text and validates it, with errors that name where the text came from and what it should be.
export function parseJsonAs<Schema extends z.ZodType>(raw: string, schema: Schema, source: string, expected: string): z.output<Schema> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`${source} ${expected}\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
