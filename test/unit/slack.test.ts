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
  async function setup(classifyReply: string, mine: Array<{ channel: string; tsOffsetMin: number; thread?: string }> = []) {
    const dir = await mkdtemp(join(tmpdir(), "slack-"));
    const path = join(dir, "slack.json");
    const now = Date.parse("2026-11-03T12:00:00Z");
    const ts = (offsetMin: number) => ((now + offsetMin * 60_000) / 1000).toFixed(6);
    const posted: Array<Record<string, unknown>> = [];
    const call = async (method: string, _token: string, params: Record<string, unknown>) => {
      if (method === "auth.test") return { ok: true, user_id: "UME", user: "omer", team: "Hero", url: "https://hero.slack.com/" };
      if (method === "users.info") return { ok: true, user: { profile: { display_name: params.user === "U1" ? "dana" : "x" } } };
      if (method === "chat.postMessage") { posted.push(params); return { ok: true }; }
      if (method === "search.messages") {
        const query = String(params.query);
        if (query.startsWith("is:dm")) return { ok: true, messages: { matches: [
          { user: "U1", text: "can you review https://claude.ai/public/artifacts/abc ?", ts: ts(-30), channel: { id: "D1", is_im: true } },
          { user: "U1", text: "lunch?", ts: ts(-20), channel: { id: "D1", is_im: true } },
        ] } };
        if (query.startsWith("<@UME>")) return { ok: true, messages: { matches: [
          { user: "U2", text: "<@UME> what do you think about the rollout?", ts: ts(-15), channel: { id: "C1", name: "eng" } },
        ] } };
        if (query.startsWith("from:me")) return { ok: true, messages: { matches: mine.map((m) => ({
          user: "UME", text: "x", ts: ts(m.tsOffsetMin), channel: { id: m.channel },
          permalink: `https://hero.slack.com/archives/${m.channel}/p1${m.thread ? `?thread_ts=${m.thread}` : ""}`,
        })) } };
      }
      throw new Error(`unexpected ${method}`);
    };
    const inbox = createSlackInbox({ path, call, classify: async () => classifyReply, now: () => now });
    return { inbox, path, posted, ts };
  }

  it("connects, reads DMs and mentions by search, keeps the classified tasks, and never returns the token", async () => {
    const { inbox, path } = await setup('[{"i":0,"kind":"request","title":"Review Dana\'s artifact"},{"i":2,"kind":"question","title":"Answer about rollout"}]');
    expect(await inbox.connect("bad")).toMatchObject({ ok: false });
    expect(await inbox.connect("xoxp-123-456")).toEqual({ ok: true, error: null });
    await inbox.scan();
    const items = await inbox.inbox();
    expect(items.map((item) => item.title)).toEqual(["Answer about rollout", "Review Dana's artifact"]);
    const review = items[1]!;
    expect(review).toMatchObject({ where: "@dana", from: "dana", kind: "review", replied: false, state: "open", direct: true });
    expect(review.links).toEqual(["https://claude.ai/public/artifacts/abc"]);
    expect(review.permalink).toMatch(/^https:\/\/hero\.slack\.com\/archives\/D1\/p\d+$/);
    expect(items[0]!.where).toBe("#eng");
    const status = await inbox.status();
    expect(status).toMatchObject({ connected: true, team: "Hero", user: "omer", error: null });
    expect(JSON.stringify(status)).not.toContain("xoxp");
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
    expect(await readFile(path, "utf8")).toContain("xoxp-123-456");
    expect(await inbox.setState(review.id, "done")).toBe(true);
    expect((await inbox.inbox()).find((item) => item.id === review.id)!.state).toBe("done");
  });

  it("closes items the person answered: later in the DM, in the thread, or in the channel soon after", async () => {
    const mentionTs = ((Date.parse("2026-11-03T12:00:00Z") - 15 * 60_000) / 1000).toFixed(6);
    const { inbox } = await setup(
      '[{"i":0,"kind":"request","title":"Review"},{"i":2,"kind":"question","title":"Rollout"}]',
      [{ channel: "D1", tsOffsetMin: -5 }, { channel: "C1", tsOffsetMin: -1, thread: mentionTs }],
    );
    await inbox.connect("xoxp-1");
    await inbox.scan();
    const items = await inbox.inbox();
    expect(items.every((item) => item.replied && item.state === "done")).toBe(true);
  });

  it("does not add the same message twice, and replies in the thread or the DM", async () => {
    const { inbox, posted } = await setup('[{"i":0,"kind":"request","title":"Do it"},{"i":2,"kind":"question","title":"Rollout"}]');
    await inbox.connect("xoxp-1");
    await inbox.scan();
    await inbox.scan();
    const items = await inbox.inbox();
    expect(items).toHaveLength(2);
    const dm = items.find((item) => item.direct)!;
    const channel = items.find((item) => !item.direct)!;
    expect(await inbox.reply(dm.id, "on it")).toEqual({ ok: true, error: null });
    expect(await inbox.reply(channel.id, "looks good")).toEqual({ ok: true, error: null });
    expect(posted[0]).toEqual({ channel: "D1", text: "on it" });
    expect(posted[1]).toEqual({ channel: "C1", text: "looks good", thread_ts: channel.id.split(":")[1] });
    expect((await inbox.inbox()).every((item) => item.state === "done" && item.replied)).toBe(true);
  });
});
