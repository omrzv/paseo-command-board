/** A to-do was given to the team: the Team panel reads its tasks again. */
const listeners = new Set<() => void>();

export function teamChanged(): void {
  for (const listener of listeners) listener();
}

export function onTeamChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
