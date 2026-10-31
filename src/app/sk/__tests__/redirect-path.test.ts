/**
 * SK Tutor is retired (founder 2026-10-31): /sk, /sk/<product> and
 * /sk/<product>/<chapter> only forward a bookmark. An adult the Board admits
 * lands on the Board — on that SketchCast book, and on that chapter (the old
 * 1-based release chapter becomes the Board's 0-based num) when both resolve;
 * a student, a signed-out visitor or an adult without the Board lands on
 * /dashboard. The pages render nothing of the old tutor.
 * Run: node node_modules/vitest/vitest.mjs run src/app/sk/__tests__/redirect-path.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { boardChapterOf, skRedirectPath } from "../redirect-path";
import { parsePresentDeepLink } from "@/app/present/deep-link";

const adult = { signedIn: true, role: "teacher", board: true };

describe("skRedirectPath", () => {
  it("students, signed-out visitors and adults without the Board → /dashboard", () => {
    expect(skRedirectPath({ signedIn: false, role: null, board: false })).toBe("/dashboard");
    expect(skRedirectPath({ signedIn: true, role: "student", board: true, bookId: "b1", chapterNum: 0 })).toBe("/dashboard");
    expect(skRedirectPath({ signedIn: true, role: "parent", board: false, bookId: "b1" })).toBe("/dashboard");
  });
  it("an adult with the Board → the Board; the book; the book and chapter", () => {
    expect(skRedirectPath(adult)).toBe("/present");
    expect(skRedirectPath({ ...adult, bookId: "b1" })).toBe("/present?book=b1");
    expect(skRedirectPath({ ...adult, bookId: "b1", chapterNum: null })).toBe("/present?book=b1");
    expect(skRedirectPath({ ...adult, bookId: "b1", chapterNum: 4 })).toBe("/present?book=b1&chapter=4");
  });
  it("the Board reads the link it builds (deep-link.ts)", () => {
    const search = skRedirectPath({ ...adult, bookId: "b1", chapterNum: 4 }).split("?")[1]!;
    expect(parsePresentDeepLink(search, { classes: [], books: [{ id: "b1", chapters: [{ num: 4 }] }] })).toEqual({ autostart: false, bookId: "b1", chapterNum: 4 });
  });
});

describe("boardChapterOf: /sk's 1-based release chapter → the Board's 0-based num", () => {
  const chapters = [{ num: 0 }, { num: 1 }, { num: 4 }];
  it("maps a chapter the book has", () => {
    expect(boardChapterOf("1", chapters)).toBe(0);
    expect(boardChapterOf("5", chapters)).toBe(4);
  });
  it("drops anything else", () => {
    for (const ref of ["3", "0", "", null, undefined, "1a", "5.1", "9999"]) expect(boardChapterOf(ref, chapters), String(ref)).toBeNull();
    expect(boardChapterOf("1", null)).toBeNull();
  });
});

describe("the tutor UI is gone", () => {
  const SK = resolve(__dirname, "..");
  it("no kit player, chapter list, launcher or Shell layout under /sk", () => {
    for (const f of ["layout.tsx", "chapter-links.tsx", "sk-tutor-launcher.tsx", join("[product]", "[chapter]", "kit-player.tsx")]) expect(existsSync(join(SK, f)), f).toBe(false);
  });
  it("each page only redirects", () => {
    for (const f of ["page.tsx", join("[product]", "page.tsx"), join("[product]", "[chapter]", "page.tsx")]) {
      const src = readFileSync(join(SK, f), "utf8");
      expect(src, f).toMatch(/return skRedirect\(/);
      expect(src, f).not.toMatch(/KitPlayer|ChapterLinks|SkTutorLauncher/);
    }
  });
});
