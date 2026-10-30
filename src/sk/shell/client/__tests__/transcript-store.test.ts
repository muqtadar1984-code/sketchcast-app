/**
 * The cross-page transcript (founder 2026-10-30, seamless pages): the home
 * hero and the floating panel read ONE conversation — keyed by the server's
 * session id, only when she took part, settled turns only, capped, 4-hour gap.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/client/__tests__/transcript-store.test.ts
 */
import { describe, expect, it } from "vitest";
import type { StorageLike } from "../memory-store";
import { SK_MEMORY_STORE_GAP_MS } from "../memory-store";
import { SK_TRANSCRIPT_KEY, SK_TRANSCRIPT_MAX, createTranscriptStore, hasHerTurn, type TranscriptEntry } from "../transcript-store";

function fakeStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

const greet: TranscriptEntry = { id: "g", who: "sk", text: "Hi, I'm SK." };
const ask: TranscriptEntry = { id: "u1", who: "user", text: "open my classes" };
const answer: TranscriptEntry = { id: "a1", who: "sk", text: "Opening Classes.", nav: [{ path: "/dashboard/classes", label: "Classes" }], label: "navigation" };

describe("the hero and the panel read one conversation", () => {
  it("what the hero saved, the panel on the next page restores — same session id", () => {
    const s = fakeStorage();
    createTranscriptStore(s, () => 1).save("sess-1", [greet, ask, answer]);
    expect(createTranscriptStore(s, () => 2).load("sess-1")).toEqual([greet, ask, answer]);
    expect(s.map.has(SK_TRANSCRIPT_KEY)).toBe(true);
  });
  it("a different (fresh) server session → nothing to restore: the Shell greets afresh", () => {
    const s = fakeStorage();
    createTranscriptStore(s).save("sess-1", [greet, ask, answer]);
    expect(createTranscriptStore(s).load("sess-2")).toBeNull();
    expect(createTranscriptStore(s).load(null)).toBeNull();
  });
  it("a lone greeting (she never spoke) is not restored — re-fetched, it may carry news", () => {
    const s = fakeStorage();
    createTranscriptStore(s).save("sess-1", [greet]);
    expect(createTranscriptStore(s).load("sess-1")).toBeNull();
    expect(hasHerTurn([greet])).toBe(false);
    expect(hasHerTurn([greet, ask])).toBe(true);
  });
  it("a turn still streaming is saved settled, with what it had", () => {
    const s = fakeStorage();
    createTranscriptStore(s).save("sess-1", [ask, { id: "p", who: "sk", text: "Half an ans", pending: true }]);
    expect(createTranscriptStore(s).load("sess-1")).toEqual([ask, { id: "p", who: "sk", text: "Half an ans", pending: false }]);
  });
  it("keeps the latest entries only", () => {
    const s = fakeStorage();
    const many: TranscriptEntry[] = Array.from({ length: SK_TRANSCRIPT_MAX + 10 }, (_, i) => ({ id: `e${i}`, who: i % 2 ? "sk" : "user", text: `t${i}` }));
    createTranscriptStore(s).save("sess-1", many);
    const back = createTranscriptStore(s).load("sess-1")!;
    expect(back).toHaveLength(SK_TRANSCRIPT_MAX);
    expect(back.at(-1)!.id).toBe(`e${SK_TRANSCRIPT_MAX + 9}`);
  });
  it("older than the memory gap → dropped and cleared", () => {
    const s = fakeStorage();
    createTranscriptStore(s, () => 0).save("sess-1", [ask]);
    expect(createTranscriptStore(s, () => SK_MEMORY_STORE_GAP_MS + 1).load("sess-1")).toBeNull();
    expect(s.map.has(SK_TRANSCRIPT_KEY)).toBe(false);
  });
  it("tolerates no storage, junk JSON, junk entries and a throwing storage", () => {
    expect(createTranscriptStore(null).load("sess-1")).toBeNull();
    createTranscriptStore(undefined).save("sess-1", [ask]);
    const s = fakeStorage();
    s.map.set(SK_TRANSCRIPT_KEY, "{not json");
    expect(createTranscriptStore(s).load("sess-1")).toBeNull();
    s.map.set(SK_TRANSCRIPT_KEY, JSON.stringify({ sessionId: "sess-1", savedAt: Date.now(), entries: [{ who: "user" }, ask, 7] }));
    expect(createTranscriptStore(s).load("sess-1")).toEqual([ask]);
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const t = createTranscriptStore(throwing);
    expect(() => t.save("sess-1", [ask])).not.toThrow();
    expect(t.load("sess-1")).toBeNull();
    expect(() => t.clear()).not.toThrow();
  });
  it("no session id → nothing saved", () => {
    const s = fakeStorage();
    createTranscriptStore(s).save(null, [ask]);
    expect(s.map.size).toBe(0);
  });
});
