/**
 * prepareDeck: ready → load; missing → ask the worker ONCE (POST) and poll every
 * 3 s for at most 3 min; building → poll. deckPageOf keeps the storage path.
 * Run: node node_modules/vitest/vitest.mjs run src/app/present/__tests__/deck-load.test.ts
 */
import { describe, expect, it } from "vitest";
import { deckPageOf, prepareDeck, type DeckPagesReply, type DeckStatus } from "../deck-load";

const slide = { n: 1, path: "o/d/deck_pages/slide_01.png", url: "https://signed/x", w: 1920, h: 1080, title: "Cells" };
const READY: DeckPagesReply = { status: "ready", slides: [slide], mapUrl: "https://signed/m", map: "o/d/deck_pages/pages.json" };

function script(replies: DeckPagesReply[]) {
  const calls: string[] = [];
  let i = 0;
  let clock = 0;
  const fetchReply = async (g: string, m: "GET" | "POST") => {
    calls.push(`${m} ${g}`);
    return replies[Math.min(i++, replies.length - 1)];
  };
  const sleeps: number[] = [];
  const statuses: DeckStatus[] = [];
  const opts = {
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    onStatus: (s: DeckStatus) => statuses.push(s),
  };
  return { fetchReply, calls, sleeps, statuses, opts };
}

describe("prepareDeck", () => {
  it("ready at once: one GET, no sleep", async () => {
    const s = script([READY]);
    expect(await prepareDeck(s.fetchReply, "d", s.opts)).toEqual({ status: "ready", slides: [slide], map: READY.status === "ready" ? READY.map : null, mapUrl: "https://signed/m" });
    expect(s.calls).toEqual(["GET d"]);
    expect(s.sleeps).toEqual([]);
  });

  it("missing: POST straight away, then poll GET every 3 s until ready", async () => {
    const s = script([{ status: "missing" }, { status: "building" }, { status: "building" }, { status: "building" }, READY]);
    const r = await prepareDeck(s.fetchReply, "d", s.opts);
    expect(r.status).toBe("ready");
    expect(s.calls).toEqual(["GET d", "POST d", "GET d", "GET d", "GET d"]);
    expect(s.sleeps).toEqual([3000, 3000, 3000]);
    expect(s.statuses.at(-1)).toBe("ready");
    expect(s.statuses).toContain("building");
  });

  it("gives up after 3 minutes of building", async () => {
    const s = script([{ status: "building" }]);
    expect(await prepareDeck(s.fetchReply, "d", s.opts)).toEqual({ status: "failed", reason: "timeout" });
    expect(s.sleeps.reduce((a, b) => a + b, 0)).toBe(180_000);
    expect(s.statuses.at(-1)).toBe("failed");
  });

  it("asked once and still missing: nothing to wait for; a thrown fetch and an abort fail too", async () => {
    const s = script([{ status: "missing" }, { status: "missing" }]);
    expect(await prepareDeck(s.fetchReply, "d", s.opts)).toEqual({ status: "failed", reason: "missing" });
    expect(s.calls).toEqual(["GET d", "POST d"]);

    const boom = await prepareDeck(async () => {
      throw new Error("net");
    }, "d");
    expect(boom).toEqual({ status: "failed", reason: "error" });

    const ac = new AbortController();
    ac.abort();
    expect(await prepareDeck(script([READY]).fetchReply, "d", { signal: ac.signal })).toEqual({ status: "failed", reason: "aborted" });
  });
});

describe("deckPageOf", () => {
  it("keeps the storage path (never the signed URL), the size, the title and the map", () => {
    expect(deckPageOf("d", slide, "o/d/deck_pages/pages.json")).toEqual({
      kind: "deckPage",
      generationId: "d",
      n: 1,
      src: "o/d/deck_pages/slide_01.png",
      w: 1920,
      h: 1080,
      title: "Cells",
      map: "o/d/deck_pages/pages.json",
    });
    expect(deckPageOf("d", { ...slide, title: "" }, null)).toEqual({ kind: "deckPage", generationId: "d", n: 1, src: slide.path, w: 1920, h: 1080 });
  });
});
