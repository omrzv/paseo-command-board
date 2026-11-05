import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSlackPeople, createTeamStore, freeColor } from "../../server/team";
import { MEMBER_COLORS, memberColor } from "../../shared/team-rpc";

const CLI = join(__dirname, "..", "..", "bin", "team.mjs");

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "team-"));
  const path = join(home, "plugin-data", "better-paseo", "team.json");
  let clock = 1_000;
  const store = createTeamStore(path, () => clock++);
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [CLI, ...args], { env: { ...process.env, PASEO_HOME: home }, encoding: "utf8" }));
  return { home, path, store, cli };
}

describe("team", () => {
  it("keeps members and tasks, logs status and assignee changes, and unassigns a removed member's tasks", async () => {
    const { store } = await setup();
    const dana = await store.saveMember({ name: "Dana", slackUserId: "U1", role: "Researcher" });
    const task = await store.saveTask({ title: " Literature review ", assigneeId: dana.id, due: "2026-11-10" });
    expect(task).toMatchObject({ title: "Literature review", status: "todo", assigneeId: dana.id });
    const moved = await store.saveTask({ id: task.id, status: "blocked" });
    expect(moved.updates.map((update) => update.text)).toEqual(["Status: todo → blocked"]);
    await store.addUpdate(task.id, "waiting on data access");
    await store.deleteMember(dana.id);
    const listed = await store.list();
    expect(listed.members).toEqual([]);
    expect(listed.tasks[0]).toMatchObject({ assigneeId: null, status: "blocked" });
    expect(listed.tasks[0]!.updates.at(-1)).toMatchObject({ text: "waiting on data access", by: "me" });
    await expect(store.saveTask({})).rejects.toThrow(/title/);
    const done = await store.saveTask({ id: task.id, status: "done" });
    expect(done.doneAt).not.toBeNull();
  });

  it("shares the file with the team command: agent updates and suggestions show on the board", async () => {
    const { store, cli } = await setup();
    const dana = await store.saveMember({ name: "Dana Levi", slackUserId: "U1" });
    const task = await store.saveTask({ title: "Run the survey", assigneeId: dana.id });
    const status = cli("status");
    expect(status.tasks).toEqual([expect.objectContaining({ id: task.id, assignee: "Dana Levi", status: "todo" })]);
    expect(cli("update", task.id.slice(0, 8), "Sent", "to", "40", "people", "--by", "slack")).toMatchObject({ ok: true });
    cli("set", task.id, "--status", "doing", "--due", "2026-11-20");
    cli("asked", task.id);
    cli("suggest", "--title", "Prepare the poster", "--assignee", "dana", "--from", "Yossi", "--link", "https://x.slack.com/archives/C1/p1");
    expect(cli("suggest", "--title", "Again", "--link", "https://x.slack.com/archives/C1/p1")).toMatchObject({ skipped: expect.any(String) });
    const listed = await store.list();
    const shown = listed.tasks[0]!;
    expect(shown).toMatchObject({ status: "doing", due: "2026-11-20" });
    expect(shown.lastAskedAt).not.toBeNull();
    expect(shown.updates.map((update) => [update.by, update.text])).toEqual([["slack", "Sent to 40 people"], ["agent", "Status: todo → doing"]]);
    expect(listed.suggestions).toEqual([expect.objectContaining({ title: "Prepare the poster", assigneeId: dana.id, from: "Yossi" })]);
    const accepted = await store.suggestion(listed.suggestions[0]!.id, true);
    expect(accepted).toMatchObject({ title: "Prepare the poster", assigneeId: dana.id, links: ["https://x.slack.com/archives/C1/p1"] });
    expect((await store.list()).suggestions).toEqual([]);
  });

  it("gives every member a different colour slot, reusing a removed member's slot", async () => {
    const { store } = await setup();
    const people = [];
    for (const name of ["A", "B", "C", "D"]) people.push(await store.saveMember({ name }));
    expect(people.map((member) => member.colorIndex)).toEqual([0, 1, 2, 3]);
    await store.deleteMember(people[1]!.id);
    expect((await store.saveMember({ name: "E" })).colorIndex).toBe(1);
    expect(new Set(MEMBER_COLORS.map(([dark]) => dark)).size).toBe(10);
    expect(memberColor({ id: "x", colorIndex: 2 }, true)).toBe(MEMBER_COLORS[2]![0]);
    expect(freeColor(Array.from({ length: 10 }, (_, index) => ({ colorIndex: index })))).toBe(0);
  });

  it("keeps the manager and the points to raise with them", async () => {
    const { store } = await setup();
    expect((await store.list()).manager).toBeNull();
    await store.setManager({ name: "Uri Cohen", slackUserId: "U9" });
    let agenda = await store.agenda({ op: "add", text: "Budget for Q1" });
    agenda = await store.agenda({ op: "add", text: "Hiring" });
    agenda = await store.agenda({ op: "toggle", id: agenda[0]!.id });
    expect(agenda.map((item) => [item.text, item.done])).toEqual([["Budget for Q1", true], ["Hiring", false]]);
    agenda = await store.agenda({ op: "delete", id: agenda[1]!.id });
    const listed = await store.list();
    expect(listed.manager).toEqual({ name: "Uri Cohen", slackUserId: "U9" });
    expect(listed.agenda.map((item) => item.text)).toEqual(["Budget for Q1"]);
    expect(listed.members).toEqual([]);
  });

  it("looks up Slack people with the board's token", async () => {
    const { home } = await setup();
    const slackFile = join(home, "slack.json");
    await writeFile(slackFile, JSON.stringify({ token: "xoxp-1" }));
    const calls: string[] = [];
    const people = createSlackPeople({
      slackFile,
      call: async (method) => {
        calls.push(method);
        return { members: [
          { id: "U1", name: "dana", profile: { real_name: "Dana Levi", title: "Researcher" } },
          { id: "U2", name: "bot", is_bot: true, profile: {} },
          { id: "U3", name: "old", deleted: true, profile: {} },
        ] };
      },
    });
    expect(await people("dan")).toEqual({ people: [{ id: "U1", name: "Dana Levi", title: "Researcher" }], error: null });
    await people("lev");
    expect(calls).toEqual(["users.list"]);
    const unlinked = createSlackPeople({ slackFile: join(home, "missing.json") });
    expect((await unlinked("x")).error).toMatch(/Connect Slack/);
    expect(await readFile(slackFile, "utf8")).toContain("xoxp");
  });
});
