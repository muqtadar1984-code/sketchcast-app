/**
 * Lesson-page views from Cloudflare's per-path rows (0139). Pinned: the path
 * shapes that count as a lesson page (every locale prefix, no index, no
 * assets), the window, the per-slug merge across locales, and the order.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/cloudflare-paths.test.ts
 */
import { describe, expect, it } from "vitest";
import { lessonPageOf, lessonPageTotals, lessonPageViews, type PathRow } from "../cloudflare-paths";

const NOW = new Date("2026-10-16T16:00:00Z");
const R = (day: string, path: string, requests: number, visits: number): PathRow => ({ day, path, requests, visits });

describe("lessonPageOf", () => {
  it("recognises a lesson page in any locale and nothing else", () => {
    expect(lessonPageOf("/topics/cells")).toEqual({ slug: "cells", locale: "" });
    expect(lessonPageOf("/ar/topics/cells")).toEqual({ slug: "cells", locale: "ar" });
    expect(lessonPageOf("/ms-arab/topics/types-of-angles")).toEqual({ slug: "types-of-angles", locale: "ms-arab" });
    for (const p of ["/topics", "/ar/topics", "/", "/assets/previews/cells/deck-1.png", "/pricing", "/topics/cells/extra", ""]) {
      expect(lessonPageOf(p)).toBeNull();
    }
  });
});

describe("lessonPageViews", () => {
  it("merges locales per slug inside the window and sorts by visits", () => {
    const rows = [
      R("2026-10-16", "/topics/cells", 40, 25),
      R("2026-10-16", "/ar/topics/cells", 10, 8),
      R("2026-10-15", "/topics/cells", 20, 12),
      R("2026-10-16", "/topics/pythagoras", 50, 30),
      R("2026-10-16", "/", 500, 300),
      R("2026-10-16", "/topics", 60, 40),
      R("2026-10-09", "/topics/cells", 999, 999), // 8 days ago: outside a 7-day window
    ];
    const pages = lessonPageViews(rows, 7, NOW);
    expect(pages).toEqual([
      { slug: "cells", visits: 45, requests: 70, locales: ["", "ar"] },
      { slug: "pythagoras", visits: 30, requests: 50, locales: [""] },
    ]);
    expect(lessonPageTotals(pages)).toEqual({ visits: 75, requests: 120, pages: 2 });
    expect(lessonPageViews(rows, 30, NOW)[0].visits).toBe(45 + 999);
  });

  it("is empty on no rows", () => {
    expect(lessonPageViews([], 7, NOW)).toEqual([]);
    expect(lessonPageTotals([])).toEqual({ visits: 0, requests: 0, pages: 0 });
  });
});
