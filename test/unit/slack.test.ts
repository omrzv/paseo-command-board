import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSlackInbox, parseClassification, plainSlackText, reviewLinks } from "../../server/slack";

describe("slack helpers", () => {
  it("turns Slack markup into plain text", () => {
    const names = new Map([["U1", "dana"]]);
    expect(plainSlackText("hey <@U1> see <https://x.dev|the doc> and <#C1|eng> &amp; <https://y.dev>", names))
      .toBe("hey @dana see the doc (https://x.dev) and #eng & https://y.dev");
  });

  it("finds review links", () => {
    expect(reviewLinks("pls review https://claude.ai/public/artifacts/abc and https://github.com/a/b/pull/12 thanks")).toEqual([
      "https://claude.ai/public/artifacts/abc",
      "https://github.com/a/b/pull/12",
    ]);
    expect(reviewLinks("nothing here https://example.com")).toEqual([]);
  });

  it("parses the classifier's array and drops malformed rows", () => {
    expect(parseClassification('[{"i":0,"kind":"review","title":"Review the artifact"},{"i":"x"}]')).toEqual([]);
    expect(parseClassification('ok: [{"i":2,"kind":"question","title":"Answer Dana"}]')).toEqual([{ i: 2, kind: "question", title: "Answer Dana" }]);
    expect(parseClassification("none")).toEqual([]);
  });
});

describe("slack inbox", () => {
  async function setup(classifyReply: string) {
    const dir = await mkdtemp(join(tmpdir(), "slack-"));
    const path = join(dir, "slack.json");
    const now = Date.parse("2026-11-03T12:00:00Z");
    const ts = (offsetMin: number) => ((now + offsetMin * 60_000) / 1000).toFixed(6);
    const calls: string[] = [];
    const call = async (method: string, _token: string, params: Record<string, unknown>) => {
      calls.push(method);
      if (method === "auth.test") return { ok: true, user_id: "UME", user: "omer", team: "Hero", url: "https://hero.slack.com/" };
      if (method === "users.conversations") return { ok: true, channels: [{ id: "D1", is_im: true, user: "U1", updated: now }] };
      if (method === "users.info") return { ok: true, user: { profile: { display_name: params.user === "U1" ? "dana" : "x" } } };
      if (method === "conversations.history") return { ok: true, messages: [
        { user: "U1", text: "can you review https://claude.ai/public/artifacts/abc ?", ts: ts(-30) },
        { user: "U1", text: "lunch?", ts: ts(-20) },
        { user: "UME", text: "on it", ts: ts(-10) },
      ] };
      if (method === "search.messages") return { ok: true, messages: { matches: [] } };
      throw new Error(`unexpected ${method}`);
    };
    const inbox = createSlackInbox({ path, call, classify: async () => classifyReply, now: () => now });
    return { inbox, path, calls };
  }

  it("connects, keeps the tasks the classifier picks, marks a later reply, and never returns the token", async () => {
    const { inbox, path } = await setup('[{"i":0,"kind":"request","title":"Review Dana\'s artifact"}]');
    expect(await inbox.connect("bad")).toMatchObject({ ok: false });
    expect(await inbox.connect("xoxp-123-456")).toEqual({ ok: true, error: null });
    await inbox.scan();
    const items = await inbox.inbox();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ where: "@dana", from: "dana", kind: "review", title: "Review Dana's artifact", replied: true, state: "open" });
    expect(items[0]!.links).toEqual(["https://claude.ai/public/artifacts/abc"]);
    expect(items[0]!.permalink).toMatch(/^https:\/\/hero\.slack\.com\/archives\/D1\/p\d+$/);
    const status = await inbox.status();
    expect(status).toMatchObject({ connected: true, team: "Hero", user: "omer", error: null });
    expect(JSON.stringify(status)).not.toContain("xoxp");
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
    expect(await readFile(path, "utf8")).toContain("xoxp-123-456");

    expect(await inbox.setState(items[0]!.id, "done")).toBe(true);
    expect((await inbox.inbox())[0]!.state).toBe("done");
  });

  it("does not add the same message twice on the next scan", async () => {
    const { inbox } = await setup('[{"i":0,"kind":"request","title":"Do it"}]');
    await inbox.connect("xoxp-1");
    await inbox.scan();
    await inbox.scan();
    expect(await inbox.inbox()).toHaveLength(1);
  });
});
