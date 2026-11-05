import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTodoStore } from "../../server/todos";
import { agentPrompt, localDay, sortTodos, moveId } from "../../client/tasks/board/todo-model";

describe("to-dos", () => {
  it("adds, edits, ticks, keeps done ones a week, and survives a restart", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "todos-")), "todos.json");
    let now = Date.parse("2026-11-04T10:00:00Z");
    const store = createTodoStore(path, () => now);
    const a = await store.add({ title: "  Call the bank ", due: "2026-11-05" });
    const b = await store.add({ title: "Buy milk", due: "not a day" });
    expect(a).toMatchObject({ title: "Call the bank", due: "2026-11-05", done: false });
    expect(b.due).toBeNull();
    expect(await store.update({ id: a.id, notes: "ask about fees", done: true })).toMatchObject({ done: true, doneAt: now, notes: "ask about fees" });
    expect((await store.list()).map((todo) => todo.title)).toEqual(["Call the bank", "Buy milk"]);
    now += 8 * 24 * 60 * 60_000;
    expect((await store.list()).map((todo) => todo.title)).toEqual(["Buy milk"]);
    const again = createTodoStore(path, () => now);
    expect((await again.list()).map((todo) => todo.title)).toEqual(["Buy milk"]);
    expect(await again.remove(b.id)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).todos.some((todo: { id: string }) => todo.id === b.id)).toBe(false);
    expect(await again.update({ id: "missing", done: true })).toBeNull();
  });

  it("sorts overdue and dated first, then undated, oldest first within each", () => {
    const todo = (title: string, due: string | null, createdAt: number, order: number | null = null) => ({ id: title, title, notes: "", due, done: false, createdAt, doneAt: null, links: [], source: null, agentId: null, order });
    expect(sortTodos([todo("c", null, 1), todo("b", "2026-11-05", 2), todo("a", "2026-11-01", 3), todo("d", null, 0)]).map((t) => t.title)).toEqual(["a", "b", "d", "c"]);
    // A placed order wins; unplaced ones follow by day.
    expect(sortTodos([todo("a", "2026-11-01", 3), todo("x", null, 9, 1), todo("y", null, 8, 0)]).map((t) => t.title)).toEqual(["y", "x", "a"]);
    expect(moveId(["a", "b", "c", "d"], "d", 1)).toEqual(["a", "d", "b", "c"]);
    expect(moveId(["a", "b", "c"], "a", 9)).toEqual(["b", "c", "a"]);
    expect(localDay(1, new Date(2026, 11, 31))).toBe("2027-01-01");
  });

  it("puts new to-dos on top and keeps a dragged order", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "todos-")), "todos.json");
    const store = createTodoStore(path, () => 1);
    const first = await store.add({ title: "first" });
    const second = await store.add({ title: "second" });
    expect(sortTodos(await store.list()).map((todo) => todo.title)).toEqual(["second", "first"]);
    await store.reorder([first.id, second.id]);
    expect(sortTodos(await createTodoStore(path, () => 1).list()).map((todo) => todo.title)).toEqual(["first", "second"]);
  });

  it("keeps a Slack task's message, links and origin, and builds the agent's first message from them", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "todos-")), "todos.json");
    const store = createTodoStore(path, () => 1);
    const todo = await store.add({ title: "Review Dana's artifact", notes: "can you review this?", links: ["https://claude.ai/a"],
      source: { kind: "slack", from: "dana", where: "@dana", permalink: "https://x.slack.com/archives/D1/p1", slackId: "D1:1.0" } });
    expect(todo).toMatchObject({ links: ["https://claude.ai/a"], source: { from: "dana" }, agentId: null });
    expect((await store.update({ id: todo.id, agentId: "agent-1", done: true }))?.agentId).toBe("agent-1");
    const prompt = agentPrompt(todo, "Focus on the security section");
    expect(prompt).toBe("Review Dana's artifact\n\ncan you review this?\n\nLinks:\n- https://claude.ai/a\n\nFrom Slack: dana in @dana (https://x.slack.com/archives/D1/p1)\n\nAdditional context:\nFocus on the security section");
  });
});
