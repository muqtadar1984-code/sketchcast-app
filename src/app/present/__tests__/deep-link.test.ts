/**
 * The Board's deep link (/present?class=&book=&chapter=&autostart=1, or
 * ?kit=): ids are taken only when the page's own lists hold them; a chapter
 * needs its book; a kit stands alone; autostart is a flag, never a pick.
 * Run: node node_modules/vitest/vitest.mjs run src/app/present/__tests__/deep-link.test.ts
 */
import { describe, expect, it } from "vitest";
import { deepLinkStartable, parsePresentDeepLink } from "../deep-link";

const lists = {
  classes: [{ id: "c7b" }, { id: "c7c" }],
  books: [
    { id: "b1", chapters: [{ num: 0 }, { num: 1 }, { num: 2 }] },
    { id: "b2", chapters: [] },
  ],
  kits: [{ id: "g-kit" }],
};

describe("parsePresentDeepLink", () => {
  it("a whole book link: class, book, chapter (the page's 0-based num) and autostart", () => {
    const d = parsePresentDeepLink("?class=c7b&book=b1&chapter=2&autostart=1", lists);
    expect(d).toEqual({ classId: "c7b", bookId: "b1", chapterNum: 2, autostart: true });
    expect(deepLinkStartable(d)).toBe(true);
  });
  it("accepts the query with or without the leading '?'", () => {
    expect(parsePresentDeepLink("book=b1&chapter=0", lists)).toEqual({ bookId: "b1", chapterNum: 0, autostart: false });
  });
  it("a kit link: the kit alone, a book beside it ignored", () => {
    const d = parsePresentDeepLink("?kit=g-kit&book=b1&chapter=1&autostart=1", lists);
    expect(d).toEqual({ kitId: "g-kit", autostart: true });
    expect(deepLinkStartable(d)).toBe(true);
  });
  it("unknown ids are dropped silently: no class, no book, no kit, nothing to start", () => {
    const d = parsePresentDeepLink("?class=cX&book=bX&chapter=1&kit=gX&autostart=1", lists);
    expect(d).toEqual({ autostart: true });
    expect(deepLinkStartable(d)).toBe(false);
  });
  it("a chapter the book does not have is dropped; the book stays picked; nothing starts", () => {
    const d = parsePresentDeepLink("?book=b1&chapter=9&autostart=1", lists);
    expect(d).toEqual({ bookId: "b1", autostart: true });
    expect(deepLinkStartable(d)).toBe(false);
    expect(parsePresentDeepLink("?book=b2&chapter=0", lists)).toEqual({ bookId: "b2", autostart: false });
  });
  it("a chapter without its book is nothing; malformed values are nothing", () => {
    expect(parsePresentDeepLink("?chapter=2", lists)).toEqual({ autostart: false });
    expect(parsePresentDeepLink("?book=b1&chapter=two", lists)).toEqual({ bookId: "b1", autostart: false });
    expect(parsePresentDeepLink("?class=c7b;drop&book=b1", lists)).toEqual({ bookId: "b1", autostart: false });
  });
  it("autostart is only '1'", () => {
    expect(parsePresentDeepLink("?book=b1&chapter=1&autostart=true", lists).autostart).toBe(false);
    expect(parsePresentDeepLink("?book=b1&chapter=1&autostart=1", lists).autostart).toBe(true);
  });
  it("an empty query is an empty pick — the manual flow", () => {
    expect(parsePresentDeepLink("", lists)).toEqual({ autostart: false });
    expect(parsePresentDeepLink("", { classes: [], books: [] })).toEqual({ autostart: false });
  });
});
