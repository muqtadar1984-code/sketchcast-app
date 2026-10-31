/**
 * The student Board (learner mode, SK student Board plan 2026-10-31, phase 1):
 * her assigned kits, their rails, the deep link, the coach's order, the
 * answer-stripped worksheet cards — and that a BOOK kit (an adopted catalogue
 * kit / SketchCast book chapter) is assigned exactly like an uploaded one and
 * reaches the student Board whole.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/app/present/__tests__/learner.test.ts
 */
import { describe, expect, it } from "vitest";
import { learnerAllowed, learnerKitFor, learnerKits, learnerKitKey, learnerUnits, learnerWorksheetIn, LEARNER_EXCLUDED_KINDS, type LearnerGen, type LearnerShare } from "@/utils/present/learner";
import { learnHref, learnLinks } from "@/utils/present/learner-links";
import { parsePresentDeepLink, deepLinkStartable } from "../deep-link";
import { firstStep, nextLine, nextStep, openingLine, type CoachLines } from "../learner-coach";
import { learnerQuestionCards, questionCards } from "../text-card";
import { assignableIds as booklessAssignableIds } from "@/app/dashboard/bookless-kits";
import { assignablePieces, piecesOf } from "@/app/dashboard/kits/logic";
import { assignableIds as libraryAssignableIds } from "@/app/dashboard/kit";
import { NOT_ASSIGNABLE_KINDS } from "@/sk/capabilities/assign";

const A = (kind: string) => ({ kind, storage_path: `t/${kind}` });

const gen = (o: Partial<LearnerGen> & { id: string; kind: string }): LearnerGen => ({
  title: null,
  chapter_ref: null,
  book_id: null,
  params: null,
  artifacts: [],
  status: "done",
  withdrawn_at: null,
  created_at: "2026-10-20T00:00:00Z",
  ...o,
});

// An uploaded book's chapter 3, split in two parts.
const BOOK = "b0000000-0000-4000-8000-000000000001";
const p1v = gen({ id: "p1v", kind: "presentation", book_id: BOOK, chapter_ref: "3", params: { part: 1 }, artifacts: [A("video_mp4")] });
const p1w = gen({ id: "p1w", kind: "worksheet", book_id: BOOK, chapter_ref: "3", params: { part: 1 }, artifacts: [A("docx"), A("questions_json"), A("answer_key_docx")] });
const p2v = gen({ id: "p2v", kind: "presentation", book_id: BOOK, chapter_ref: "3", params: { part: 2 }, artifacts: [A("video_mp4")] });
const plan = gen({ id: "plan", kind: "lesson_plan", book_id: BOOK, chapter_ref: "3", params: { part: 1 }, artifacts: [A("docx")] });
const exam = gen({ id: "exam", kind: "exam_paper", book_id: BOOK, chapter_ref: "3", params: { part: 1 }, artifacts: [A("docx"), A("questions_json")] });

// An ADOPTED catalogue kit (book-less copies, grouped by title prefix).
const cat = { catalogue_ref: { topic_kit_id: "tk1" } };
const cv = gen({ id: "cv", kind: "presentation", title: "Plant and Animal Cells · Plant and Animal Cells", params: cat, artifacts: [A("video_mp4")] });
const cd = gen({ id: "cd", kind: "deck", title: "Plant and Animal Cells · Slide deck", params: cat, artifacts: [A("deck_pptx")] });
const cw = gen({ id: "cw", kind: "worksheet", title: "Plant and Animal Cells · Worksheet", params: cat, artifacts: [A("docx"), A("questions_json"), A("answer_key_docx")] });
const cq = gen({ id: "cq", kind: "question_bank", title: "Plant and Animal Cells · Question bank", params: cat, artifacts: [A("docx")] });
const cp = gen({ id: "cp", kind: "lesson_plan", title: "Plant and Animal Cells · Lesson plan", params: cat, artifacts: [A("docx")] });

const share = (id: string, due: string | null = null, at = "2026-10-21T00:00:00Z"): LearnerShare => ({ generation_id: id, due_at: due, created_at: at });

describe("learnerKits — her assigned kits only", () => {
  it("a book chapter is ONE kit with a unit per part; only what was shared counts", () => {
    const kits = learnerKits([p1v, p1w, p2v, plan, exam], [share("p1v"), share("p1w"), share("p2v"), share("plan"), share("exam")]);
    expect(kits).toHaveLength(1);
    const k = kits[0];
    expect(k.key).toBe(`b:${BOOK}:3`);
    expect(k.bookId).toBe(BOOK);
    expect(k.chapterNum).toBe(3);
    expect(k.id).toBe("p1v");
    expect(k.units.map((u) => [u.part, u.video?.id ?? null, u.docs.map((d) => d.kind)])).toEqual([
      [1, "p1v", ["worksheet"]],
      [2, "p2v", []],
    ]);
    // Never the plan or the test paper, even though both were shared.
    expect(k.members).not.toContain("plan");
    expect(k.members).not.toContain("exam");
  });

  it("an unshared piece never appears, even when her session can read it", () => {
    const kits = learnerKits([p1v, p1w], [share("p1v")]);
    expect(kits[0].units[0].docs).toEqual([]);
    expect(learnerKits([p1v, p1w], [])).toEqual([]);
  });

  it("withdrawn / unfinished pieces are left out", () => {
    const kits = learnerKits([{ ...p1v, withdrawn_at: "2026-10-22T00:00:00Z" }, { ...p1w, status: "processing" }], [share("p1v"), share("p1w")]);
    expect(kits).toEqual([]);
  });

  it("orders OVERDUE first, then the soonest due, then the undated kits by their newest share (phase 2)", () => {
    const now = Date.parse("2026-11-05T00:00:00Z");
    const v = (id: string, title: string) => gen({ id, kind: "presentation", title: `${title} · ${title}`, artifacts: [A("video_mp4")] });
    const kits = learnerKits(
      [p1v, cv, v("x", "Atoms"), v("y", "Forces"), v("z", "Light"), v("w", "Sound")],
      [
        share("p1v", "2026-11-01T09:00:00Z"), // overdue by 4 days
        share("cv", "2026-11-10T09:00:00Z"), // due later
        share("x", null, "2026-10-30T00:00:00Z"), // undated, older share
        share("y", "2026-11-04T09:00:00Z"), // overdue by 1 day
        share("z", "2026-11-06T09:00:00Z"), // due soonest
        share("w", null, "2026-10-31T00:00:00Z"), // undated, newer share
      ],
      now,
    );
    expect(kits.map((k) => k.id)).toEqual(["p1v", "y", "z", "cv", "w", "x"]);
    expect(kits[0].due).toBe("2026-11-01T09:00:00Z");
  });

  it("with nothing overdue the soonest due date leads", () => {
    const kits = learnerKits([p1v, cv], [share("p1v", "2026-11-01T09:00:00Z"), share("cv", "2026-11-10T09:00:00Z")], Date.parse("2026-10-01T00:00:00Z"));
    expect(kits.map((k) => k.id)).toEqual(["p1v", "cv"]);
  });

  it("learnerWorksheetIn: only a projected worksheet of HER kit", () => {
    const kits = learnerKits([p1v, p1w, plan, exam], [share("p1v"), share("p1w"), share("plan"), share("exam")]);
    expect(learnerWorksheetIn(kits[0], "p1w")).toBe(true);
    expect(learnerWorksheetIn(kits[0], "p1v")).toBe(false);
    expect(learnerWorksheetIn(kits[0], "exam")).toBe(false);
    expect(learnerWorksheetIn(kits[0], "plan")).toBe(false);
    expect(learnerWorksheetIn(kits[0], "elsewhere")).toBe(false);
  });

  it("a piece shared twice keeps its EARLIEST due date", () => {
    const kits = learnerKits([p1v], [share("p1v", "2026-11-05T00:00:00Z"), share("p1v", "2026-11-02T00:00:00Z")]);
    expect(kits[0].due).toBe("2026-11-02T00:00:00Z");
  });

  it("learnerKitFor resolves the kit by its id or by any assigned piece", () => {
    const kits = learnerKits([cv, cd, cw], [share("cv"), share("cd"), share("cw")]);
    expect(learnerKitFor(kits, "cv")?.id).toBe("cv");
    expect(learnerKitFor(kits, "cw")?.id).toBe("cv");
    expect(learnerKitFor(kits, "nope")).toBeNull();
  });

  it("learnerUnits keeps the deck and the projectable worksheets only", () => {
    const units = learnerUnits([cv, cd, cw, cq, cp]);
    expect(units).toHaveLength(1);
    expect(units[0].video?.id).toBe("cv");
    expect(units[0].docs.map((d) => [d.kind, d.projects, d.note ?? null])).toEqual([
      ["worksheet", true, null],
      ["deck", false, "deck"],
    ]);
  });

  it("never lists a teacher-only or assessment kind", () => {
    for (const k of ["lesson_plan", "question_bank", "answer_key", "exam_paper", "exam"]) expect(LEARNER_EXCLUDED_KINDS.has(k)).toBe(true);
  });
});

describe("learnerAllowed — the student Board's gate", () => {
  it("a student with SK on; nobody else through this door", () => {
    expect(learnerAllowed({ role: "student", skOn: true })).toBe(true);
    expect(learnerAllowed({ role: "student", skOn: false })).toBe(false);
    expect(learnerAllowed({ role: "parent", skOn: true })).toBe(false);
    expect(learnerAllowed({ role: "teacher", skOn: true })).toBe(false);
    expect(learnerAllowed({ role: null, skOn: true })).toBe(false);
  });
});

describe("BOOK KITS ARE ASSIGNED LIKE UPLOADS (plan decision: an adopted chapter is the teacher's own kit)", () => {
  // The adopted copy's pieces as the Kits gallery lists them (topic_kits row).
  const row = {
    id: "tk1",
    presentation_generation_id: "cv",
    doc_generation_ids: { deck: "cd", worksheet: "cw", question_bank: "cq", lesson_plan: "cp" },
  };

  it("every assign path hands a student the same pieces of an adopted kit as of an uploaded one", () => {
    // Kits gallery (catalogue / SketchCast book chapter).
    const gallery = assignablePieces(piecesOf(row as never)).map((p) => p.kind).sort();
    expect(gallery).toEqual(["deck", "presentation", "worksheet"]);
    // Library, book-less group (an adopted copy after it lands in her library).
    const lesson = (g: LearnerGen) => ({ id: g.id, title: g.title ?? "", status: "done", progress: 100, kind: g.kind, params: g.params, chapterRef: null, videos: [], decks: [], doc: null, answerKey: null });
    expect(booklessAssignableIds([cv, cd, cw, cq, cp].map(lesson)).sort()).toEqual(["cd", "cv", "cw"]);
    // Library, uploaded chapter (lesson card): done pieces by id — the same rows.
    expect(libraryAssignableIds([{ id: "p1v", status: "done" }, { id: "p1w", status: "done" }, null, { id: "q", status: "queued" }])).toEqual(["p1v", "p1w"]);
    // SK's assign: the same exclusions (a generation id of HER own, any book or none).
    expect([...NOT_ASSIGNABLE_KINDS].sort()).toEqual(["lesson_plan", "question_bank"]);
  });

  it("shared to a class, an adopted kit reaches My lessons' link and the student Board whole", () => {
    const shares = ["cv", "cd", "cw"].map((id) => share(id, "2026-11-03T09:00:00Z"));
    const kits = learnerKits([cv, cd, cw, cq, cp], shares);
    expect(kits).toHaveLength(1);
    expect(kits[0].title).toBe("Plant and Animal Cells");
    expect(kits[0].units[0].video?.id).toBe("cv");
    expect(kits[0].units[0].docs.map((d) => d.kind).sort()).toEqual(["deck", "worksheet"]);
    // My lessons links the kit (its video), and the Board deep link resolves it.
    const links = learnLinks([cv, cd, cw]);
    expect(links).toEqual([{ href: learnHref("cv"), label: null }]);
    const lists = { classes: [], books: [], kits: [{ id: "cv" }], learnerKits: kits };
    expect(parsePresentDeepLink("?learn=cw&autostart=1", lists)).toEqual({ autostart: true, kitId: "cv" });
  });

  it("an uploaded chapter's pieces group the same way (book + chapter)", () => {
    expect(learnerKitKey(p1v)).toBe(learnerKitKey(p2v));
    expect(learnerKitKey(cv)).toBe(learnerKitKey(cw));
    expect(learnerKitKey(cv)).not.toBe(learnerKitKey(p1v));
  });
});

describe("learnLinks — My lessons' Learn with SK", () => {
  it("one link per kit; labels only when a group holds several kits", () => {
    const atoms = gen({ id: "av", kind: "presentation", title: "Atoms · Atoms", artifacts: [A("video_mp4")] });
    const links = learnLinks([cv, cw, atoms]);
    expect(links).toEqual([
      { href: learnHref("cv"), label: "Plant and Animal Cells" },
      { href: learnHref("av"), label: "Atoms" },
    ]);
    expect(learnHref("cv")).toBe("/present?learn=cv&autostart=1");
  });

  it("a plan or a test paper alone makes no link", () => {
    expect(learnLinks([plan, exam])).toEqual([]);
  });
});

describe("deep link ?learn=", () => {
  const lists = { classes: [], books: [], kits: [{ id: "k1" }], learnerKits: [{ id: "k1", members: ["k1", "w1"] }] };
  it("opens the kit holding the piece, startable", () => {
    const d = parsePresentDeepLink("learn=w1&autostart=1", lists);
    expect(d.kitId).toBe("k1");
    expect(deepLinkStartable(d)).toBe(true);
  });
  it("ignores a piece that is not hers", () => {
    expect(parsePresentDeepLink("learn=zz", lists).kitId).toBeUndefined();
    expect(parsePresentDeepLink("learn=w1", { classes: [], books: [] }).kitId).toBeUndefined();
  });
});

describe("the coach — video, then slides, then worksheet", () => {
  const L: CoachLines = {
    startVideo: "sv",
    startSlides: "ss",
    startWorksheet: "sw",
    toSlides: "ts",
    toWorksheet: "tw",
    slidesOpen: "so",
    slidesMissing: "sm",
    worksheetOpen: "wo",
    worksheetFailed: "wf",
    done: "dn",
    empty: "em",
  };
  it("starts at the first step the kit has and skips the missing ones", () => {
    const all = { video: true, slides: true, worksheet: true };
    expect(firstStep(all)).toBe("video");
    expect(nextStep("video", all)).toBe("slides");
    expect(nextStep("slides", all)).toBe("worksheet");
    expect(nextStep("worksheet", all)).toBe("done");
    expect(firstStep({ video: false, slides: true, worksheet: true })).toBe("slides");
    expect(nextStep("video", { video: true, slides: false, worksheet: true })).toBe("worksheet");
    expect(firstStep({ video: false, slides: false, worksheet: false })).toBe("done");
  });
  it("says the right line", () => {
    expect(openingLine("video", L)).toBe("sv");
    expect(openingLine("slides", L)).toBe("ss");
    expect(openingLine("worksheet", L)).toBe("sw");
    expect(openingLine("done", L)).toBe("em");
    expect(nextLine("slides", L)).toBe("ts");
    expect(nextLine("worksheet", L)).toBe("tw");
    expect(nextLine("done", L)).toBe("dn");
  });
});

describe("learnerQuestionCards — the worksheet without its answers", () => {
  // The shape /api/quiz/{id} serves a student (stripQuiz): no answers at all.
  const stripped = {
    title: "Cells",
    questions: [
      { id: "q1", type: "mcq", prompt: "Which organelle?", marks: 1, options: ["Nucleus", "Wall"] },
      { id: "q2", type: "match", prompt: "Match them", marks: 2, left: ["Cell wall", "Nucleus"], options: ["Control", "Support"] },
      { id: "q3", type: "true_false", prompt: "Plants have walls.", marks: 1 },
      { id: "q4", type: "fill_blank", prompt: "  " },
    ],
  };
  it("one card per usable question, and NO answer map", () => {
    const { cards, answers } = learnerQuestionCards(stripped, "g1");
    expect(answers.size).toBe(0);
    expect(cards.map((c) => [c.questionId, c.index, c.total])).toEqual([
      ["q1", 0, 3],
      ["q2", 1, 3],
      ["q3", 2, 3],
    ]);
    expect(cards[0].options).toEqual(["Nucleus", "Wall"]);
    expect(cards[1].body).toEqual(["1. Cell wall", "2. Nucleus"]);
    expect(cards[1].options).toEqual(["Control", "Support"]);
  });
  it("even a raw questions.json handed to it yields no answers (the teacher path would)", () => {
    const raw = { questions: [{ id: "q1", type: "true_false", prompt: "x", answer: true }] };
    expect(learnerQuestionCards(raw, "g1").answers.size).toBe(0);
    expect(questionCards(raw, "g1", { answerTrue: "T", answerFalse: "F" }).answers.size).toBe(1);
  });
});
