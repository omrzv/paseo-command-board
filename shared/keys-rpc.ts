import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** A name's environment variable: "OpenAI prod" → OPENAI_PROD. */
export function envVarFor(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** A key's details. The value itself stays in the macOS Keychain and is only sent by `keys.reveal`. */
export const keyEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The environment variable it goes in, e.g. OPENAI_API_KEY. */
  envVar: z.string(),
  /** openai | anthropic | github | slack | other: picks the test. */
  service: z.string(),
  note: z.string(),
  /** The value's first and last characters, for telling keys apart. */
  hint: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  test: z.object({ ok: z.boolean(), at: z.number(), detail: z.string() }).nullable(),
});
export type KeyEntry = z.output<typeof keyEntrySchema>;

export const keysListRpc = defineRpc({
  name: "keys.list",
  input: z.object({}),
  output: z.object({ keys: z.array(keyEntrySchema), available: z.boolean() }),
});

/** Adds a key (no id) or edits one; a missing value keeps the stored one. */
export const keysSaveRpc = defineRpc({
  name: "keys.save",
  input: z.object({
    id: z.string().optional(),
    name: z.string().min(1).max(120),
    envVar: z.string().max(120),
    service: z.string().max(40).optional(),
    note: z.string().max(2000).optional(),
    value: z.string().min(1).max(20000).optional(),
  }),
  output: z.object({ key: keyEntrySchema }),
});

export const keysRevealRpc = defineRpc({
  name: "keys.reveal",
  input: z.object({ id: z.string() }),
  output: z.object({ value: z.string() }),
});

export const keysDeleteRpc = defineRpc({
  name: "keys.delete",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const keysTestRpc = defineRpc({
  name: "keys.test",
  input: z.object({ id: z.string() }),
  output: z.object({ key: keyEntrySchema }),
});

/** Keys found in .env files under home: names and places only, never values. */
export const keysScanRpc = defineRpc({
  name: "keys.scan",
  input: z.object({}),
  output: z.object({ found: z.array(z.object({ file: z.string(), envVar: z.string(), known: z.boolean() })) }),
});

export const keysImportRpc = defineRpc({
  name: "keys.import",
  input: z.object({ items: z.array(z.object({ file: z.string(), envVar: z.string() })).max(200) }),
  output: z.object({ imported: z.number() }),
});
