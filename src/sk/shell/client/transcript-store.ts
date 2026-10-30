// The Shell's TRANSCRIPT across pages and Shell instances (founder
// 2026-10-30: "moving between pages and tasks must be seamless").
//
// memory-store.ts already carries the server-signed memory blob per tab, so
// SK REMEMBERS the conversation on the next page; what she SEES was still the
// component's state, so a Shell that mounted afresh (the panel re-opened, the
// home hero after a full load) re-greeted her over an empty transcript. This
// store keeps the visible turns beside the blob, in the same per-tab
// sessionStorage, so the hero and the panel read ONE conversation.
//
// The rules:
//   - keyed by the conversation's session id: a Shell restores only when the
//     server carried THAT conversation (the context reply's sessionId); a fresh
//     server session (4-hour gap, other hat, forged blob) greets afresh;
//   - only a conversation she took part in (at least one of her turns) is
//     worth restoring — a lone greeting is better re-fetched, it may carry news;
//   - settled turns only: a turn still streaming is saved as settled with what
//     it had, never as "pending" (nothing would ever settle it);
//   - the latest SK_TRANSCRIPT_MAX entries, and the same 4-hour gap as the blob.
// PURE: storage and clock are injected; the Shell passes window.sessionStorage.

import { SK_MEMORY_KEY, SK_MEMORY_STORE_GAP_MS, type StorageLike } from "./memory-store";

export const SK_TRANSCRIPT_KEY = "sk.transcript";
export const SK_TRANSCRIPT_MAX = 40;

/** The minimum a stored entry must carry; anything else rides along as-is. */
export type TranscriptEntry = { id: string; who: "user" | "sk"; text: string; pending?: boolean } & Record<string, unknown>;

type Saved = { sessionId: string; savedAt: number; entries: TranscriptEntry[] };

export type TranscriptStore = {
  /** The entries saved for this conversation, or null (other session, too old, nothing of hers, unreadable). */
  load(sessionId: string | null | undefined): TranscriptEntry[] | null;
  save(sessionId: string | null | undefined, entries: ReadonlyArray<TranscriptEntry>): void;
  clear(): void;
};

const isEntry = (v: unknown): v is TranscriptEntry => {
  const e = v as Partial<TranscriptEntry> | null;
  return !!e && typeof e === "object" && typeof e.id === "string" && (e.who === "user" || e.who === "sk") && typeof e.text === "string";
};

/** Whether a transcript is one she took part in. */
export const hasHerTurn = (entries: ReadonlyArray<{ who: string }>): boolean => entries.some((e) => e.who === "user");

export function createTranscriptStore(storage: StorageLike | null | undefined, now: () => number = () => Date.now(), key = SK_TRANSCRIPT_KEY): TranscriptStore {
  const clear = () => {
    try {
      storage?.removeItem(key);
    } catch {
      /* nothing to clear */
    }
  };
  return {
    load(sessionId) {
      if (!storage || !sessionId) return null;
      let raw: string | null;
      try {
        raw = storage.getItem(key);
      } catch {
        return null;
      }
      if (!raw) return null;
      let v: Partial<Saved>;
      try {
        v = JSON.parse(raw) as Partial<Saved>;
      } catch {
        return null;
      }
      if (!v || typeof v.savedAt !== "number" || !Array.isArray(v.entries)) return null;
      const age = now() - v.savedAt;
      if (age > SK_MEMORY_STORE_GAP_MS || age < -60_000) {
        clear();
        return null;
      }
      if (v.sessionId !== sessionId) return null;
      const entries = v.entries.filter(isEntry);
      return hasHerTurn(entries) ? entries : null;
    },
    save(sessionId, entries) {
      if (!storage || !sessionId) return;
      const kept = entries.filter(isEntry).slice(-SK_TRANSCRIPT_MAX).map((e) => (e.pending ? { ...e, pending: false } : e));
      try {
        storage.setItem(key, JSON.stringify({ sessionId, savedAt: now(), entries: kept } satisfies Saved));
      } catch {
        /* quota / private mode: this Shell's state still holds it */
      }
    },
    clear,
  };
}

/**
 * "Clear conversation" in SK's corner menu (founder 2026-10-30): CLIENT-SIDE
 * only — this tab's visible turns AND the server-signed memory blob go from
 * sessionStorage, so the next turn starts a fresh server session. Nothing is
 * deleted on the server (her SK memory has its own controls in Settings).
 * Returns false when storage refused (private mode); the Shell resets what it
 * shows either way.
 */
export function clearConversation(storage: StorageLike | null | undefined): boolean {
  if (!storage) return false;
  let ok = true;
  for (const key of [SK_TRANSCRIPT_KEY, SK_MEMORY_KEY]) {
    try {
      storage.removeItem(key);
    } catch {
      ok = false;
    }
  }
  return ok;
}
