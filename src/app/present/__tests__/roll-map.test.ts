/**
 * The roll, page by page (2026-10-31; production 2026-10-30: "30 / 54" with
 * the video's slides on pages 4–25 and the deck on 27–54):
 *   - roll-map.ts reads the ranges off the pages (deck pages by n, slide
 *     frames by their time), and a page inserted anywhere shifts them;
 *   - the bridge sends rollCount / roll / rollAt with every turn, turns the
 *     roll (`page`: a number, next / previous / first / last, or an item found
 *     again on the live roll) and lands `load_deck` on a deck slide;
 *   - the controller's goToPage is audited `board.go_to_page`.
 * Run: node node_modules/vitest/vitest.mjs run src/app/present/__tests__/roll-map.test.ts
 */
import { describe, expect, it } from "vitest";
import type { PageBackground } from "@/board/model";
import { createBoardController, MemorySkActionSink, type BoardController, type BoardManifest, type BoardPorts, type BoardState } from "../board-controller";
import { rollAt, rollItems, rollPageOf, rollRanges, videoSlideAt } from "../roll-map";
import { createBoardBridge, type BridgeManifest } from "../sk-board-bridge";

const VIDEO = "vid-1";
const DECK = "deck-1";
/** 22 segments of 10 s; each slide's completed frame at 10k + 9.9. */
const MANIFEST: BridgeManifest = {
  manifestId: "man-1",
  segments: Array.from({ length: 22 }, (_, k) => ({ start_s: k * 10, end_s: k * 10 + 10, slide_t: k * 10 + 9.9, heading: `Heading ${k + 1}` })),
  ids: Array.from({ length: 22 }, (_, k) => `s${k + 1}`),
  concepts: [],
  items: [],
};

const frame = (t: number, generationId = VIDEO): PageBackground => ({ kind: "frame", src: `f/${t}.jpg`, generationId, t });
const deckPage = (n: number): PageBackground => ({ kind: "deckPage", generationId: DECK, n, src: `d/slide_${n}.png` });

/** The founder's roll: a blank, a frame she froze herself, a caption card,
 *  video slides 1–22 (pages 4–25), a blank, deck slides 1–28 (pages 27–54). */
function productionRoll(): PageBackground[] {
  return [
    { kind: "blank" },
    frame(3.2),
    { kind: "card", card: { source: "caption", heading: "Intro", body: [] } },
    ...MANIFEST.segments.map((s) => frame(s.slide_t!)),
    { kind: "blank" },
    ...Array.from({ length: 28 }, (_, i) => deckPage(i + 1)),
  ];
}

describe("roll-map", () => {
  it("reads the founder's 54-page roll: video slides 1–22 on pages 4–25, deck slides 1–28 on 27–54", () => {
    const pages = productionRoll();
    expect(pages).toHaveLength(54);
    const items = rollItems(pages, { generationId: VIDEO, manifest: MANIFEST });
    expect(rollRanges(items)).toEqual([
      { kind: "video", from: 4, to: 25, first: 1, last: 22 },
      { kind: "deck", from: 27, to: 54, first: 1, last: 28 },
    ]);
    expect(rollAt(pages, items, 29)).toEqual({ kind: "deck", n: 4 });
    expect(rollAt(pages, items, 0)).toEqual({ kind: "blank" });
    expect(rollAt(pages, items, 1)).toEqual({ kind: "frame" });
    expect(rollAt(pages, items, 2)).toEqual({ kind: "card" });
    expect(rollPageOf(items, "deck", 4)).toBe(29);
    expect(rollPageOf(items, "video", 4)).toBe(6);
  });

  it("a frame is a video slide only at that slide's completed frame, of the open unit's video", () => {
    expect(videoSlideAt(39.9, { generationId: VIDEO, manifest: MANIFEST })).toBe(4);
    expect(videoSlideAt(39.75, { generationId: VIDEO, manifest: MANIFEST })).toBe(4);
    expect(videoSlideAt(35, { generationId: VIDEO, manifest: MANIFEST })).toBeNull();
    expect(videoSlideAt(39.9, { generationId: VIDEO, manifest: null })).toBeNull();
    const items = rollItems([frame(39.9, "other-video"), frame(39.9)], { generationId: VIDEO, manifest: MANIFEST });
    expect(items).toEqual([null, { kind: "video", n: 4, generationId: VIDEO }]);
  });

  it("a page inserted before a range shifts it; one inserted inside splits it", () => {
    const pages = productionRoll();
    // "blank page" on page 2 → a new page 3; everything after moves down one.
    pages.splice(2, 0, { kind: "blank" });
    expect(rollRanges(rollItems(pages, { generationId: VIDEO, manifest: MANIFEST }))).toEqual([
      { kind: "video", from: 5, to: 26, first: 1, last: 22 },
      { kind: "deck", from: 28, to: 55, first: 1, last: 28 },
    ]);
    // A note between deck slides 3 and 4 (after page 30): slides 4–28 shift.
    pages.splice(30, 0, { kind: "blank" });
    const items = rollItems(pages, { generationId: VIDEO, manifest: MANIFEST });
    expect(rollRanges(items)).toEqual([
      { kind: "video", from: 5, to: 26, first: 1, last: 22 },
      { kind: "deck", from: 28, to: 30, first: 1, last: 3 },
      { kind: "deck", from: 32, to: 56, first: 4, last: 28 },
    ]);
    expect(rollPageOf(items, "deck", 4)).toBe(31);
  });

  it("the same deck twice: the copy nearest the page on screen", () => {
    const items = rollItems([deckPage(1), deckPage(2), { kind: "blank" }, deckPage(1), deckPage(2)], { generationId: VIDEO, manifest: MANIFEST });
    expect(rollPageOf(items, "deck", 2, 0)).toBe(1);
    expect(rollPageOf(items, "deck", 2, 4)).toBe(4);
  });
});

// ── the bridge over a fake controller holding a real roll ───────────────────

function rollController(pages: PageBackground[], page = 29) {
  const calls: Array<[string, ...unknown[]]> = [];
  const st: BoardState = { sessionId: "sess-1", t: 0, duration: 300, paused: true, moving: false, stageMode: "away", page, pageCount: pages.length, ended: false, questions: null, actions: [] };
  const c = {
    getState: () => ({ ...st, pageCount: pages.length, actions: [] }),
    getUnit: () => ({ generationId: VIDEO, part: 1, title: "Cells" }),
    rollPages: () => pages,
    findDeckPage: (n = 1) => {
      const i = pages.findIndex((p) => p.kind === "deckPage" && p.n === n);
      return i < 0 ? null : i;
    },
    goToPage: (p: number) => {
      calls.push(["goToPage", p]);
      if (p < 0 || p >= pages.length) throw new RangeError("no page");
      st.page = p;
      return p;
    },
    cancelLoad: () => {},
    pause: () => calls.push(["pause"]),
  } as unknown as BoardController;
  return { c, calls, st };
}

describe("bridge: the roll in the state, and the page move", () => {
  const make = (pages: PageBackground[], page = 29, deck?: { load: () => Promise<{ ok: boolean; summary: string; loaded?: { n: number; a: number; b: number; aborted: boolean } }> }) => {
    const ctl = rollController(pages, page);
    const bridge = createBoardBridge({
      controller: () => ctl.c,
      manifest: () => MANIFEST,
      mapStatus: () => "ready",
      ...(deck ? { deck: { status: () => "loaded" as const, load: deck.load } } : {}),
    });
    return { ...ctl, bridge };
  };

  it("state(): rollPage, rollCount, the ranges and what is on screen", () => {
    const { bridge } = make(productionRoll());
    const s = bridge.state()!;
    expect(s).toMatchObject({ rollPage: 29, rollCount: 54, rollAt: { kind: "deck", n: 4 } });
    expect(s.roll).toEqual([
      { kind: "video", from: 4, to: 25, first: 1, last: 22 },
      { kind: "deck", from: 27, to: 54, first: 1, last: 28 },
    ]);
  });

  it("page: a number as shown, next / previous / first / last, and the roll's edges", async () => {
    const { bridge, calls, st } = make(productionRoll());
    expect(await bridge.run("page", { page: 31 })).toEqual({ ok: true, summary: "Page 31 / 54." });
    expect(calls.at(-1)).toEqual(["goToPage", 30]);
    expect(await bridge.run("page", { to: "next" })).toMatchObject({ ok: true, summary: "Page 32 / 54." });
    expect(await bridge.run("page", { to: "previous" })).toMatchObject({ ok: true, summary: "Page 31 / 54." });
    expect(await bridge.run("page", { to: "last" })).toMatchObject({ ok: true, summary: "Page 54 / 54." });
    expect(await bridge.run("page", { to: "next" })).toEqual({ ok: false, summary: "This is the last page (54 / 54)." });
    expect(await bridge.run("page", { to: "first" })).toMatchObject({ ok: true, summary: "Page 1 / 54." });
    expect(await bridge.run("page", { to: "previous" })).toEqual({ ok: false, summary: "This is the first page (1 / 54)." });
    expect(await bridge.run("page", { page: 60 })).toEqual({ ok: false, summary: "The roll has 54 pages." });
    expect(st.page).toBe(0);
  });

  it("page with an item: found again on the LIVE roll, so an insert since the turn cannot misplace it", async () => {
    const pages = productionRoll();
    const { bridge, calls } = make(pages);
    // The server resolved deck slide 4 to page 30 — then a blank went in before it.
    pages.splice(5, 0, { kind: "blank" });
    expect(await bridge.run("page", { page: 30, item: { kind: "deck", n: 4 } })).toMatchObject({ ok: true, summary: "Page 31 / 55." });
    expect(calls.at(-1)).toEqual(["goToPage", 30]);
    expect(await bridge.run("page", { page: 7, item: { kind: "video", n: 3 } })).toMatchObject({ ok: true, summary: "Page 7 / 55." });
  });

  it("load_deck with page: lands on that deck slide once the pages are there", async () => {
    const pages = productionRoll();
    const { bridge, calls } = make(pages, 0, { load: async () => ({ ok: true, summary: "The deck is on the roll as pages 27–54.", loaded: { n: 28, a: 27, b: 54, aborted: false } }) });
    const r = await bridge.run("load_deck", { page: 4, done: "The deck is on the roll as pages {a}–{b}." });
    expect(r).toMatchObject({ ok: true, summary: "The deck is on the roll as pages 27–54. Deck page 4 is page 30.", done: "The deck is on the roll as pages 27–54." });
    expect(calls.at(-1)).toEqual(["goToPage", 29]);
  });

  it("a highlight with no words: on a video slide's frame it is that video slide; on a blank page it is the page", () => {
    const pages = productionRoll();
    let held: { on: "page"; generationId: string; n: number; text: string } | undefined = { on: "page", generationId: VIDEO, n: 7, text: "" };
    const ctl = rollController(pages, 6);
    const bridge = createBoardBridge({ controller: () => ctl.c, manifest: () => MANIFEST, mapStatus: () => "ready", highlight: () => held });
    expect(bridge.state()!.selection).toEqual({ on: "video", generationId: VIDEO, n: 4, text: "", title: "Heading 4" });
    held = { on: "page", generationId: "", n: 1, text: "" };
    expect(bridge.state()!.selection).toEqual({ on: "page", generationId: "", n: 1, text: "" });
  });
});

describe("controller: goToPage and rollPages", () => {
  it("turns the roll (stage away, paused), audited board.go_to_page; a page the roll lacks throws", () => {
    const pages = productionRoll();
    const log: Array<[string, ...unknown[]]> = [];
    let where = { page: 0, count: pages.length };
    const ports = {
      sessionId: () => "sess-1",
      actorId: () => "t-1",
      generationId: () => VIDEO,
      video: () => null,
      play: async () => {},
      resume: async () => {},
      pause: () => log.push(["pause"]),
      setStage: (m: string) => log.push(["stage", m]),
      freeze: async () => true,
      openWorksheetPage: () => false,
      blankPage: () => {},
      pushCard: () => {},
      loadQuestions: async () => null,
      goTo: (p: number) => {
        log.push(["goTo", p]);
        where = { ...where, page: p };
      },
      where: () => where,
      stageMode: () => "away" as const,
      endSession: async () => true,
      pages: () => pages,
    } as unknown as BoardPorts;
    const sink = new MemorySkActionSink();
    const c = createBoardController(ports, sink);
    expect(c.goToPage!(30)).toBe(30);
    expect(log).toEqual([["pause"], ["stage", "away"], ["goTo", 30]]);
    expect(sink.records.at(-1)).toMatchObject({ action: "board.go_to_page", ok: true, params: { page: 30 }, result: { page: 30, pageCount: 54 } });
    expect(() => c.goToPage!(54)).toThrow(/no page 55/);
    expect(sink.records.at(-1)).toMatchObject({ action: "board.go_to_page", ok: false });
    expect(c.rollPages!()).toBe(pages);
    const m: BoardManifest = MANIFEST;
    expect(rollRanges(rollItems(c.rollPages!()!, { generationId: VIDEO, manifest: m }))).toHaveLength(2);
  });
});
