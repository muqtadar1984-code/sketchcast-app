import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { STUDENT_KINDS, assignableIds } from "../kit";
import en from "@/i18n/messages/en.json";

/**
 * "Students get decks similar to worksheets" (founder, 2026-09-04).
 *
 * Until then the deck was an artifact of the presentation, so a student who
 * was assigned the lesson got its deck for free. Migration 0103 made the deck
 * a generation of its own — and three Assign controls each carried their own
 * private list of student kinds, none of which knew the new one. A class
 * assigned a fresh kit would have received the lesson, the worksheet and the
 * test paper, and no deck, with nothing on the teacher's screen to say so.
 *
 * The list now lives once (STUDENT_KINDS) and the three sites read it; the
 * rest of this file pins the surfaces a deck reaches once it is assigned, the
 * way premium-voices-threading does — vitest collects no .tsx, so a dropped
 * kind at any of them would otherwise be silent.
 */
const src = (rel: string) => readFileSync(join(process.cwd(), "src", rel), "utf8");

describe("STUDENT_KINDS", () => {
  it("hands the student the lesson, the deck, the worksheet and the test paper — nothing else", () => {
    expect([...STUDENT_KINDS]).toEqual(["presentation", "deck", "worksheet", "exam_paper"]);
  });

  it("never sends a teaching aid", () => {
    for (const aid of ["lesson_plan", "activity", "case_study"]) {
      expect(STUDENT_KINDS).not.toContain(aid);
    }
  });
});

describe("assignableIds", () => {
  const done = (id: string) => ({ id, status: "done" });

  it("sends only the rows that finished building, in the order given", () => {
    expect(
      assignableIds([done("lesson"), { id: "deck", status: "processing" }, done("ws"), { id: "exam", status: "error" }]),
    ).toEqual(["lesson", "ws"]);
  });

  it("skips the kinds a kit never had", () => {
    // A pre-0103 kit has no deck row: three ids, no hole, no crash.
    expect(assignableIds([done("lesson"), null, done("ws"), undefined])).toEqual(["lesson", "ws"]);
  });

  it("sends nothing for a kit still building", () => {
    expect(assignableIds([{ id: "a", status: "queued" }, null])).toEqual([]);
  });
});

describe("the deck reaches every Assign control", () => {
  it("the part card sends its deck alongside the lesson, worksheet and test paper", () => {
    expect(src("app/dashboard/lesson-card.tsx")).toMatch(
      /assignableIds\(\[part\.presentation, part\.deck, part\.worksheet, part\.exam\]\)/,
    );
  });

  it("the chapter row reads STUDENT_KINDS rather than its own list", () => {
    const chapter = src("app/dashboard/chapter-generate.tsx");
    expect(chapter).toMatch(/assignableIds\(STUDENT_KINDS\.map\(\(k\) => lessons\[k\]\)\)/);
    expect(chapter).not.toMatch(/\["presentation", "worksheet", "exam_paper"\]/);
  });

  it("the chapter row's per-part roll-up carries each part's deck", () => {
    expect(src("app/dashboard/book-table.tsx")).toMatch(
      /extraAssignableIds=\{ch\.parts\s*\.flatMap\(\(p\) => \[p\.presentation, p\.deck, p\.worksheet, p\.exam\]\)/,
    );
  });
});

describe("an assigned deck has a name and a control on every surface", () => {
  it("the student row downloads it and never offers a quiz or a file for it", () => {
    const item = src("app/dashboard/student-item.tsx");
    expect(item).toMatch(/const isDeck = item\.kind === "deck"/);
    // The deck branch is chosen BEFORE the document branch (which carries the
    // quiz button and the file picker), so a deck can reach neither.
    const deckBranch = item.indexOf(") : isDeck ? (");
    const docBranch = item.indexOf("{item.quiz && (");
    expect(deckBranch).toBeGreaterThan(0);
    expect(docBranch).toBeGreaterThan(deckBranch);
    expect(item).toMatch(/\{t\.item\.deckNotReady\}/);
  });

  it("the student page keeps signing deck_pptx for every kind, deck included", () => {
    const page = src("app/dashboard/page.tsx");
    // The student branch skips only the teacher plan; a deck-kind row passes.
    expect(page).toMatch(/if \(!info \|\| g\.kind === "lesson_plan"\) continue;/);
    expect(page).toMatch(/\.filter\(\(a\) => a\.kind === "deck_pptx"\)/);
    expect(page).toMatch(/^\s*deck: "Deck",$/m);
  });

  it("the parent's Children page and the analytics page translate the kind", () => {
    expect(src("app/dashboard/children/page.tsx")).toMatch(/^\s*deck: "deck",$/m);
    expect(src("app/dashboard/analytics/page.tsx")).toMatch(/^\s*deck: "deck",$/m);
    expect(en.school.children.kind.deck).toBe("Deck");
    expect(en.school.myAnalytics.kind.deck).toBe("Deck");
  });

  it("the diary has an icon and a word for it", () => {
    for (const view of ["student-view", "teacher-view"]) {
      expect(src(`app/dashboard/diary/${view}.tsx`)).toMatch(/^\s*deck: "🖼️",$/m);
    }
    expect(en.comms.diary.kinds.deck).toBe("Deck");
  });

  it("the student row's words exist", () => {
    expect(en.student.item.deck).toBe("Deck");
    expect(en.student.item.deckNotReady.length).toBeGreaterThan(0);
  });

  it("the Present rail still leaves the deck out on purpose", () => {
    expect(src("utils/present/kit.ts")).toMatch(/g\.kind !== "presentation" && g\.kind !== "deck"/);
  });
});
