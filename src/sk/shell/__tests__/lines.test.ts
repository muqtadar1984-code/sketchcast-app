/**
 * SK's fixed Board lines (lines.ts) are the SAME strings as the dictionary's
 * sk.shell.lessonNotStarted / sk.shell.startingLesson, in all ten locales —
 * the route emits the former, the UI types the latter, and they must not drift.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/lines.test.ts
 */
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/i18n/locales";
import en from "@/i18n/messages/en.json";
import ms from "@/i18n/messages/ms.json";
import ar from "@/i18n/messages/ar.json";
import fr from "@/i18n/messages/fr.json";
import es from "@/i18n/messages/es.json";
import pt from "@/i18n/messages/pt.json";
import te from "@/i18n/messages/te.json";
import mr from "@/i18n/messages/mr.json";
import hi from "@/i18n/messages/hi.json";
import msArab from "@/i18n/messages/ms-arab.json";
import { LESSON_NOT_STARTED, STARTING_LESSON, lineFor } from "../lines";

type Shell = { sk: { shell: { lessonNotStarted: string; startingLesson: string } } };
const FILES: Record<string, Shell> = { en, ms, ar, fr, es, pt, te, mr, hi, "ms-arab": msArab } as unknown as Record<string, Shell>;

describe("lines.ts ⇄ messages/*.json", () => {
  it("every registry locale has both lines, equal to the dictionary's", () => {
    for (const { value } of LOCALES) {
      expect(LESSON_NOT_STARTED[value], value).toBe(FILES[value].sk.shell.lessonNotStarted);
      expect(STARTING_LESSON[value], value).toBe(FILES[value].sk.shell.startingLesson);
      expect(STARTING_LESSON[value]).toContain("{lesson}");
    }
    expect(Object.keys(LESSON_NOT_STARTED).sort()).toEqual(LOCALES.map((l) => l.value).sort());
  });
  it("lineFor fills the placeholder and falls back to English", () => {
    expect(lineFor(STARTING_LESSON, "en", { lesson: "7B · Science · Specialised Cells" })).toBe("Starting 7B · Science · Specialised Cells.");
    expect(lineFor(STARTING_LESSON, "ms", { lesson: "7B" })).toBe("Memulakan 7B.");
    expect(lineFor(LESSON_NOT_STARTED, "xx")).toBe(LESSON_NOT_STARTED.en);
    expect(lineFor(LESSON_NOT_STARTED, null)).toBe(LESSON_NOT_STARTED.en);
  });
});
