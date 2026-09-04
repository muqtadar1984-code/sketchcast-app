import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { STUDENT_KINDS, assignableIds } from "../kit";
import { docDownloadName } from "@/utils/download-name";
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
    expect(item).toMatch(/\{t\.item\.deckWontLoad\}/);
  });

  it("the student page keeps signing deck_pptx for every kind, deck included", () => {
    const page = src("app/dashboard/page.tsx");
    // The student branch skips only the teacher plan; a deck-kind row passes.
    expect(page).toMatch(/if \(!info \|\| g\.kind === "lesson_plan"\) continue;/);
    expect(page).toMatch(/\.filter\(\(a\) => a\.kind === "deck_pptx"\)/);
  });
});

/* The adversarial review of the first cut (2026-09-04) found three things
 * about the student's deck row; each is pinned below so it cannot drift back.
 *
 * 1. The .pptx was signed bare. Without a Content-Disposition iOS Safari opens
 *    a .pptx INLINE in the same tab (Quick Look) — navigating the dashboard
 *    away while the row's completion write is still in flight — and on any
 *    browser a link whose hour had run out failed at storage AFTER the row was
 *    already marked done, with the write's own error discarded.
 * 2. The empty state said "not ready yet — check back soon" for what the code
 *    itself documents as a signing failure THIS render (a share only exists
 *    for a done row), where the lesson's equivalent says "refresh the page".
 * 3. The row label came from an English-only map on the page, so the deck
 *    (and every other kind) read in English on the student's own dashboard
 *    while the parent, teacher and diary surfaces were translated.
 */
describe("the student's deck click is a download that is honest about its result", () => {
  const item = src("app/dashboard/student-item.tsx");
  const page = src("app/dashboard/page.tsx");

  it("the page signs a deck-kind row's .pptx WITH a download disposition, a lesson's embedded decks without", () => {
    expect(page).toMatch(/const deckName = docDownloadName\(g\.kind, "deck_pptx"\);/);
    expect(page).toMatch(/deckPaths\.map\(\(p\) => sign\(p, deckName\)\)/);
    expect(docDownloadName("deck", "deck_pptx")).toBe("Deck.pptx");
    expect(docDownloadName("presentation", "deck_pptx")).toBeUndefined();
  });

  it("the anchor carries the download affordance and no target — a disposition download in a new tab strands it", () => {
    const anchor = /<a href=\{deckUrl\} download onClick=\{\(e\) => void openDeck\(e\)\}[^>]*>/.exec(item);
    expect(anchor).not.toBeNull();
    expect(anchor![0]).not.toMatch(/target=/);
  });

  it("refuses an expired link BEFORE writing anything, in the words the lesson uses for a part that won't load", () => {
    const body = item.slice(item.indexOf("async function openDeck("), item.indexOf("const isLesson ="));
    // The expiry check comes first, prevents the navigation, and shows the
    // load-failure line; the completion upsert is only reached after it.
    const check = body.indexOf("signedUrlExpired(deckUrl)");
    const refuse = body.indexOf("setError(t.item.deckWontLoad)");
    const write = body.indexOf('status: "completed"');
    expect(check).toBeGreaterThan(0);
    expect(body.slice(check, refuse)).toMatch(/e\.preventDefault\(\)/);
    expect(refuse).toBeLessThan(write);
  });

  it("shows the write's own failure and leaves the row's status alone", () => {
    const body = item.slice(item.indexOf("async function openDeck("), item.indexOf("const isLesson ="));
    expect(body).toMatch(/const \{ error: pErr \} = await supabase/);
    expect(body).toMatch(/if \(pErr\) \{\s*setError\(pErr\.message\);\s*return;\s*\}\s*setStatus\("completed"\);/);
  });

  it("the empty state names a load failure, not an unbuilt deck — the same tail as partWontLoad, in every locale", () => {
    const locales = { en, ms, ar, fr, es, pt, te, mr, hi, "ms-arab": msArab };
    const tail = (s: string) => s.slice(s.lastIndexOf("—")).trim();
    for (const [name, d] of Object.entries(locales)) {
      const t = (d as typeof en).student.item;
      expect(t, name).not.toHaveProperty("deckNotReady");
      expect(tail(t.deckWontLoad), `${name}: "${t.deckWontLoad}" vs "${t.partWontLoad}"`).toBe(tail(t.partWontLoad));
    }
    expect(en.student.item.deckWontLoad).toBe("Deck couldn't load — refresh the page");
  });
});

describe("the student dashboard's own labels come from the dictionary", () => {
  const page = src("app/dashboard/page.tsx");

  it("has no English-only kind map left on the page", () => {
    expect(page).not.toMatch(/KIND_LABEL/);
  });

  it("builds the row label from the kind's dictionary word and the part from its message", () => {
    expect(page).toMatch(/label: `\$\{kindLabel\(t, g\.kind\)\}\$\{partLabel\}`/);
    expect(page).toMatch(/fmt\(t\.part, \{ n: genPart \}\)/);
    // `library.kinds` carries the deck in every locale, so the student's row
    // reads "Slaid"/"Diapos"/"الشرائح", not "Deck".
    expect(en.library.kinds.deck).toBe("Deck");
    expect(ms.library.kinds.deck).not.toBe("Deck");
  });

  it("resolves the dictionary BEFORE the student branch returns", () => {
    const resolved = page.indexOf("const dict = await getDictionary(locale);");
    const studentBranch = page.indexOf('if (role === "student") {');
    expect(resolved).toBeGreaterThan(0);
    expect(resolved).toBeLessThan(studentBranch);
  });

  it("the chapter headings fall back to dictionary words too", () => {
    expect(page).toMatch(/\? dict\.student\.noChapter/);
    expect(page).toMatch(/fmt\(t\.chapter, \{ n: Number\(chKey\) \+ 1 \}\)/);
    expect(page).not.toMatch(/"Lessons"/);
    expect(en.student.noChapter).toBe("Lessons");
    expect(en.library.chapter).toBe("Chapter {n}");
  });
});

describe("an assigned deck has a name on the adult surfaces too", () => {
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
    expect(en.student.item.deckWontLoad.length).toBeGreaterThan(0);
  });

  it("the Present rail still leaves the deck out on purpose", () => {
    expect(src("utils/present/kit.ts")).toMatch(/g\.kind !== "presentation" && g\.kind !== "deck"/);
  });
});
