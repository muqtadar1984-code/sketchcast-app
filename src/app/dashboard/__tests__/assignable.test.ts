import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { STUDENT_KINDS, assignableIds } from "../kit";
import { DECK_URL_TTL_SECONDS } from "@/app/api/deck/logic";
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

  it("the student page collects deck_pptx for every kind, deck included", () => {
    const page = src("app/dashboard/page.tsx");
    // The student branch skips only the teacher plan; a deck-kind row passes.
    expect(page).toMatch(/if \(!info \|\| g\.kind === "lesson_plan"\) continue;/);
    expect(page).toMatch(/\.filter\(\(a\) => a\.kind === "deck_pptx"\)/);
  });
});

/* The dedup that keeps ONE deck link per unit lives in two pure helpers
 * (kit.ts, covered by student-deck-dedup.test.ts) — but the helpers only do
 * anything if the page calls them, in the right place, with the right
 * arguments, and vitest collects no .tsx. Wired wrong, both suites stay green
 * while a student sees the deck twice: once on the deck row (which records the
 * download) and once on the lesson row (which records nothing). */
describe("the student page WIRES the one-deck-per-unit rule, not just the helpers", () => {
  const page = src("app/dashboard/page.tsx");

  it("builds the assigned-deck unit set from the generations and the share map", () => {
    expect(page).toMatch(/const deckUnits = assignedDeckUnits\(gens, \(id\) => shareByGen\.has\(id\)\);/);
    expect(page).toMatch(/import \{ assignedDeckUnits, studentDeckLinks \} from "\.\/kit";/);
  });

  it("filters each row's own deck paths through studentDeckLinks(g, deckUnits, …)", () => {
    // The third argument is the row's OWN deck_pptx paths in part order; the
    // helper returns [] only for a presentation whose unit has a deck row.
    expect(page).toMatch(
      /const deckPaths = studentDeckLinks\(\s*g,\s*deckUnits,\s*arts\s*\.filter\(\(a\) => a\.kind === "deck_pptx"\)/,
    );
  });

  it("computes the unit set BEFORE the item loop — inside it, every row would see an empty set", () => {
    const units = page.indexOf("const deckUnits = assignedDeckUnits(");
    const loop = page.indexOf("for (const g of gens) {");
    const use = page.indexOf("const deckPaths = studentDeckLinks(");
    expect(units).toBeGreaterThan(0);
    expect(units).toBeLessThan(loop);
    expect(loop).toBeLessThan(use);
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
 *
 * The fourth pass (2026-09-05) found two more about the same click, both
 * pinned here too:
 * 4. The row rendered the route link even when the PAGE could not build a
 *    service-role client — and /api/deck builds its own from that same env,
 *    so every click was a 500 whose JSON body the browser saved as the file,
 *    over a row that had just written "Completed".
 * 5. Every refusal reached the student that way: a downloaded JSON body, no
 *    message on screen, the completion already written, and a retry counted
 *    as a revision. The click now asks the route first.
 */
describe("the student's deck click is a download that is honest about its result", () => {
  const item = src("app/dashboard/student-item.tsx");
  const page = src("app/dashboard/page.tsx");

  it("hands a deck row the ROUTE, never a signed URL — a lesson's embedded decks are still signed here", () => {
    // A signed URL rendered into the page is an hour-long link the row then
    // has to reason about, and cannot: see the expiry test below.
    expect(page).toMatch(/\? \[`\/api\/deck\/\$\{g\.id\}`\]/);
    expect(page).toMatch(/g\.kind === "deck"/);
    // …and only when the page HAS a service role. /api/deck builds its own
    // from the same env, so a page that could not build one is looking at a
    // route that will answer 500 to every click. Ungated, the row rendered a
    // live-looking ⬇ Deck that saved a JSON error and recorded "Completed";
    // gated, it falls back to the deckWontLoad span and records nothing.
    // (Every other download on the page is already absent in that state —
    // `sign` returns null the moment `admin` is null.)
    expect(page).toMatch(/deckPaths\.length && downloadsReady/);
    // The lesson branch signs its embedded decks BARE — no disposition, the
    // shape those links have always had.
    expect(page).toMatch(/deckPaths\.map\(\(p\) => sign\(p\)\)/);
    expect(page).not.toMatch(/sign\(p, deckName\)/);
    // The name moved to the route, which is now the only thing that sets it.
    expect(page).not.toMatch(/docDownloadName\(g\.kind, "deck_pptx"\)/);
    expect(src("app/api/deck/logic.ts")).toMatch(/DECK_FILENAME = "Deck\.pptx"/);
    expect(docDownloadName("deck", "deck_pptx")).toBe("Deck.pptx");
    expect(docDownloadName("presentation", "deck_pptx")).toBeUndefined();
  });

  it("gates the route link on the service role the route itself needs", () => {
    // The gate is only a gate if it is decided BEFORE the row is built.
    const ready = page.indexOf("let downloadsReady = true;");
    const loop = page.indexOf("for (const g of gens) {");
    const gate = page.indexOf("deckPaths.length && downloadsReady");
    expect(ready).toBeGreaterThan(0);
    expect(ready).toBeLessThan(loop);
    expect(loop).toBeLessThan(gate);
    // The same flag the student dashboard already explains to the student.
    expect(page).toMatch(/downloadsReady=\{downloadsReady\}/);
    expect(src("app/dashboard/student-dashboard.tsx")).toMatch(/!downloadsReady &&/);
  });

  it("the deck control is a BUTTON that asks the route first — an anchor cannot wait for an answer", () => {
    // An anchor navigates whatever the route is about to say, so the row's
    // onClick wrote "Completed" over refusals that arrived as downloaded
    // JSON. The click now probes with redirect:"manual" and records only
    // when deckRouteAgreed (../deck-click.ts) says the route agreed.
    expect(item).not.toMatch(/<a href=\{deckUrl\}/);
    const button = /<button\s+onClick=\{\(\) => void openDeck\(\)\}[\s\S]{0,200}?>/.exec(item);
    expect(button).not.toBeNull();
    expect(button![0]).not.toMatch(/target=/);
    expect(item).toMatch(/import \{ deckRouteAgreed \} from "\.\/deck-click";/);
    const body = item.slice(item.indexOf("async function openDeck("), item.indexOf("const isLesson ="));
    expect(body).toMatch(/await fetch\(deckUrl, \{ redirect: "manual" \}\)/);
    // The refusal path returns BEFORE any write — and before markOpen, which
    // is what turned a retry into a revision.
    const probe = body.indexOf("if (!deckRouteAgreed(res))");
    const write = body.indexOf('.from("student_progress")');
    const revise = body.indexOf("await markOpen();");
    expect(probe).toBeGreaterThan(0);
    expect(probe).toBeLessThan(write);
    expect(probe).toBeLessThan(revise);
    expect(body).toMatch(/if \(!deckRouteAgreed\(res\)\) \{[\s\S]{0,600}?setError\(t\.item\.deckWontLoad\);\s*return;/);
    // The download is handed over LAST, after the row has been recorded.
    expect(body.indexOf("window.location.href = deckUrl;")).toBeGreaterThan(write);
  });

  it("holds NO signed URL and runs NO client-side expiry check — the router defeats every version of one", () => {
    // The interim fix measured the link's age from the row's mount. A
    // client-router restore hands the row the CACHED hour-old URL together
    // with a FRESH mount clock, so the expired link read as new, the row
    // wrote "Completed", and the download failed at storage. The check is
    // gone, the module it lived in is gone, and the URL it guarded is gone:
    // the href is a route that mints a short-lived URL when it is followed.
    expect(item).not.toMatch(/signedUrlExpired|mountedAt|signed-url/);
    expect(existsSync(join(process.cwd(), "src/utils/signed-url.ts"))).toBe(false);
    // A BAND, not the literal this used to spell out: the number is the
    // route's business (deck.test.ts holds the floor and the reason for it —
    // 60 s outlived the redirect but not the download). What matters HERE is
    // only that the page is not back to rendering an hour-long link.
    expect(DECK_URL_TTL_SECONDS).toBeLessThanOrEqual(900);
    expect(page).not.toMatch(/createSignedUrl\([^)]*3600[^)]*deck/i);
  });

  it("shows the write's own failure and leaves the row's status alone", () => {
    const body = item.slice(item.indexOf("async function openDeck("), item.indexOf("const isLesson ="));
    expect(body).toMatch(/const \{ error: pErr \} = await supabase/);
    // The status moves ONLY on a write that landed; a failed one says so and
    // leaves the badge where it was.
    expect(body).toMatch(/if \(pErr\) setError\(pErr\.message\);\s*else setStatus\("completed"\);/);
    expect(body).not.toMatch(/setStatus\("completed"\);[\s\S]*?if \(pErr\)/);
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
