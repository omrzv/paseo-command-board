import type { Todo } from "../../../shared/todos-rpc";

/** YYYY-MM-DD in local time, `offset` days from today. */
export function localDay(offset = 0, from = new Date()): string {
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

/** Overdue and today first, then by day, then undated; oldest first within each. */
export function sortTodos(todos: readonly Todo[]): Todo[] {
  return [...todos].sort((left, right) => {
    const a = left.due ?? "9999-99-99";
    const b = right.due ?? "9999-99-99";
    return a === b ? left.createdAt - right.createdAt : a < b ? -1 : 1;
  });
}

