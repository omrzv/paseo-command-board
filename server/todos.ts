import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { type Todo, todoSchema, todosAddRpc, todosDeleteRpc, todosListRpc, todosUpdateRpc } from "../shared/todos-rpc";
import { pluginDataDir } from "./plugin-data";

/** Done to-dos stay listed this long, so a mistaken tick can be undone. */
const DONE_SHOWN_MS = 7 * 24 * 60 * 60_000;
/** Done to-dos are dropped from the file after this long. */
const DONE_KEPT_MS = 90 * 24 * 60 * 60_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function todosPath(): string {
  return join(pluginDataDir(), "todos.json");
}

/** The person's own to-dos, in one JSON file on the daemon, shared by every client. */
export function createTodoStore(path = todosPath(), now: () => number = Date.now) {
  let todos: Todo[] | null = null;
  let writes: Promise<unknown> = Promise.resolve();

  const load = async (): Promise<Todo[]> => {
    if (todos) return todos;
    try {
      const parsed = z.object({ todos: z.array(todoSchema) }).safeParse(JSON.parse(await readFile(path, "utf8")));
      todos = parsed.success ? parsed.data.todos : [];
    } catch {
      todos = [];
    }
    return todos;
  };

  const persist = () => {
    const cutoff = now() - DONE_KEPT_MS;
    todos = (todos ?? []).filter((todo) => !todo.done || (todo.doneAt ?? 0) >= cutoff);
    const snapshot = JSON.stringify({ todos });
    const next = writes.then(async () => {
      const temp = `${path}.${process.pid}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temp, snapshot);
      await rename(temp, path);
    }).catch(() => {});
    writes = next;
    return next;
  };

  const due = (value: string | null | undefined) => (value && DAY.test(value) ? value : null);

  return {
    async list(): Promise<Todo[]> {
      const cutoff = now() - DONE_SHOWN_MS;
      return (await load()).filter((todo) => !todo.done || (todo.doneAt ?? 0) >= cutoff);
    },
    async add(input: { title: string; notes?: string; due?: string | null; links?: string[]; source?: Todo["source"] }): Promise<Todo> {
      const list = await load();
      const todo: Todo = {
        id: randomUUID(), title: input.title.trim(), notes: input.notes ?? "", due: due(input.due), done: false, createdAt: now(), doneAt: null,
        links: input.links ?? [], source: input.source ?? null, agentId: null,
      };
      list.push(todo);
      await persist();
      return todo;
    },
    async update(input: { id: string; title?: string; notes?: string; due?: string | null; done?: boolean; agentId?: string | null }): Promise<Todo | null> {
      const todo = (await load()).find((entry) => entry.id === input.id);
      if (!todo) return null;
      if (input.title !== undefined) todo.title = input.title.trim();
      if (input.notes !== undefined) todo.notes = input.notes;
      if (input.due !== undefined) todo.due = due(input.due);
      if (input.agentId !== undefined) todo.agentId = input.agentId;
      if (input.done !== undefined && input.done !== todo.done) {
        todo.done = input.done;
        todo.doneAt = input.done ? now() : null;
      }
      await persist();
      return todo;
    },
    async remove(id: string): Promise<boolean> {
      const list = await load();
      const index = list.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      list.splice(index, 1);
      await persist();
      return true;
    },
  };
}

export function registerTodosServer(server: PluginServerContext, store = createTodoStore()): void {
  server.handle(todosListRpc, async () => ({ todos: await store.list() }));
  server.handle(todosAddRpc, async (input) => ({ todo: await store.add(input) }));
  server.handle(todosUpdateRpc, async (input) => ({ todo: await store.update(input) }));
  server.handle(todosDeleteRpc, async ({ id }) => ({ ok: await store.remove(id) }));
}
