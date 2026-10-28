/**
 * The cross-page memory store (S1): save/restore through an injected storage,
 * clear on the 4-hour gap, tolerate a broken or absent storage.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/client/__tests__/memory-store.test.ts
 */
import { describe, expect, it } from "vitest";
import { SK_MEMORY_KEY, SK_MEMORY_STORE_GAP_MS, createMemoryStore, type StorageLike } from "../memory-store";

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

describe("save / load", () => {
  it("round-trips the blob and the session id under sk.memory", () => {
    const s = fakeStorage();
    let t = 1_000_000;
    const store = createMemoryStore(s, () => t);
    store.save({ memory: "blob.sig", sessionId: "sess-1" });
    expect(JSON.parse(s.map.get(SK_MEMORY_KEY)!)).toEqual({ memory: "blob.sig", sessionId: "sess-1", savedAt: 1_000_000 });
    t += 60_000;
    expect(store.load()).toEqual({ memory: "blob.sig", sessionId: "sess-1", savedAt: 1_000_000 });
  });
  it("a second panel (another page) reads what the first saved", () => {
    const s = fakeStorage();
    createMemoryStore(s, () => 5).save({ memory: "m1" });
    expect(createMemoryStore(s, () => 6).load()).toEqual({ memory: "m1", sessionId: null, savedAt: 5 });
  });
  it("nothing saved → null; an empty blob is not saved", () => {
    const s = fakeStorage();
    const store = createMemoryStore(s);
    expect(store.load()).toBeNull();
    store.save({ memory: "" });
    expect(s.map.size).toBe(0);
  });
});

describe("the gap", () => {
  it("over four hours old → null and cleared (the server would start fresh anyway)", () => {
    const s = fakeStorage();
    let t = 0;
    const store = createMemoryStore(s, () => t);
    store.save({ memory: "old" });
    t = SK_MEMORY_STORE_GAP_MS + 1;
    expect(store.load()).toBeNull();
    expect(s.map.has(SK_MEMORY_KEY)).toBe(false);
  });
  it("exactly at the gap still loads; a clock that went backwards by over a minute does not", () => {
    const s = fakeStorage();
    let t = 10_000_000;
    const store = createMemoryStore(s, () => t);
    store.save({ memory: "m" });
    t += SK_MEMORY_STORE_GAP_MS;
    expect(store.load()?.memory).toBe("m");
    t = 10_000_000 - 61_000;
    expect(store.load()).toBeNull();
  });
});

describe("robustness", () => {
  it("malformed JSON or a wrong shape → null, never a throw", () => {
    expect(createMemoryStore(fakeStorage({ [SK_MEMORY_KEY]: "{nope" })).load()).toBeNull();
    expect(createMemoryStore(fakeStorage({ [SK_MEMORY_KEY]: JSON.stringify({ memory: 5, savedAt: 1 }) })).load()).toBeNull();
    expect(createMemoryStore(fakeStorage({ [SK_MEMORY_KEY]: JSON.stringify({ memory: "m" }) })).load()).toBeNull();
  });
  it("a throwing storage (private mode) is silent; no storage at all is silent", () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const store = createMemoryStore(broken);
    expect(() => store.save({ memory: "m" })).not.toThrow();
    expect(store.load()).toBeNull();
    expect(() => store.clear()).not.toThrow();
    const none = createMemoryStore(null);
    none.save({ memory: "m" });
    expect(none.load()).toBeNull();
  });
  it("clear() removes the entry", () => {
    const s = fakeStorage();
    const store = createMemoryStore(s, () => 1);
    store.save({ memory: "m" });
    store.clear();
    expect(store.load()).toBeNull();
  });
});
