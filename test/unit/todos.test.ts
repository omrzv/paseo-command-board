import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTodoStore } from "../../server/todos";
import { localDay, sortTodos } from "../../client/tasks/board/todo-model";

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
    const todo = (title: string, due: string | null, createdAt: number) => ({ id: title, title, notes: "", due, done: false, createdAt, doneAt: null });
    expect(sortTodos([todo("c", null, 1), todo("b", "2026-11-05", 2), todo("a", "2026-11-01", 3), todo("d", null, 0)]).map((t) => t.title)).toEqual(["a", "b", "d", "c"]);
    expect(localDay(1, new Date(2026, 11, 31))).toBe("2027-01-01");
  });
});
