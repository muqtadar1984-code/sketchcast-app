/**
 * The Context collector: URL-only selection, ISO weekday clock, locale from
 * <html lang>. Pure; injected location/clock/lang.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/client/__tests__/collector.test.ts
 */
import { describe, expect, it } from "vitest";
import { clockFrom, collect, localeFromLang, parseParams, selectionFromUrl } from "../collector";

describe("parseParams", () => {
  it("decodes, keeps the first value, tolerates no leading '?'", () => {
    expect(parseParams("?c=7B&topic=cell-division&c=8A")).toEqual({ c: "7B", topic: "cell-division" });
    expect(parseParams("a=1%202&b=x+y")).toEqual({ a: "1 2", b: "x y" });
    expect(parseParams("")).toEqual({});
    expect(parseParams("?")).toEqual({});
  });
  it("drops a malformed escape instead of throwing", () => {
    expect(parseParams("?ok=1&bad=%E0%A4%A")).toEqual({ ok: "1" });
  });
  it("keeps a flag with no value", () => {
    expect(parseParams("?flag&c=9")).toEqual({ flag: "", c: "9" });
  });
});

describe("selectionFromUrl — only the address bar, only three sources", () => {
  it("class from ?c=", () => {
    expect(selectionFromUrl("/dashboard/analytics", { c: "cls_1" })).toEqual({ classId: "cls_1" });
  });
  it("learner from /dashboard/reports/<id>, decoded", () => {
    expect(selectionFromUrl("/dashboard/reports/abc-123", {})).toEqual({ learnerId: "abc-123" });
    expect(selectionFromUrl("/dashboard/reports/a%20b/quiz", {})).toEqual({ learnerId: "a b" });
  });
  it("topic from ?topic= → productSlug", () => {
    expect(selectionFromUrl("/dashboard/kits", { topic: "fractions" })).toEqual({ productSlug: "fractions" });
  });
  it("all three together, and nothing when nothing is there", () => {
    expect(selectionFromUrl("/dashboard/reports/L1", { c: "C1", topic: "T1" })).toEqual({ learnerId: "L1", classId: "C1", productSlug: "T1" });
    expect(selectionFromUrl("/dashboard", {})).toBeUndefined();
    expect(selectionFromUrl("/dashboard/reports", {})).toBeUndefined();
    expect(selectionFromUrl("/dashboard/reports/", {})).toBeUndefined();
  });
  it("never invents an id from other params (bookId etc. are not URL-sourced in S0)", () => {
    expect(selectionFromUrl("/dashboard", { book: "b1", chapter: "3", learnerId: "x" })).toBeUndefined();
  });
});

describe("clockFrom — ISO weekday, minutes since local midnight", () => {
  it("Monday is 1, Sunday is 7", () => {
    // 2026-10-26 is a Monday; 2026-11-01 is a Sunday. Local-time constructors.
    expect(clockFrom(new Date(2026, 9, 26, 8, 5)).day).toBe(1);
    expect(clockFrom(new Date(2026, 10, 1, 8, 5)).day).toBe(7);
    expect(clockFrom(new Date(2026, 9, 28, 0, 0)).day).toBe(3); // Wednesday
  });
  it("minutes and iso", () => {
    const d = new Date(2026, 9, 28, 13, 47, 9);
    const c = clockFrom(d);
    expect(c.minutes).toBe(13 * 60 + 47);
    expect(c.iso).toBe(d.toISOString());
  });
});

describe("localeFromLang", () => {
  it("lower-cases and trims; empty → undefined", () => {
    expect(localeFromLang("ms-Arab")).toBe("ms-arab");
    expect(localeFromLang(" EN ")).toBe("en");
    expect(localeFromLang("")).toBeUndefined();
    expect(localeFromLang(null)).toBeUndefined();
  });
});

describe("collect", () => {
  it("assembles the SkCollector shape the turn request posts", () => {
    const now = new Date(2026, 9, 28, 9, 30);
    const c = collect({ location: { pathname: "/dashboard/reports/L9", search: "?c=7B&topic=t" }, now, lang: "hi" });
    expect(c).toEqual({
      path: "/dashboard/reports/L9",
      params: { c: "7B", topic: "t" },
      clock: { day: 3, minutes: 570, iso: now.toISOString() },
      selection: { classId: "7B", productSlug: "t", learnerId: "L9" },
      locale: "hi",
    });
  });
  it("omits selection/locale/board when absent and defaults the path", () => {
    const c = collect({ location: { pathname: "", search: "" }, now: new Date(2026, 0, 1) });
    expect(c.path).toBe("/");
    expect(c.selection).toBeUndefined();
    expect(c.locale).toBeUndefined();
    expect(c.board).toBeUndefined();
    expect(c.params).toEqual({});
  });
  it("passes board state through untouched when the caller has it", () => {
    const board = { sessionId: "ps_1", move: "segment", t: 12.5 };
    expect(collect({ location: { pathname: "/present", search: "" }, now: new Date(), board }).board).toEqual(board);
  });
});
