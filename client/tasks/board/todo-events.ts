/** Tells the My tasks column to read the list again (a task added from elsewhere, such as a Slack card). */
const listeners = new Set<() => void>();

export function onTodosChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function todosChanged(): void {
  for (const listener of listeners) listener();
}
