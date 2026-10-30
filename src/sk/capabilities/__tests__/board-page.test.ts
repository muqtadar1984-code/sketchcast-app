/**
 * board.page (2026-10-31) — the roll by its own numbers, over the Board state
 * of production 2026-10-30 ("30 / 54": video slides 1–22 on pages 4–25, deck
 * slides 1–28 on 27–54), and board.load_deck's `page`.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/board-page.test.ts
 */
import { describe, expect, it } from "vitest";
import type { SkBoardState, SkContext } from "@/sk/shell/types";
import { BOARD_CAPABILITIES, rangePage, sayFor } from "../board";
import { ALL_FLAGS, NOW, SCHOOL_ID, TEACHER_ID, fakeSession } from "@/sk/shell/__tests__/fixtures";
import { buildContext, sanitizeBoard } from "@/sk/shell/context";
import { routeByRules } from "@/sk/shell/rules";

const BOARD: SkBoardState = {
  sessionId: "sess-1",
  manifestId: "man-1",
  generationId: "gen-1",
  rollPage: 29,
  rollCount: 54,
  rollAt: { kind: "deck", n: 4 },
  deck: "loaded",
  roll: [
    { kind: "video", from: 4, to: 25, first: 1, last: 22 },
    { kind: "deck", from: 27, to: 54, first: 1, last: 28 },
  ],
  segments: Array.from({ length: 22 }, (_, k) => ({ k, id: `s${k + 1}`, heading: `Heading ${k + 1}` })),
};
const ctxWith = (board: SkBoardState, locale = "en"): SkContext =>
  buildContext({
    user: { id: TEACHER_ID, email: "t@school.example" },
    role: "teacher",
    schoolId: SCHOOL_ID,
    hat: "teacher",
    coordinatorScope: [],
    plan: "school",
    staff: false,
    flags: ALL_FLAGS,
    collector: { path: "/present", board, locale },
    now: NOW,
  });
const deps = { session: fakeSession({}), now: NOW };
const cap = (name: string) => BOARD_CAPABILITIES.find((c) => c.meta.name === name)!;
const page = (args: Record<string, unknown>, board: SkBoardState = BOARD, locale = "en") => cap("board.page").handler(ctxWith(board, locale), args, deps);

describe("board.page", () => {
  it("meta: teacher hat, Board flag, immediate", () => {
    expect(cap("board.page").meta).toMatchObject({ tier: "immediate", kind: "board", hats: ["teacher"], flags: ["board"] });
  });
  it("a roll page exactly as shown; past the end is refused with the count", async () => {
    expect(await page({ to: "page", n: 31 })).toMatchObject({ ok: true, board: { move: "page", args: { page: 31 }, say: "Page 31." }, summary: "Page 31 / 54." });
    expect(await page({ to: "page", n: 55 })).toMatchObject({ ok: false, summary: "The roll has 54 pages.", error: "no_such_page" });
    expect(await page({ n: 12 })).toMatchObject({ ok: true, board: { args: { page: 12 } } });
  });
  it("next / previous / first / last from the page on screen, with the edges", async () => {
    expect(await page({ to: "next" })).toMatchObject({ board: { args: { page: 31 } } });
    expect(await page({ to: "previous" })).toMatchObject({ board: { args: { page: 29 } } });
    expect(await page({ to: "first" })).toMatchObject({ board: { args: { page: 1 } } });
    expect(await page({ to: "last" })).toMatchObject({ board: { args: { page: 54 } } });
    expect(await page({ to: "next" }, { ...BOARD, rollPage: 53 })).toMatchObject({ ok: false, summary: "This is the last page (54 / 54)." });
    expect(await page({ to: "previous" }, { ...BOARD, rollPage: 0 })).toMatchObject({ ok: false, summary: "This is the first page (1 / 54)." });
    // An older Board with no page numbers: the bridge counts.
    expect(await page({ to: "next" }, { sessionId: "sess-1" })).toMatchObject({ ok: true, board: { move: "page", args: { to: "next" } } });
  });
  it("a deck slide → the roll page it was loaded on (deck slide 4 = page 30), with the item for the bridge", async () => {
    expect(await page({ to: "deck", n: 4 })).toMatchObject({ ok: true, board: { move: "page", args: { page: 30, item: { kind: "deck", n: 4 } }, say: sayFor("page_deck", "en", { n: 4 }) } });
    expect(await page({ to: "deck", n: 29 })).toMatchObject({ ok: false, summary: "The deck on the roll has slides 1–28." });
    // Not on the roll yet → the load, landing on it (ONE move).
    expect(await page({ to: "deck", n: 4 }, { ...BOARD, deck: "ready", roll: [BOARD.roll![0]] })).toMatchObject({ ok: true, board: { move: "load_deck", args: { page: 4 } } });
    expect(await page({ to: "deck", n: 4 }, { ...BOARD, deck: undefined, roll: [] })).toMatchObject({ ok: false, error: "no_deck" });
  });
  it("a video slide loaded as a page → its roll page; not loaded → points at board.slide", async () => {
    expect(await page({ to: "video", n: 4 })).toMatchObject({ ok: true, board: { args: { page: 7, item: { kind: "video", n: 4 } } } });
    expect(await page({ to: "video", n: 4 }, { ...BOARD, roll: [] })).toMatchObject({ ok: false, error: "not_on_roll" });
  });
  it("a page inserted before a range: the shifted ranges the client sends give the shifted page", () => {
    const shifted: SkBoardState = { ...BOARD, roll: [{ kind: "video", from: 5, to: 26, first: 1, last: 22 }, { kind: "deck", from: 28, to: 30, first: 1, last: 3 }, { kind: "deck", from: 32, to: 56, first: 4, last: 28 }] };
    expect(rangePage(shifted, "deck", 4)).toBe(32);
    expect(rangePage(shifted, "deck", 3)).toBe(30);
    expect(rangePage(shifted, "video", 1)).toBe(5);
  });
  it("localised say lines", async () => {
    expect(await page({ to: "page", n: 31 }, BOARD, "ms")).toMatchObject({ board: { say: "Halaman 31." } });
    expect(await page({ to: "deck", n: 4 }, BOARD, "ar")).toMatchObject({ board: { say: "شريحة العرض 4." } });
  });
});

describe("board.load_deck page", () => {
  it("page=N lands there (said as that deck slide when it is already on the roll)", async () => {
    const r = await cap("board.load_deck").handler(ctxWith({ ...BOARD, deck: "ready" }), { page: 4 }, deps);
    expect(r).toMatchObject({ ok: true, board: { move: "load_deck", args: { page: 4 } } });
    expect(r.summary).toContain("then going to its slide 4");
  });
});

describe("the roll through the collector and the rules", () => {
  it("sanitizeBoard keeps rollCount / roll / rollAt, drops malformed ranges", () => {
    const b = sanitizeBoard({ ...BOARD, roll: [...BOARD.roll!, { kind: "deck", from: 5, to: 4, first: 1, last: 1 }, { kind: "pdf", from: 1, to: 1, first: 1, last: 1 }], rollAt: { kind: "deck", n: 4 } })!;
    expect(b.rollCount).toBe(54);
    expect(b.roll).toEqual(BOARD.roll);
    expect(b.rollAt).toEqual({ kind: "deck", n: 4 });
    expect(sanitizeBoard({ sessionId: "s", selection: { on: "page", n: 26, text: "" } })!.selection).toEqual({ on: "page", generationId: "", n: 26, text: "" });
    expect(sanitizeBoard({ sessionId: "s", selection: { on: "video", generationId: "gen-1", n: 4, text: "" } })!.selection).toEqual({ on: "video", generationId: "gen-1", n: 4, text: "" });
  });
  it("rules routing: 'next page', 'page 31', 'slide 4 in the deck' → board.page; 'slide 4' stays the video's", () => {
    const ctx = ctxWith(BOARD);
    expect(routeByRules("next page", ctx, NOW)).toEqual({ intent: "teach", move: "page", args: { to: "next" } });
    expect(routeByRules("go to page 31", ctx, NOW)).toEqual({ intent: "teach", move: "page", args: { to: "page", n: 31 } });
    expect(routeByRules("go to slide 4 in the deck", ctx, NOW)).toEqual({ intent: "teach", move: "page", args: { to: "deck", n: 4 } });
    expect(routeByRules("deck slide 4", ctx, NOW)).toEqual({ intent: "teach", move: "page", args: { to: "deck", n: 4 } });
    expect(routeByRules("slide 4", ctx, NOW)).toEqual({ intent: "teach", move: "slide", args: { k: 3 } });
  });
});
