/** Something outside the Keys panel saved or removed a key (the calendar's address): the panel reads its list again. */
const listeners = new Set<() => void>();

export function keysChanged(): void {
  for (const listener of listeners) listener();
}

export function onKeysChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
