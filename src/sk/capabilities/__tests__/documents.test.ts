/**
 * kit.documents (2026-10-31): SK lists and reads ANY document of a kit — the
 * deck's slides with notes, the script, the worksheet, the quiz, the answer key
 * — across the kit's SIBLING pieces (an adopted catalogue kit is split per
 * piece), on the Board, from the bar, and for SketchCast-book chapters she has
 * not opened (the catalogue SOURCE, after her grant). Students never get an
 * answer key. Plus board.explain / board.load_deck using the deck's text when
 * the lesson map is not ready.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/documents.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdmin } from "@/sk/manifest/__tests__/fake-admin";
import { A_GEN, A_WS, ANNE, B_GEN, CAT, SRC, SRC_DECK, SRC_WS, TK, world } from "@/sk/manifest/__tests__/adopted-world";
import { buildContext } from "@/sk/shell/context";
import { ALL_FLAGS, NOW } from "@/sk/shell/__tests__/fixtures";
import { allowedFor } from "@/sk/shell/registry";
import type { SkBoardState, SkContext, SkSelection } from "@/sk/shell/types";
import { __setDocsAdminForTests, docName, kitDocuments } from "../documents";
import { BOARD_CAPABILITIES, BOARD_NO_MAP, resolveDeckSlide } from "../board";
import { docsOf, questionsOf, type DocsAdmin } from "@/sk/kit-docs";

const A_DECK = "a1000000-0000-4000-8000-000000000003";
const A_QUIZ = "a1000000-0000-4000-8000-000000000004";
const A_PLAN = "a1000000-0000-4000-8000-000000000005";
const SRC_QUIZ = "5a000000-0000-4000-8000-000000000004";
const BOOK = "b00c0000-0000-4000-8000-000000000001";
const PRODUCT = "9e000000-0000-4000-8000-000000000001";

const PAGES = JSON.stringify({
  v: 1,
  renderer: "test",
  slides: [
    { n: 1, title: "Why do cells differ?", text: "Look at a leaf and a cheek cell.", notes: "Ask the class first.", words: [] },
    { n: 2, title: "The cell wall", text: "Plant cells have a rigid cellulose wall.", notes: "Point at the wall on the diagram.", words: [] },
    { n: 3, title: "A big vacuole", text: "The vacuole stores cell sap.", notes: "Contrast with animal cells.", words: [] },
  ],
});
const QUIZ = JSON.stringify({
  questions: [
    { id: "q1", type: "mcq", prompt: "Which part is rigid?", options: ["Membrane", "Wall"], answer: "Wall" },
    { id: "q2", type: "matching", prompt: "Match the parts", pairs: [{ left: "Vacuole", right: "sap" }, { left: "Wall", right: "support" }] },
  ],
});

const ref = (source: string) => ({ catalogue_ref: { topic_id: "t", topic_kit_id: TK, source_generation_id: source, article_id: null } });
const g = (id: string, owner: string, kind: string, params: Record<string, unknown>, title: string) => ({ id, owner_id: owner, book_id: null, chapter_ref: null, kind, title, status: "done", withdrawn_at: null, params, created_at: "2026-10-30T17:59:15+00:00" });
const art = (gid: string, src: string, kind: string, file: string) => ({ id: `${gid.slice(0, 4)}-${kind}-${file}`, generation_id: gid, kind, storage_path: `${CAT}/${src}/${file}`, created_at: "2026-10-30T17:59:15+00:00" });

/** Anne's adopted kit, every piece split out like production's six pieces; the
 *  catalogue source; a SketchCast book whose chapter 2 maps the kit. */
function docsWorld(opts: { pages?: boolean } = {}) {
  const a = world();
  const T = (id: string, kind: string) => `Cells Compared · ${kind}`;
  a.tables.generations = a.tables.generations.map((r) => ({ ...r, title: T(String(r.id), String(r.kind)) }));
  a.tables.generations.push(
    g(A_DECK, ANNE, "deck", ref(SRC_DECK), T(A_DECK, "Slides")),
    g(A_QUIZ, ANNE, "quiz", ref(SRC_QUIZ), T(A_QUIZ, "Quiz")),
    g(A_PLAN, ANNE, "lesson_plan", ref("5a000000-0000-4000-8000-000000000005"), T(A_PLAN, "Lesson plan")),
    g(SRC_QUIZ, CAT, "quiz", {}, T(SRC_QUIZ, "Quiz")),
  );
  a.tables.artifacts.push(
    art(A_DECK, SRC_DECK, "deck_pptx", "deck.pptx"),
    art(A_DECK, SRC_DECK, "slide_png", "deck_pages/slide_01.png"),
    ...(opts.pages === false ? [] : [art(A_DECK, SRC_DECK, "deck_pages_json", "deck_pages/pages.json")]),
    art(A_QUIZ, SRC_QUIZ, "questions_json", "quiz_questions.json"),
    art(A_QUIZ, SRC_QUIZ, "answer_key_docx", "quiz_answer_key.docx"),
    art(A_PLAN, "5a000000-0000-4000-8000-000000000005", "docx", "lesson_plan.docx"),
    art(SRC_DECK, SRC_DECK, "deck_pptx", "deck.pptx"),
    art(SRC_DECK, SRC_DECK, "deck_pages_json", "deck_pages/pages.json"),
    art(SRC_QUIZ, SRC_QUIZ, "questions_json", "quiz_questions.json"),
  );
  a.tables.generations = a.tables.generations.map((r) => (r.id === SRC_DECK ? { ...r, title: "Cells Compared · Slides" } : r));
  a.tables.topic_kits = [{ id: TK, presentation_generation_id: SRC, doc_generation_ids: { worksheet: SRC_WS, deck: SRC_DECK, quiz: SRC_QUIZ, activity: "" }, status: "approved", article_id: null }];
  a.tables.books = [{ id: BOOK, title: "Biology", sk_product_id: PRODUCT, removed_at: null }];
  a.tables.sk_product_kits = [{ product_id: PRODUCT, chapter_ref: "2", sort: 0, generation_id: SRC, label: "Plant and animal cells" }];
  a.files[`${CAT}/${SRC_DECK}/deck_pages/pages.json`] = PAGES;
  a.files[`${CAT}/${SRC_QUIZ}/quiz_questions.json`] = QUIZ;
  return a;
}

function session(a: FakeAdmin, grant: boolean) {
  return { from: (t: string) => a.from(t), rpc: async (fn: string) => (fn === "has_book_grant" ? { data: grant, error: null } : { data: null, error: { message: `unexpected ${fn}` } }) };
}

function ctx(o: { board?: SkBoardState; selection?: SkSelection; role?: "teacher" | "student"; user?: string } = {}): SkContext {
  return buildContext({
    user: { id: o.user ?? ANNE, email: "anne@school.example" },
    role: o.role ?? "teacher",
    schoolId: null,
    hat: o.role === "student" ? null : "teacher",
    coordinatorScope: [],
    plan: "school",
    staff: false,
    flags: ALL_FLAGS,
    collector: { path: "/present", board: o.board, selection: o.selection, locale: "en" },
    now: NOW,
  });
}
const onBoard = (extra: Partial<SkBoardState> = {}): SkBoardState => ({ sessionId: "sess-1", generationId: A_GEN, ...extra });

let db: FakeAdmin;
let grant = true;
const deps = () => ({ session: session(db, grant), now: NOW });
const run = (args: Record<string, unknown>, c: SkContext = ctx({ board: onBoard() })) => kitDocuments.handler(c, args, deps());

beforeEach(() => {
  db = docsWorld();
  grant = true;
  __setDocsAdminForTests(() => db as unknown as DocsAdmin);
});
afterEach(() => __setDocsAdminForTests(null));

describe("kit.documents — the open kit's sibling pieces", () => {
  it("lists every document across the split pieces (deck, script, worksheet, quiz, answer keys, a Word-only plan)", async () => {
    const r = await run({ action: "list" });
    expect(r.ok).toBe(true);
    const docs = (r.facts ?? []).map((f) => `${f.doc}${f.of ? `:${f.of}` : ""}${f.readable ? "" : "(docx)"}${f.teacher_only ? "!" : ""}`);
    expect(docs).toEqual(expect.arrayContaining(["script", "deck", "worksheet", "answer_key:worksheet!", "quiz", "answer_key:quiz!", "lesson_plan(docx)!"]));
    expect(r.summary).toMatch(/Documents of "Cells Compared"/);
  });

  it("reads the deck from the DECK piece's text map — slide text and speaker notes — though the Board's unit is the video", async () => {
    const r = await run({ action: "read", doc: "the slides" });
    expect(r.ok).toBe(true);
    expect(r.facts).toEqual([
      { slide: 1, title: "Why do cells differ?", text: "Look at a leaf and a cheek cell.", notes: "Ask the class first." },
      { slide: 2, title: "The cell wall", text: "Plant cells have a rigid cellulose wall.", notes: "Point at the wall on the diagram." },
      { slide: 3, title: "A big vacuole", text: "The vacuole stores cell sap.", notes: "Contrast with animal cells." },
    ]);
    const one = await run({ doc: "deck", slide: 2 });
    expect(one.facts).toEqual([{ slide: 2, title: "The cell wall", text: "Plant cells have a rigid cellulose wall.", notes: "Point at the wall on the diagram." }]);
  });

  it("a deck not rendered yet reads from the lesson script (one slide per script segment)", async () => {
    db = docsWorld({ pages: false });
    delete db.files[`${CAT}/${SRC_DECK}/deck_pages/pages.json`];
    const r = await run({ doc: "deck" });
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/from the lesson script/);
    expect(r.facts?.map((f) => f.heading)).toEqual(["Hook", "Cell wall", "Big vacuole"]);
  });

  it("the worksheet and the quiz read WITHOUT answers; the answer key (teacher) WITH them", async () => {
    const ws = await run({ doc: "worksheet" });
    expect(ws.facts).toEqual([
      { q: 1, type: "short", prompt: "What is rigid?" },
      { q: 2, type: "short", prompt: "What stores sap?" },
    ]);
    const quiz = await run({ doc: "quiz" });
    expect(quiz.facts?.[0]).toEqual({ q: 1, type: "mcq", prompt: "Which part is rigid?", options: "Membrane | Wall" });
    // a matching item lists both columns, the right one sorted — never the pairing
    expect(quiz.facts?.[1]).toEqual({ q: 2, type: "matching", prompt: "Match the parts", options: "Vacuole | Wall | sap | support" });
    expect(JSON.stringify(quiz.facts)).not.toMatch(/"answer"/);
    const key = await run({ doc: "answer key", of: "quiz" });
    expect(key.facts?.map((f) => f.answer)).toEqual(["Wall", "Vacuole → sap; Wall → support"]);
    expect(key.summary).toMatch(/for the teacher/);
  });

  it("a Word-only document says so (no .docx is parsed)", async () => {
    const r = await run({ doc: "lesson plan" });
    expect(r).toMatchObject({ ok: false, error: "docx_only" });
    expect(r.summary).toMatch(/Word file only/);
  });

  it("the bar's ready-made kit works off the Board too", async () => {
    const r = await run({ doc: "worksheet" }, ctx({ selection: { generationId: A_GEN } }));
    expect(r.ok).toBe(true);
    expect(r.facts).toHaveLength(2);
  });

  it("another teacher's kit is refused (owner filter)", async () => {
    expect(await run({ doc: "deck", kit: B_GEN })).toMatchObject({ ok: false, error: "not_owner" });
    const r = await run({ doc: "deck" }, ctx({ board: { sessionId: "s", generationId: B_GEN } }));
    expect(r).toMatchObject({ ok: false, error: "ask_kit" });
  });

  it("nothing open and nothing named → asks which kit", async () => {
    expect(await run({ doc: "deck" }, ctx())).toMatchObject({ ok: false, error: "ask_kit" });
  });
});

describe("kit.documents — a SketchCast book chapter she has not opened", () => {
  it("a grant holder reads the catalogue SOURCE pieces of the chapter", async () => {
    const r = await run({ doc: "quiz", book: "Biology", chapter: 2 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/Biology chapter 2/);
    expect(r.facts?.[0]).toMatchObject({ prompt: "Which part is rigid?" });
    const list = await run({ action: "list", book: "biology", chapter: 2 }, ctx());
    expect(list.facts?.every((f) => f.kit === "Plant and animal cells")).toBe(true);
    const deck = await run({ doc: "deck", book: "Biology", chapter: 2 }, ctx());
    expect(deck.facts?.[1]).toMatchObject({ slide: 2, title: "The cell wall" });
  });

  it("no grant → refused, and nothing of the kit is read", async () => {
    grant = false;
    db.log.length = 0;
    const r = await run({ doc: "quiz", book: "Biology", chapter: 2 }, ctx());
    expect(r).toMatchObject({ ok: false, error: "no_grant" });
    expect(db.log.some((l) => l.startsWith("sk_product_kits.") || l.startsWith("topic_kits.") || l.startsWith("storage."))).toBe(false);
  });

  it("a chapter with no kit says so", async () => {
    expect(await run({ doc: "quiz", book: "Biology", chapter: 5 }, ctx())).toMatchObject({ ok: false, error: "no_kit" });
  });

  it("the chapter from the bar (0-based num) when no book or chapter is said", async () => {
    const r = await run({ doc: "worksheet" }, ctx({ selection: { bookId: BOOK, chapterRef: "1" } }));
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/Biology chapter 2/);
  });
});

describe("students never get answer keys", () => {
  it("the tool is not given to a student at all", () => {
    const names = (c: SkContext) => allowedFor(c).map((x) => x.meta.name);
    expect(names(ctx())).toContain("kit.documents");
    expect(names(ctx({ role: "student" }))).not.toContain("kit.documents");
  });

  it("and the handler refuses a student the answer key, the lesson plan and the question bank", async () => {
    const student = ctx({ role: "student", selection: { generationId: A_GEN } });
    for (const doc of ["answer_key", "answer key", "lesson_plan", "question_bank"]) expect(await run({ doc }, student)).toMatchObject({ ok: false, error: "teacher_only" });
    const list = await run({ action: "list" }, student);
    expect((list.facts ?? []).some((f) => f.teacher_only || f.doc === "answer_key")).toBe(false);
  });

  it("docsOf / questionsOf: no teacher-only entry for a student; answers only when asked for", async () => {
    const pieces = [
      { id: "w", kind: "worksheet", title: null, owner_id: "o", params: {}, created_at: "", artifacts: [{ kind: "questions_json", storage_path: `${CAT}/${SRC_QUIZ}/quiz_questions.json` }] },
      { id: "p", kind: "lesson_plan", title: null, owner_id: "o", params: {}, created_at: "", artifacts: [{ kind: "docx", storage_path: "x.docx" }] },
    ];
    expect(docsOf(pieces, { student: true }).map((e) => e.doc)).toEqual(["worksheet"]);
    const qs = await questionsOf(db as unknown as DocsAdmin, pieces[0], false);
    expect(qs?.every((q) => q.answer === undefined)).toBe(true);
  });
});

describe("docName", () => {
  it.each([
    ["the deck", "deck"],
    ["PowerPoint", "deck"],
    ["slides", "deck"],
    ["answer key", "answer_key"],
    ["Worksheet", "worksheet"],
    ["lesson plan", "lesson_plan"],
    ["quiz", "quiz"],
    ["the script", "script"],
    ["banana", null],
  ])("%s → %s", (said, name) => expect(docName(said)).toBe(name));
});

describe("the Board before its lesson map is ready", () => {
  const cap = (n: string) => BOARD_CAPABILITIES.find((c) => c.meta.name === n)!;

  it("board.explain answers from the deck piece's text (no move: the video needs the map)", async () => {
    const r = await cap("board.explain").handler(ctx({ board: onBoard() }), { concept: "vacuole" }, deps());
    expect(r.ok).toBe(true);
    expect(r.board).toBeUndefined();
    expect(r.facts).toEqual([{ concept: "vacuole", slide: 3, title: "A big vacuole", text: "The vacuole stores cell sap.", notes: "Contrast with animal cells.", source: "deck" }]);
    expect(r.summary).toMatch(/^From the deck, slide 3: A big vacuole\./);
    expect(await cap("board.explain").handler(ctx({ board: onBoard() }), { concept: "photosynthesis" }, deps())).toMatchObject({ ok: false, error: "no_match" });
  });

  it("no deck text either → the map refusal, as before", async () => {
    __setDocsAdminForTests(() => null);
    expect(await cap("board.explain").handler(ctx({ board: onBoard() }), { concept: "vacuole" }, deps())).toMatchObject({ ok: false, summary: BOARD_NO_MAP });
  });

  it("board.explain works on the adopted kit once its map is ready (resolved from the map, a slide move)", async () => {
    const board = onBoard({ manifestId: "m-1", segments: [{ k: 0, id: "s001", heading: "Hook" }, { k: 1, id: "s002", heading: "Cell wall" }, { k: 2, id: "s003", heading: "Big vacuole" }] });
    const r = await cap("board.explain").handler(ctx({ board }), { concept: "the vacuole" }, deps());
    expect(r.board).toMatchObject({ move: "slide", args: { k: 2, heading: "Big vacuole" } });
  });

  it("board.load_deck carries the deck's slide text and notes with the move", async () => {
    const r = await cap("board.load_deck").handler(ctx({ board: onBoard({ deck: "missing" }) }), {}, deps());
    expect(r.board?.move).toBe("load_deck");
    expect(r.facts?.[0]).toEqual({ deck: "missing" });
    expect(r.facts?.slice(1).map((f) => f.title)).toEqual(["Why do cells differ?", "The cell wall", "A big vacuole"]);
    expect(r.summary).toMatch(/3 slides' text and speaker notes/);
  });

  it("resolveDeckSlide prefers a title match", () => {
    const slides = [
      { n: 1, title: "Intro", text: "the wall and the vacuole", notes: "" },
      { n: 2, title: "The cell wall", text: "rigid", notes: "" },
    ];
    expect(resolveDeckSlide("cell wall", slides)?.n).toBe(2);
    expect(resolveDeckSlide("mitochondria", slides)).toBeNull();
  });
});

// keep the imported ids referenced (A_WS documents the sibling worksheet copy)
void A_WS;
