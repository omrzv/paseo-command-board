import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  type Member, type TeamFile, type TeamTask, teamFileSchema,
  teamAddUpdateRpc, teamAgendaRpc, teamSetManagerRpc, MEMBER_COLORS, teamDeleteMemberRpc, teamDeleteTaskRpc, teamListRpc, teamSaveMemberRpc, teamSaveTaskRpc, teamSlackPeopleRpc, teamSuggestionRpc,
} from "../shared/team-rpc";
import { pluginDataDir } from "./plugin-data";
import { type SlackCall, slackApi, slackPath } from "./slack";

/** Done tasks stay listed this long. */
const DONE_SHOWN_MS = 14 * 24 * 60 * 60_000;
/** Done tasks are dropped from the file after this long. */
const DONE_KEPT_MS = 180 * 24 * 60 * 60_000;

export function teamPath(): string {
  return join(pluginDataDir(), "team.json");
}

/**
 * The team's tasks, in one JSON file on the daemon. The team agent's `team`
 * command writes the same file, so it is read again whenever it changed.
 */
/** The first colour slot no member has, else the next one round. */
export function freeColor(members: Array<{ colorIndex: number | null }>): number {
  const used = new Set(members.map((member) => member.colorIndex).filter((index): index is number => index !== null));
  for (let index = 0; index < MEMBER_COLORS.length; index++) if (!used.has(index)) return index;
  return members.length % MEMBER_COLORS.length;
}

export function createTeamStore(path = teamPath(), now: () => number = Date.now) {
  let data: TeamFile | null = null;
  let loadedMtime = -1;
  let writes: Promise<unknown> = Promise.resolve();

  const load = async (): Promise<TeamFile> => {
    let mtime = 0;
    try { mtime = (await stat(path)).mtimeMs; } catch { /* no file yet */ }
    if (data && mtime === loadedMtime) return data;
    try {
      const parsed = teamFileSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      data = parsed.success ? parsed.data : teamFileSchema.parse({});
    } catch {
      data = teamFileSchema.parse({});
    }
    loadedMtime = mtime;
    // Members from before colours were slots get the free ones, in order.
    for (const member of data.members) if (member.colorIndex === null) member.colorIndex = freeColor(data.members);
    return data;
  };

  const persist = () => {
    const cutoff = now() - DONE_KEPT_MS;
    data!.tasks = data!.tasks.filter((task) => task.status !== "done" || (task.doneAt ?? 0) >= cutoff);
    const snapshot = JSON.stringify(data, null, 2);
    const next = writes.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, path);
      try { loadedMtime = (await stat(path)).mtimeMs; } catch { /* ignore */ }
    });
    writes = next.catch(() => undefined);
    return next;
  };

  const findTask = (file: TeamFile, id: string) => {
    const task = file.tasks.find((entry) => entry.id === id);
    if (!task) throw new Error("No such task");
    return task;
  };

  const newTask = (fields: Partial<TeamTask> & { title: string }): TeamTask => ({
    id: randomUUID(), notes: "", assigneeId: null, status: "todo", due: null, topic: "", links: [], updates: [],
    createdAt: now(), updatedAt: now(), doneAt: null, lastAskedAt: null, ...fields,
  });

  return {
    async list() {
      const file = await load();
      const cutoff = now() - DONE_SHOWN_MS;
      return {
        members: file.members,
        tasks: file.tasks.filter((task) => task.status !== "done" || (task.doneAt ?? 0) >= cutoff),
        suggestions: file.suggestions,
        manager: file.manager,
        agenda: file.agenda.filter((item) => !item.done || (item.doneAt ?? 0) >= cutoff),
      };
    },
    async saveMember(input: { id?: string; name: string; slackUserId?: string | null; role?: string }): Promise<Member> {
      const file = await load();
      let member = input.id ? file.members.find((entry) => entry.id === input.id) : undefined;
      if (input.id && !member) throw new Error("No such person");
      if (!member) {
        member = { id: randomUUID(), name: input.name.trim(), slackUserId: input.slackUserId ?? null, role: input.role ?? "", colorIndex: freeColor(file.members) };
        file.members.push(member);
      } else {
        Object.assign(member, { name: input.name.trim(), ...(input.slackUserId !== undefined ? { slackUserId: input.slackUserId } : {}), ...(input.role !== undefined ? { role: input.role } : {}) });
      }
      await persist();
      return member;
    },
    async setManager(manager: { name: string; slackUserId: string | null } | null) {
      const file = await load();
      file.manager = manager ? { name: manager.name.trim(), slackUserId: manager.slackUserId } : null;
      await persist();
      return file.manager;
    },
    async agenda(change: { op: "add"; text: string } | { op: "toggle"; id: string } | { op: "delete"; id: string }) {
      const file = await load();
      if (change.op === "add") file.agenda.push({ id: randomUUID(), text: change.text.trim(), done: false, createdAt: now(), doneAt: null });
      else if (change.op === "toggle") {
        const item = file.agenda.find((entry) => entry.id === change.id);
        if (item) { item.done = !item.done; item.doneAt = item.done ? now() : null; }
      } else file.agenda = file.agenda.filter((entry) => entry.id !== change.id);
      await persist();
      const cutoff = now() - DONE_SHOWN_MS;
      return file.agenda.filter((item) => !item.done || (item.doneAt ?? 0) >= cutoff);
    },
    async deleteMember(id: string) {
      const file = await load();
      const before = file.members.length;
      file.members = file.members.filter((member) => member.id !== id);
      // Their tasks stay, unassigned.
      for (const task of file.tasks) if (task.assigneeId === id) task.assigneeId = null;
      await persist();
      return file.members.length < before;
    },
    async saveTask(input: { id?: string; title?: string; notes?: string; assigneeId?: string | null; status?: TeamTask["status"]; due?: string | null; topic?: string; links?: string[] }): Promise<TeamTask> {
      const file = await load();
      const { id, ...fields } = input;
      const changes = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<TeamTask>;
      if (changes.title !== undefined) changes.title = changes.title.trim();
      if (!id) {
        if (!changes.title) throw new Error("A task needs a title");
        const task = newTask({ ...changes, title: changes.title, ...(changes.status === "done" ? { doneAt: now() } : {}) });
        file.tasks.push(task);
        await persist();
        return task;
      }
      const task = findTask(file, id);
      if (changes.status && changes.status !== task.status) {
        task.updates.push({ at: now(), text: `Status: ${task.status} → ${changes.status}`, by: "me" });
        task.doneAt = changes.status === "done" ? now() : null;
      }
      if (changes.assigneeId !== undefined && changes.assigneeId !== task.assigneeId) {
        const name = file.members.find((member) => member.id === changes.assigneeId)?.name ?? "nobody";
        task.updates.push({ at: now(), text: `Assigned to ${name}`, by: "me" });
      }
      Object.assign(task, changes, { updatedAt: now() });
      await persist();
      return task;
    },
    async deleteTask(id: string) {
      const file = await load();
      const before = file.tasks.length;
      file.tasks = file.tasks.filter((task) => task.id !== id);
      await persist();
      return file.tasks.length < before;
    },
    async addUpdate(id: string, text: string, by: "me" | "slack" | "agent" = "me") {
      const file = await load();
      const task = findTask(file, id);
      task.updates.push({ at: now(), text: text.trim(), by });
      task.updatedAt = now();
      await persist();
      return task;
    },
    async suggestion(id: string, accept: boolean): Promise<TeamTask | null> {
      const file = await load();
      const suggestion = file.suggestions.find((entry) => entry.id === id);
      if (!suggestion) throw new Error("No such suggestion");
      file.suggestions = file.suggestions.filter((entry) => entry.id !== id);
      let task: TeamTask | null = null;
      if (accept) {
        task = newTask({
          title: suggestion.title,
          notes: [suggestion.notes, suggestion.from ? `From ${suggestion.from} on Slack` : ""].filter(Boolean).join("\n\n"),
          assigneeId: suggestion.assigneeId,
          links: suggestion.permalink ? [suggestion.permalink] : [],
        });
        file.tasks.push(task);
      }
      await persist();
      return task;
    },
  };
}

/** Slack's people, by name, read with the board's Slack token; kept for 10 minutes. */
export function createSlackPeople(options: { slackFile?: string; call?: SlackCall; now?: () => number } = {}) {
  const call = options.call ?? slackApi;
  const now = options.now ?? Date.now;
  let cache: { at: number; people: Array<{ id: string; name: string; title: string }> } | null = null;
  return async (query: string) => {
    let token: string | null = null;
    try { token = (JSON.parse(await readFile(options.slackFile ?? slackPath(), "utf8")) as { token?: string | null }).token ?? null; } catch { /* not connected */ }
    if (!token) return { people: [], error: "Connect Slack first (the Slack column)." };
    try {
      if (!cache || now() - cache.at > 10 * 60_000) {
        const people: Array<{ id: string; name: string; title: string }> = [];
        let cursor = "";
        for (let page = 0; page < 10; page++) {
          const result = await call("users.list", token, { limit: 200, ...(cursor ? { cursor } : {}) });
          for (const user of (result.members as Array<Record<string, unknown>> | undefined) ?? []) {
            if (user.deleted || user.is_bot || user.id === "USLACKBOT") continue;
            const profile = (user.profile ?? {}) as Record<string, string | undefined>;
            people.push({ id: String(user.id), name: profile.real_name || profile.display_name || String(user.name ?? user.id), title: profile.title ?? "" });
          }
          cursor = String((result.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "");
          if (!cursor) break;
        }
        cache = { at: now(), people };
      }
      const words = query.trim().toLowerCase();
      return { people: cache.people.filter((person) => !words || person.name.toLowerCase().includes(words)).slice(0, 12), error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { people: [], error: /missing_scope/.test(message) ? "Add the users:read scope to your Slack app to look people up." : message };
    }
  };
}

export function registerTeamServer(server: PluginServerContext, store = createTeamStore(), people = createSlackPeople()): void {
  server.handle(teamListRpc, () => store.list());
  server.handle(teamSaveMemberRpc, async (input) => ({ member: await store.saveMember(input) }));
  server.handle(teamDeleteMemberRpc, async ({ id }) => ({ ok: await store.deleteMember(id) }));
  server.handle(teamSaveTaskRpc, async (input) => ({ task: await store.saveTask(input) }));
  server.handle(teamDeleteTaskRpc, async ({ id }) => ({ ok: await store.deleteTask(id) }));
  server.handle(teamAddUpdateRpc, async ({ id, text }) => ({ task: await store.addUpdate(id, text) }));
  server.handle(teamSuggestionRpc, async ({ id, accept }) => ({ task: await store.suggestion(id, accept) }));
  server.handle(teamSlackPeopleRpc, ({ query }) => people(query));
  server.handle(teamSetManagerRpc, async ({ manager }) => ({ manager: await store.setManager(manager) }));
  server.handle(teamAgendaRpc, async (change) => ({ agenda: await store.agenda(change) }));
}
