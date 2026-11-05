import { NativeModules, Platform, TurboModuleRegistry } from "react-native";
import { readDevicePreference, writeDevicePreference } from "../../web";
import type { ReplyImage } from "./detail-cards";

/**
 * Unsent replies, per agent. Typed text survives leaving the card, the board,
 * the window and an app restart (saved on this device); pasted images survive
 * leaving the card or the board for as long as the app runs.
 */
const STORAGE_KEY = "paseo/better-paseo/reply-drafts/v1";
const RUNTIME_KEY = "__betterPaseoReplyDrafts";
/** Drafts older than this are dropped. */
const KEPT_MS = 14 * 24 * 60 * 60_000;
const SAVE_DELAY_MS = 300;

export type Draft = { text: string; images: ReplyImage[] };
type Saved = Record<string, { text: string; at: number }>;
export interface DraftStorage {
  read(): string | null | Promise<string | null>;
  write(value: string): void | Promise<void>;
}

interface NativeStorage {
  multiGet(keys: string[], done: (errors?: unknown[] | null, values?: [string, string | null][]) => void): void;
  multiSet(values: [string, string][], done: (errors?: unknown[] | null) => void): void;
}

function deviceStorage(): DraftStorage {
  if (Platform.OS === "web") return { read: () => readDevicePreference(STORAGE_KEY), write: (value) => writeDevicePreference(STORAGE_KEY, value) };
  const native = () => {
    const storage = (TurboModuleRegistry.get("RNCAsyncStorage") ?? NativeModules.RNCAsyncStorage) as NativeStorage | null;
    if (!storage?.multiGet || !storage.multiSet) throw new Error("Device storage is unavailable");
    return storage;
  };
  return {
    read: () => new Promise((resolve, reject) => native().multiGet([STORAGE_KEY], (errors, values) => (errors?.length ? reject(new Error("read failed")) : resolve(values?.[0]?.[1] ?? null)))),
    write: (value) => new Promise((resolve, reject) => native().multiSet([[STORAGE_KEY, value]], (errors) => (errors?.length ? reject(new Error("write failed")) : resolve()))),
  };
}

export function createDraftStore(storage: () => DraftStorage, now: () => number = Date.now) {
  const memory = new Map<string, Draft>();
  let saved: Saved = {};
  let loading: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const load = (): Promise<void> => {
    loading ??= (async () => {
      try {
        const raw = await storage().read();
        const parsed = raw ? (JSON.parse(raw) as Saved) : {};
        const cutoff = now() - KEPT_MS;
        saved = Object.fromEntries(Object.entries(parsed).filter(([, entry]) => typeof entry?.text === "string" && entry.at >= cutoff));
        for (const [id, entry] of Object.entries(saved)) if (!memory.has(id)) memory.set(id, { text: entry.text, images: [] });
      } catch {
        // No saved drafts on this device.
      }
    })();
    return loading;
  };

  const flush = () => {
    timer = null;
    try { void Promise.resolve(storage().write(JSON.stringify(saved))).catch(() => undefined); } catch { /* storage unavailable */ }
  };

  return {
    load,
    get: (id: string): Draft | null => memory.get(id) ?? null,
    set(id: string, draft: Draft) {
      if (!draft.text && draft.images.length === 0) return this.clear(id);
      memory.set(id, draft);
      const text = draft.text;
      if (saved[id]?.text !== text) {
        if (text) saved[id] = { text, at: now() };
        else delete saved[id];
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, SAVE_DELAY_MS);
      }
    },
    clear(id: string) {
      memory.delete(id);
      if (saved[id]) {
        delete saved[id];
        if (timer) clearTimeout(timer);
        flush();
      }
    },
    /** Writes a pending save now: the window is closing or hiding. */
    flush() { if (timer) { clearTimeout(timer); flush(); } },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;

export function replyDrafts(): DraftStore {
  const holder = globalThis as Record<string, unknown>;
  if (!holder[RUNTIME_KEY]) {
    const store = createDraftStore(() => (holder.__betterPaseoDraftStorageForTests as DraftStorage | undefined) ?? deviceStorage());
    holder[RUNTIME_KEY] = store;
    const page = globalThis as { addEventListener?(type: string, listener: () => void): void; document?: { visibilityState?: string } };
    page.addEventListener?.("pagehide", () => store.flush());
    page.addEventListener?.("visibilitychange", () => { if (page.document?.visibilityState === "hidden") store.flush(); });
  }
  return holder[RUNTIME_KEY] as DraftStore;
}
