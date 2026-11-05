import type { Todo } from "../../../shared/todos-rpc";

/** YYYY-MM-DD in local time, `offset` days from today. */
export function localDay(offset = 0, from = new Date()): string {
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

/** By day: overdue and today first, then by day, then undated; oldest first within each. */
export function byDue(left: Pick<Todo, "due" | "createdAt">, right: Pick<Todo, "due" | "createdAt">): number {
  const a = left.due ?? "9999-99-99";
  const b = right.due ?? "9999-99-99";
  return a === b ? left.createdAt - right.createdAt : a < b ? -1 : 1;
}

/** Your own order (dragged); to-dos never placed fall back to their day, after the placed ones. */
export function sortTodos(todos: readonly Todo[]): Todo[] {
  return [...todos].sort((left, right) => {
    const a = left.order ?? Number.POSITIVE_INFINITY;
    const b = right.order ?? Number.POSITIVE_INFINITY;
    return a !== b ? a - b : byDue(left, right);
  });
}

/** The list after moving `id` to `index` among `ids`. */
export function moveId(ids: readonly string[], id: string, index: number): string[] {
  const rest = ids.filter((entry) => entry !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}


/** The first message of an agent started from a task: the task, its notes, its links and where it came from, then the extra context. */
export function agentPrompt(todo: Pick<Todo, "title" | "notes" | "links" | "source">, extra: string): string {
  const parts = [todo.title.trim()];
  if (todo.notes.trim()) parts.push(todo.notes.trim());
  if (todo.links.length) parts.push(`Links:\n${todo.links.map((link) => `- ${link}`).join("\n")}`);
  if (todo.source) parts.push(`From Slack: ${todo.source.from} in ${todo.source.where} (${todo.source.permalink})`);
  if (extra.trim()) parts.push(`Additional context:\n${extra.trim()}`);
  return parts.join("\n\n");
}
