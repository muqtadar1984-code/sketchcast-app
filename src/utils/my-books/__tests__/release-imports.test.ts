// SK S7 K3 — the founder's "Import now" card: founder emails only (nothing is
// read for anyone else); live finals with their last import; drafts listed as
// "skipped (drafts not used)" and never as importable; the waiting states.
// Plus the strip's strings: library.myBooks in all ten locales.
// Run: node node_modules/vitest/vitest.mjs run src/utils/my-books/__tests__/release-imports.test.ts
import { describe, expect, it, vi } from "vitest";
import { fakeDb } from "@/sk/knowledge/__tests__/fake-db";
import { describePoll, founderImportCard, isFounderEmail, loadReleaseImports } from "../release-imports";
import { LOCALES } from "@/i18n/locales";

const FOUNDERS = ["founder@sketchcast.app"];
const rel = (id: number, kind: "final" | "draft", over: Record<string, unknown> = {}) => ({
  id,
  work_uid: `w-${id}`,
  slug: `book-${id}`,
  title: `Book ${id}`,
  language: "en",
  release_kind: kind,
  edition_key: `e${id}`,
  released_at: "2026-10-30T10:00:00Z",
  superseded_by: null,
  withdrawn_at: null,
  ...over,
});

describe("the founder card", () => {
  it("appears only for founder emails (any case); other staff and readers get null and nothing is read", async () => {
    expect(isFounderEmail("Founder@SketchCast.app", FOUNDERS)).toBe(true);
    expect(isFounderEmail("sara@sketchcast.app", FOUNDERS)).toBe(false);
    expect(isFounderEmail("", FOUNDERS)).toBe(false);
    expect(isFounderEmail(null, FOUNDERS)).toBe(false);

    const db = vi.fn(() => fakeDb({ pub_releases: [rel(1, "final")] }));
    expect(await founderImportCard("sara@sketchcast.app", FOUNDERS, db)).toBeNull();
    expect(await founderImportCard(null, FOUNDERS, db)).toBeNull();
    expect(db).not.toHaveBeenCalled();
    expect(await founderImportCard("founder@sketchcast.app", FOUNDERS, db)).toMatchObject({ state: "ok" });
    expect(db).toHaveBeenCalledTimes(1);
  });

  it("lists live finals with their last import, and drafts as skipped — never superseded or withdrawn rows", async () => {
    const db = fakeDb({
      pub_releases: [
        rel(1, "draft"),
        rel(2, "final"),
        rel(3, "final"),
        rel(4, "final", { superseded_by: 5 }),
        rel(5, "final", { withdrawn_at: "2026-10-31T00:00:00Z" }),
        rel(6, "final"),
      ],
      sk_release_imports: [
        { release_id: 2, status: "ok", imported_at: "2026-10-30T11:00:00Z", blocks: 42, error: null },
        { release_id: 3, status: "error", imported_at: "2026-10-30T11:00:00Z", blocks: 0, error: "AccessDenied" },
        { release_id: 1, status: "skipped", imported_at: "2026-10-30T11:00:00Z", blocks: 0, error: "draft releases are not used" },
      ],
    });
    const out = await loadReleaseImports(db);
    expect(out.state).toBe("ok");
    if (out.state !== "ok") return;
    expect(out.migration0174).toBe(true);
    expect(out.rows.map((r) => [r.id, r.kind, r.status])).toEqual([
      [6, "final", "never"],
      [3, "final", "error"],
      [2, "final", "ok"],
      [1, "draft", "draft_skipped"],
    ]);
    expect(out.rows.find((r) => r.id === 2)).toMatchObject({ blocks: 42, importedAt: "2026-10-30T11:00:00Z" });
    expect(out.rows.find((r) => r.id === 3)?.error).toBe("AccessDenied");
    // a draft never carries an import result — it is not importable
    expect(out.rows.find((r) => r.id === 1)).toMatchObject({ importedAt: null, blocks: null, error: null });
  });

  it("before the book app's 0172 → waiting_for_book_app", async () => {
    expect(await loadReleaseImports(fakeDb({}, { missing: ["pub_releases"] }))).toEqual({ state: "waiting_for_book_app", rows: [] });
  });

  it("before SK's 0174 → the releases still list, flagged migration0174 = false", async () => {
    const out = await loadReleaseImports(fakeDb({ pub_releases: [rel(2, "final"), rel(1, "draft")] }, { missing: ["sk_release_imports"] }));
    expect(out).toMatchObject({ state: "ok", migration0174: false });
    if (out.state === "ok") expect(out.rows.map((r) => r.status)).toEqual(["never", "draft_skipped"]);
  });

  it("the button's summary of the import route's answer", () => {
    expect(describePoll({ status: "waiting_for_0174", live: 1 })).toMatch(/0174 is not applied/);
    expect(describePoll({ status: "ok", live: 2, imported: [2], unchanged: [], skipped: [1], unavailable: [], errors: [] })).toBe("1 imported · 0 unchanged · 1 skipped");
    expect(describePoll({ error: "boom" })).toBe("Failed: boom");
  });
});

describe("library.myBooks strings", () => {
  // 0175 added the book card's chapter words (product-book-card.tsx)
  const KEYS = ["title", "subtitle", "chapters", "chapterOne", "openInSk", "download", "forChild", "forYourChild", "withdrawn", "unavailable", "chapterN", "showChapters", "kitComingSoon", "assignChapter", "assignFailed", "bySketchCast"];
  it.each(LOCALES.map((l) => [l.value]))("%s carries every key, translated, with its placeholders", async (locale) => {
    const en = (await import("@/i18n/messages/en.json")).default.library.myBooks as Record<string, string>;
    const m = (await import(`@/i18n/messages/${locale}.json`)).default.library.myBooks as Record<string, string>;
    expect(Object.keys(m).sort()).toEqual([...KEYS].sort());
    for (const k of KEYS) {
      expect(m[k]?.trim()).toBeTruthy();
      expect((m[k].match(/\{\w+\}/g) ?? []).sort()).toEqual((en[k].match(/\{\w+\}/g) ?? []).sort());
    }
    if (locale !== "en") expect(m.title).not.toBe(en.title);
  });
});
