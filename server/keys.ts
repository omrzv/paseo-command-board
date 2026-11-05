import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { type KeyEntry, envVarFor, keyEntrySchema, keysDeleteRpc, keysImportRpc, keysListRpc, keysRevealRpc, keysSaveRpc, keysScanRpc, keysTestRpc } from "../shared/keys-rpc";
import { pluginDataDir } from "./plugin-data";

/** The Keychain service every key is stored under; the account is the key's id. */
export const KEYCHAIN_SERVICE = "paseo-keys";

/** Where values live. The real one is the macOS Keychain; tests use a map. */
export interface SecretStore {
  available: boolean;
  /** `label` is what the Keychain shows and searches (the env var name); `comment` its description. */
  set(id: string, value: string, meta?: { label: string; comment?: string }): Promise<void>;
  get(id: string): Promise<string>;
  remove(id: string): Promise<void>;
}

/**
 * The login Keychain through `security`. A value is written in interactive
 * mode on stdin, hex-encoded, so it never shows in the process list.
 */
export function keychainStore(): SecretStore {
  const run = (args: string[]) => new Promise<string>((resolve, reject) => {
    execFile("/usr/bin/security", args, { maxBuffer: 1 << 20 }, (error, stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)));
  });
  return {
    available: process.platform === "darwin",
    set: (id, value, meta) => new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 && !/error/i.test(stderr) ? resolve() : reject(new Error(stderr.trim() || `security exited ${code}`))));
      const hex = Buffer.from(value, "utf8").toString("hex");
      const quoted = (text: string) => `"${text.replace(/["\\\n\r]/g, " ").trim()}"`;
      const label = quoted(meta?.label || "Paseo key");
      const comment = meta?.comment ? ` -j ${quoted(meta.comment)}` : "";
      child.stdin.end(`add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${id} -l ${label}${comment} -X ${hex}\n`);
    }),
    // `-w` prints a non-ASCII value as bare hex, which cannot be told from a hex key; `-g` marks it.
    get: (id) => new Promise<string>((resolve, reject) => {
      execFile("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id, "-g"], { maxBuffer: 1 << 20 }, (error, _stdout, stderr) => {
        if (error) return reject(new Error(stderr.trim() || error.message));
        const value = parseKeychainPassword(stderr);
        return value === null ? reject(new Error("Could not read the key from the Keychain")) : resolve(value);
      });
    }),
    remove: async (id) => { await run(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id]).catch(() => ""); },
  };
}

/** The value in `security … -g` output: `password: "text"`, or `password: 0xHEX  "…"` when it is not plain ASCII. */
export function parseKeychainPassword(output: string): string | null {
  const line = output.split("\n").find((entry) => entry.startsWith("password: "));
  if (!line) return null;
  const rest = line.slice("password: ".length);
  const hex = /^0x([0-9A-Fa-f]+)/.exec(rest);
  if (hex) return Buffer.from(hex[1]!, "hex").toString("utf8");
  if (rest.startsWith('"') && rest.endsWith('"')) return rest.slice(1, -1);
  return rest === "" ? "" : null;
}

export function keysPath(): string {
  return join(pluginDataDir(), "keys.json");
}

/** The service a value belongs to, from its prefix. */
export function guessService(value: string): string {
  if (value.startsWith("sk-ant-")) return "anthropic";
  if (value.startsWith("sk-")) return "openai";
  if (/^(ghp_|gho_|ghu_|ghs_|github_pat_)/.test(value)) return "github";
  if (value.startsWith("xox")) return "slack";
  return "other";
}

/** The first and last characters only: enough to tell two keys apart. */
export function valueHint(value: string): string {
  return value.length <= 12 ? "•".repeat(Math.min(value.length, 8)) : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

type Fetch = (url: string, init: { method?: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A cheap "who am I" call per known service. */
export async function testKey(service: string, value: string, fetcher: Fetch = fetch as unknown as Fetch): Promise<{ ok: boolean; detail: string }> {
  const request = ({
    openai: { url: "https://api.openai.com/v1/models", headers: { authorization: `Bearer ${value}` } },
    anthropic: { url: "https://api.anthropic.com/v1/models", headers: { "x-api-key": value, "anthropic-version": "2023-06-01" } },
    github: { url: "https://api.github.com/user", headers: { authorization: `Bearer ${value}`, "user-agent": "paseo-keys" } },
    slack: { url: "https://slack.com/api/auth.test", headers: { authorization: `Bearer ${value}` } },
  } as Record<string, { url: string; headers: Record<string, string> }>)[service];
  if (!request) return { ok: false, detail: "No test for this service" };
  try {
    const response = await fetcher(request.url, { method: service === "slack" ? "POST" : "GET", headers: request.headers, signal: AbortSignal.timeout(8_000) });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (service === "slack") return body?.ok === true ? { ok: true, detail: `Works · ${String(body.user ?? "")} @ ${String(body.team ?? "")}` } : { ok: false, detail: String(body?.error ?? `HTTP ${response.status}`) };
    if (!response.ok) return { ok: false, detail: response.status === 401 ? "Rejected (401)" : `HTTP ${response.status}` };
    return { ok: true, detail: service === "github" && body?.login ? `Works · ${String(body.login)}` : "Works" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PAT|CREDENTIAL)/i;
const SKIPPED_DIRS = new Set(["node_modules", "Library", ".Trash", ".git", ".cache", ".npm", ".venv", "venv", "dist", "build", ".paseo"]);

/** `.env`-style files under `root`, a few levels deep. */
async function envFiles(root: string, depth = 5): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, level: number) => {
    if (out.length >= 200) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isFile() && /^\.env(\..+)?$/.test(entry.name) && !/\.(example|sample|template)$/.test(entry.name)) out.push(join(dir, entry.name));
      else if (entry.isDirectory() && level < depth && !SKIPPED_DIRS.has(entry.name)) await walk(join(dir, entry.name), level + 1);
    }
  };
  await walk(root, 0);
  return out;
}

/** KEY=value pairs of a .env file whose names look secret. */
export function parseEnv(text: string): Array<{ envVar: string; value: string }> {
  const out: Array<{ envVar: string; value: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || !SECRET_NAME.test(match[1]!)) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    if (value) out.push({ envVar: match[1]!, value });
  }
  return out;
}

export function createKeyStore(options: { path?: string; secrets?: SecretStore; now?: () => number; home?: string; fetcher?: Fetch } = {}) {
  const path = options.path ?? keysPath();
  const secrets = options.secrets ?? keychainStore();
  const now = options.now ?? Date.now;
  let keys: KeyEntry[] | null = null;
  let writes: Promise<unknown> = Promise.resolve();

  const load = async () => {
    if (keys) return keys;
    try {
      const parsed = z.object({ keys: z.array(keyEntrySchema) }).safeParse(JSON.parse(await readFile(path, "utf8")));
      keys = parsed.success ? parsed.data.keys : [];
    } catch {
      keys = [];
    }
    return keys;
  };
  const persist = () => {
    const snapshot = JSON.stringify({ keys }, null, 2);
    const next = writes.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, path);
    });
    writes = next.catch(() => undefined);
    return next;
  };
  const find = async (id: string) => {
    const key = (await load()).find((entry) => entry.id === id);
    if (!key) throw new Error("No such key");
    return key;
  };

  // Agents look keys up by env var name: `security find-generic-password -s paseo-keys -l NEWSAPI -w`.
  const meta = (envVar: string, name: string) => ({ label: envVar, comment: `${name.trim()} (Paseo key)` });

  const save = async (input: { id?: string; name: string; envVar: string; service?: string; note?: string; value?: string }): Promise<KeyEntry> => {
    const all = await load();
    const envVar = envVarFor(input.envVar || input.name);
    if (input.id) {
      const key = await find(input.id);
      if (input.value) {
        await secrets.set(key.id, input.value, meta(envVar, input.name));
        key.hint = valueHint(input.value);
        key.test = null;
      } else if (envVar !== key.envVar || input.name.trim() !== key.name) {
        await secrets.set(key.id, await secrets.get(key.id), meta(envVar, input.name));
      }
      Object.assign(key, { name: input.name.trim(), envVar, service: input.service || key.service, note: input.note ?? key.note, updatedAt: now() });
      await persist();
      return key;
    }
    if (!input.value) throw new Error("A new key needs its value");
    const id = randomUUID();
    await secrets.set(id, input.value, meta(envVar, input.name));
    const key: KeyEntry = { id, name: input.name.trim(), envVar, service: input.service || guessService(input.value), note: input.note ?? "", hint: valueHint(input.value), createdAt: now(), updatedAt: now(), test: null };
    all.push(key);
    await persist();
    return key;
  };

  return {
    available: secrets.available,
    list: async () => [...(await load())].sort((left, right) => left.name.localeCompare(right.name)),
    save,
    reveal: async (id: string) => secrets.get((await find(id)).id),
    /** Keys saved before labels were their env var names: give each its name. */
    async relabel() {
      if (!secrets.available) return 0;
      let done = 0;
      for (const key of await load()) {
        try { await secrets.set(key.id, await secrets.get(key.id), meta(key.envVar, key.name)); done++; } catch { /* missing from the Keychain */ }
      }
      return done;
    },
    async remove(id: string) {
      const all = await load();
      const index = all.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      await secrets.remove(id);
      all.splice(index, 1);
      await persist();
      return true;
    },
    async test(id: string) {
      const key = await find(id);
      const result = await testKey(key.service, await secrets.get(id), options.fetcher);
      key.test = { ...result, at: now() };
      await persist();
      return key;
    },
    async scan() {
      const stored = new Set((await load()).map((key) => key.envVar));
      const found: Array<{ file: string; envVar: string; known: boolean }> = [];
      for (const file of await envFiles(options.home ?? homedir())) {
        let text = "";
        try { text = await readFile(file, "utf8"); } catch { continue; }
        for (const { envVar } of parseEnv(text)) found.push({ file, envVar, known: stored.has(envVar) });
      }
      return found;
    },
    async importFrom(items: Array<{ file: string; envVar: string }>) {
      const home = options.home ?? homedir();
      let imported = 0;
      for (const item of items) {
        if (!item.file.startsWith(home + "/")) continue;
        let text = "";
        try { text = await readFile(item.file, "utf8"); } catch { continue; }
        const pair = parseEnv(text).find((entry) => entry.envVar === item.envVar);
        if (!pair) continue;
        await save({ name: item.envVar, envVar: item.envVar, value: pair.value, note: `Imported from ${item.file.replace(home, "~")}` });
        imported++;
      }
      return imported;
    },
  };
}

export function registerKeysServer(server: PluginServerContext, store = createKeyStore()): void {
  server.handle(keysListRpc, async () => ({ keys: await store.list(), available: store.available }));
  server.handle(keysSaveRpc, async (input) => ({ key: await store.save(input) }));
  server.handle(keysRevealRpc, async ({ id }) => ({ value: await store.reveal(id) }));
  server.handle(keysDeleteRpc, async ({ id }) => ({ ok: await store.remove(id) }));
  server.handle(keysTestRpc, async ({ id }) => ({ key: await store.test(id) }));
  server.handle(keysScanRpc, async () => ({ found: await store.scan() }));
  server.handle(keysImportRpc, async ({ items }) => ({ imported: await store.importFrom(items) }));
}
