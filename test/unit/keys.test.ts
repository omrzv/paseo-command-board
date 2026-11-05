import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createKeyStore, guessService, parseEnv, parseKeychainPassword, testKey, valueHint, type SecretStore } from "../../server/keys";
import { envVarFor } from "../../shared/keys-rpc";

function memorySecrets(): SecretStore & { map: Map<string, string>; labels: Map<string, string> } {
  const map = new Map<string, string>();
  const labels = new Map<string, string>();
  return {
    map,
    labels,
    available: true,
    set: async (id, value, meta) => { map.set(id, value); if (meta) labels.set(id, meta.label); },
    get: async (id) => { if (!map.has(id)) throw new Error("missing"); return map.get(id)!; },
    remove: async (id) => { map.delete(id); },
  };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "keys-"));
  const secrets = memorySecrets();
  let clock = 1_000;
  const calls: string[] = [];
  const fetcher = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push(url);
    const good = Object.values(init.headers).some((value) => value.includes("good"));
    return { ok: good, status: good ? 200 : 401, json: async () => (url.includes("github") ? { login: "omrzv" } : url.includes("slack") ? { ok: good, user: "omer", team: "Hero", error: "invalid_auth" } : {}) };
  };
  const store = createKeyStore({ path: join(dir, "data", "keys.json"), secrets, now: () => clock++, home: dir, fetcher });
  return { dir, store, secrets, calls, path: join(dir, "data", "keys.json") };
}

describe("keys", () => {
  it("keeps values in the secret store and only details in the file", async () => {
    const { store, secrets, path } = await setup();
    const key = await store.save({ name: "OpenAI personal", envVar: "openai api key", value: "sk-proj-abcdefghijklmnop1234" });
    expect(key).toMatchObject({ name: "OpenAI personal", envVar: "OPENAI_API_KEY", service: "openai", hint: "sk-pro…1234", test: null });
    expect(secrets.map.get(key.id)).toBe("sk-proj-abcdefghijklmnop1234");
    const file = await readFile(path, "utf8");
    expect(file).not.toContain("abcdefghijklmnop");
    expect(await store.reveal(key.id)).toBe("sk-proj-abcdefghijklmnop1234");
    // An edit without a value keeps it.
    await store.save({ id: key.id, name: "OpenAI", envVar: "OPENAI_API_KEY", note: "laptop" });
    expect(await store.reveal(key.id)).toBe("sk-proj-abcdefghijklmnop1234");
    expect((await store.list())[0]).toMatchObject({ name: "OpenAI", note: "laptop" });
    await expect(store.save({ name: "No value", envVar: "X" })).rejects.toThrow(/value/);
    expect(await store.remove(key.id)).toBe(true);
    expect(secrets.map.size).toBe(0);
    expect(await store.list()).toEqual([]);
  });

  it("labels each Keychain item with its env var so agents can find it by name", async () => {
    const { store, secrets } = await setup();
    const key = await store.save({ name: "newsapi", envVar: "newsapi", value: "4b6802aaaaaaaab92e" });
    expect(secrets.labels.get(key.id)).toBe("NEWSAPI");
    // Renaming the env var relabels without a new value.
    await store.save({ id: key.id, name: "News API", envVar: "NEWS_API_KEY" });
    expect(secrets.labels.get(key.id)).toBe("NEWS_API_KEY");
    expect(secrets.map.get(key.id)).toBe("4b6802aaaaaaaab92e");
    // Older items get their labels on start.
    secrets.labels.clear();
    expect(await store.relabel()).toBe(1);
    expect(secrets.labels.get(key.id)).toBe("NEWS_API_KEY");
  });

  it("tests a key against its service and records the result", async () => {
    const { store, calls } = await setup();
    const good = await store.save({ name: "GH", envVar: "GITHUB_TOKEN", value: "ghp_good_token_value_123" });
    const bad = await store.save({ name: "Slack", envVar: "SLACK_TOKEN", value: "xoxp-bad-token-value-1" });
    expect((await store.test(good.id)).test).toMatchObject({ ok: true, detail: "Works · omrzv" });
    expect((await store.test(bad.id)).test).toMatchObject({ ok: false, detail: "invalid_auth" });
    expect(calls).toEqual(["https://api.github.com/user", "https://slack.com/api/auth.test"]);
    expect(await testKey("other", "x")).toEqual({ ok: false, detail: "No test for this service" });
  });

  it("finds secret-looking names in .env files and imports the picked ones", async () => {
    const { dir, store, secrets } = await setup();
    await mkdir(join(dir, "proj", "node_modules", "dep"), { recursive: true });
    await writeFile(join(dir, "proj", ".env"), 'ANTHROPIC_API_KEY="sk-ant-api03-xyz"\nPORT=3000\nexport GH_TOKEN=ghp_abc # comment\nEMPTY_SECRET=\n');
    await writeFile(join(dir, "proj", ".env.example"), "OPENAI_API_KEY=changeme\n");
    await writeFile(join(dir, "proj", "node_modules", "dep", ".env"), "NPM_TOKEN=x\n");
    const found = await store.scan();
    expect(found.map((item) => item.envVar)).toEqual(["ANTHROPIC_API_KEY", "GH_TOKEN"]);
    expect(await store.importFrom([{ file: join(dir, "proj", ".env"), envVar: "GH_TOKEN" }, { file: "/etc/passwd", envVar: "X" }])).toBe(1);
    const [key] = await store.list();
    expect(key).toMatchObject({ envVar: "GH_TOKEN", service: "github", note: "Imported from ~/proj/.env" });
    expect(secrets.map.get(key!.id)).toBe("ghp_abc");
    expect((await store.scan()).find((item) => item.envVar === "GH_TOKEN")!.known).toBe(true);
  });

  it("reads Keychain output, guesses services and names env vars", () => {
    expect(parseKeychainPassword('keychain: "x"\npassword: "plain"\n')).toBe("plain");
    expect(parseKeychainPassword('password: 0xC3BC6E  "\\303\\274n"\n')).toBe("ün");
    expect(parseKeychainPassword("nothing")).toBeNull();
    expect(parseEnv("A_KEY='q v'\n")).toEqual([{ envVar: "A_KEY", value: "q v" }]);
    expect([guessService("sk-ant-1"), guessService("sk-1"), guessService("github_pat_1"), guessService("xoxb-1"), guessService("abc")]).toEqual(["anthropic", "openai", "github", "slack", "other"]);
    expect(valueHint("short")).toBe("•••••");
    expect(envVarFor(" OpenAI prod-key ")).toBe("OPENAI_PROD_KEY");
  });
});
