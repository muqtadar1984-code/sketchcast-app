// The Shell's conversation memory ACROSS PAGES (Final Plan §5.4, S1 slice B).
//
// The server-signed memory blob travels with every turn; S0 kept it in a ref,
// so a navigate ("open the Board") that unmounted the dashboard panel lost
// the conversation. This store writes the blob (plus the session id) to
// sessionStorage after every `meta`/`done` and reads it back when a panel
// mounts — on the dashboard or on the Board — so "open the board" then
// "start the video" is one conversation.
//
// The server remains the authority: a stale blob (4-hour gap), a forged one,
// or one from another hat/school/plan simply starts a fresh conversation
// there. This store only drops what the server would certainly reject (the
// gap), so the panel never offers a dead session id. PURE: storage and clock
// are injected; the panel passes window.sessionStorage.

export const SK_MEMORY_KEY = "sk.memory";
/** Mirrors SK_MEMORY_GAP_MS server-side (memory.ts). */
export const SK_MEMORY_STORE_GAP_MS = 4 * 60 * 60 * 1000;

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type SavedMemory = { memory: string; sessionId: string | null; savedAt: number };

export type MemoryStore = {
  /** The saved memory when it is still within the gap, else null (and cleared). */
  load(): SavedMemory | null;
  save(entry: { memory: string; sessionId?: string | null }): void;
  clear(): void;
};

export function createMemoryStore(storage: StorageLike | null | undefined, now: () => number = () => Date.now(), key = SK_MEMORY_KEY): MemoryStore {
  const read = (): SavedMemory | null => {
    if (!storage) return null;
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      return null; // private mode / disabled storage
    }
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as Partial<SavedMemory>;
      if (!v || typeof v.memory !== "string" || !v.memory || typeof v.savedAt !== "number") return null;
      return { memory: v.memory, sessionId: typeof v.sessionId === "string" ? v.sessionId : null, savedAt: v.savedAt };
    } catch {
      return null;
    }
  };
  const clear = () => {
    try {
      storage?.removeItem(key);
    } catch {
      /* nothing to clear */
    }
  };
  return {
    load() {
      const v = read();
      if (!v) return null;
      const age = now() - v.savedAt;
      if (age > SK_MEMORY_STORE_GAP_MS || age < -60_000) {
        clear();
        return null;
      }
      return v;
    },
    save(entry) {
      if (!storage || !entry.memory) return;
      try {
        storage.setItem(key, JSON.stringify({ memory: entry.memory, sessionId: entry.sessionId ?? null, savedAt: now() } satisfies SavedMemory));
      } catch {
        /* quota / private mode: the ref still holds it for this page */
      }
    },
    clear,
  };
}
