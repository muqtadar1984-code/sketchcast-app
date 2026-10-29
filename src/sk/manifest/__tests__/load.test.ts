import { describe, expect, it } from "vitest";
import { FakeAdmin, type Row } from "./fake-admin";
import { ManifestLoadError, answerText, conceptsFromGrounding, loadKitInput, normStem, scriptPartFromPath } from "../load";
import { MANIFEST_DERIVATION_VERSION, assemble } from "../derive";

const OWNER = "9d41e12e-e9c9-4b82-b3a9-3421c2c57726";
const GEN = "eef426bd-523b-4fed-827c-95421263d89a";
const WS_OLD = "a416ce84-5c87-46fa-8874-22a8cbfdd1d2";
const WS_NEW = "180d55c7-12f2-433e-bd9b-f442f5584431";
const BOOK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ARTICLE = "16dc6420-b076-485e-ba6b-56a5df0b7e3c";

const script = (part: number, of: number, ids: string[]) =>
  JSON.stringify({
    part,
    of,
    language: "en",
    script: { script_id: `S${part}`, segments: ids.map((id, i) => ({ segment_id: id, type: i === 0 ? "hook" : "explore", text: `narration ${id}`, slide_heading: `Heading ${id}`, slide_points: ["a"], scene: { concept: null, elements: [] } })) },
    video: { manifest_id: `V${part}`, segments: [...ids.map((id) => ({ segment_id: id, clip_duration_seconds: 10 })), { segment_id: "s990", clip_duration_seconds: 2 }] },
  });

const art = (gid: string, kind: string, file: string, created = "2026-10-25T09:40:30+00:00"): Row => ({ id: `${gid.slice(0, 8)}-${kind}-${file}`, generation_id: gid, kind, storage_path: `${OWNER}/${gid}/${file}`, created_at: created });

function bookKit(over: Partial<Row> = {}) {
  const tables: Record<string, Row[]> = {
    generations: [
      { id: GEN, owner_id: OWNER, book_id: BOOK, chapter_ref: "4", kind: "presentation", status: "done", withdrawn_at: null, params: { video_parts: 2, format_version: 3, language: "en" }, created_at: "2026-10-25T09:00:00+00:00", ...over },
      { id: WS_OLD, owner_id: OWNER, book_id: BOOK, chapter_ref: "4", kind: "worksheet", status: "done", withdrawn_at: null, params: {}, created_at: "2026-10-25T09:35:00+00:00" },
      { id: WS_NEW, owner_id: OWNER, book_id: BOOK, chapter_ref: "4", kind: "worksheet", status: "done", withdrawn_at: null, params: {}, created_at: "2026-10-25T09:58:00+00:00" },
      // noise: another chapter, another owner, not done
      { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", owner_id: OWNER, book_id: BOOK, chapter_ref: "5", kind: "worksheet", status: "done", withdrawn_at: null, params: {}, created_at: "2026-10-26T09:58:00+00:00" },
      { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", owner_id: "other", book_id: BOOK, chapter_ref: "4", kind: "worksheet", status: "done", withdrawn_at: null, params: {}, created_at: "2026-10-27T09:58:00+00:00" },
      { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", owner_id: OWNER, book_id: BOOK, chapter_ref: "4", kind: "worksheet", status: "processing", withdrawn_at: null, params: {}, created_at: "2026-10-28T09:58:00+00:00" },
    ],
    artifacts: [
      // part 2 listed BEFORE part 1 on purpose
      art(GEN, "script_json", "script_part2.json"),
      art(GEN, "video_mp4", "lesson_part2.mp4"),
      art(GEN, "script_json", "script.json"),
      art(GEN, "video_mp4", "lesson.mp4"),
      art(GEN, "thumbnail_png", "thumb.png"),
      art(WS_OLD, "questions_json", "worksheet_questions.json"),
      art(WS_OLD, "docx", "worksheet.docx"),
      art(WS_NEW, "questions_json", "worksheet_questions.json"),
      art(WS_NEW, "docx", "worksheet.docx"),
    ],
    chapter_grounding: [
      { book_id: BOOK, chapter_num: 4, concepts: { analysis_id: "x", concepts: { concepts: [{ concept_id: "c001", name: "Cell wall", definition: "rigid layer" }, { concept_id: "c002", name: "Vacuole", definition: "sap store" }], dependencies: [] } } },
      { book_id: BOOK, chapter_num: 5, concepts: { concepts: { concepts: [{ concept_id: "zzz", name: "Wrong chapter", definition: "" }] } } },
    ],
    topic_articles: [],
  };
  const files: Record<string, string> = {
    [`${OWNER}/${GEN}/script.json`]: script(1, 2, ["s001", "s002"]),
    [`${OWNER}/${GEN}/script_part2.json`]: script(2, 2, ["s001"]),
    [`${OWNER}/${WS_OLD}/worksheet_questions.json`]: JSON.stringify({ questions: [{ id: "q1", type: "fill_blank", prompt: "old", answer: "x" }] }),
    [`${OWNER}/${WS_NEW}/worksheet_questions.json`]: JSON.stringify({
      questions: [
        { id: "q1", type: "fill_blank", prompt: "The wall is ____.", answer: "rigid", marks: 1 },
        { id: "q2", type: "matching", prompt: "Match", pairs: [{ left: "Vacuole", right: "sap" }] },
      ],
    }),
  };
  return new FakeAdmin(tables, files);
}

describe("loadKitInput — book kit", () => {
  it("loads scripts sorted by part, the newest worksheet's items, grounding concepts and pins both generations' rows", async () => {
    const admin = bookKit();
    const kit = await loadKitInput(admin, GEN);
    const { input } = kit;
    expect(input.scripts.map((s) => s.part)).toEqual([1, 2]);
    expect(input.scripts[0].script.script_id).toBe("S1");
    expect(input.has_video).toEqual({ 1: true, 2: true });
    expect(input.format_version).toBe(3);
    expect(input.language).toBe("en");
    expect(input.book_id).toBe(BOOK);
    expect(input.chapter_ref).toBe("4");
    expect(input.concept_source).toBe("chapter_grounding");
    expect(input.concepts?.map((c) => c.concept_id)).toEqual(["c001", "c002"]);
    // only the NEWEST done worksheet of this owner on this chapter
    expect(kit.worksheetGenerationId).toBe(WS_NEW);
    expect(input.items.map((i) => i.q_id)).toEqual([`ws:${WS_NEW.slice(0, 8)}:q1`, `ws:${WS_NEW.slice(0, 8)}:q2`]);
    expect(input.items[1].answer).toBe("Vacuole → sap");
    expect(input.items[0].generation_id).toBe(WS_NEW);
    // pinned rows: the presentation's AND the worksheet's, nobody else's
    const gens = new Set(kit.artifactRows.map((r) => r.generation_id));
    expect(gens).toEqual(new Set([GEN, WS_NEW]));
    expect(kit.artifactRows).toBe(input.artifacts);
    // the old worksheet's file was never downloaded
    expect(admin.log.filter((l) => l.startsWith("storage.download"))).toHaveLength(3);
    const m = assemble(input, { model: null }, "2026-10-28T00:00:00Z");
    expect(m.completeness).toEqual({ video: "ok", script: "ok", questions: "ok", concepts: "ok", format_version: 3 });
    expect(m.segments.map((s) => s.key)).toEqual(["p1:s001", "p1:s002", "p1:s990", "p2:s001", "p2:s990"]);
  });

  it("a presentation without script_json → scripts [] and completeness.script 'missing'", async () => {
    const admin = bookKit();
    admin.tables.artifacts = admin.tables.artifacts.filter((a) => a.kind !== "script_json");
    const { input } = await loadKitInput(admin, GEN);
    expect(input.scripts).toEqual([]);
    expect(input.has_video).toEqual({});
    const m = assemble(input, { model: null }, "2026-10-28T00:00:00Z");
    expect(m.completeness.script).toBe("missing");
    expect(m.completeness.video).toBe("missing");
    expect(m.segments).toEqual([]);
  });

  it("an unreadable script file is skipped, a missing questions file yields no items", async () => {
    const admin = bookKit();
    admin.files[`${OWNER}/${GEN}/script_part2.json`] = "{not json";
    delete admin.files[`${OWNER}/${WS_NEW}/worksheet_questions.json`];
    const { input } = await loadKitInput(admin, GEN);
    expect(input.scripts.map((s) => s.part)).toEqual([1]);
    expect(input.items).toEqual([]);
    expect(assemble(input, { model: null }, "t").completeness.questions).toBe("none");
  });

  it("no grounding row → concepts null, source none", async () => {
    const admin = bookKit();
    admin.tables.chapter_grounding = [];
    const { input } = await loadKitInput(admin, GEN);
    expect(input.concepts).toBeNull();
    expect(input.concept_source).toBe("none");
    expect(assemble(input, { model: null }, "t").completeness.concepts).toBe("none");
  });

  it("refuses: not found, not a presentation, not done, withdrawn", async () => {
    await expect(loadKitInput(bookKit(), "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "not_found" });
    await expect(loadKitInput(bookKit({ kind: "worksheet" }), GEN)).rejects.toMatchObject({ code: "not_presentation" });
    await expect(loadKitInput(bookKit({ status: "processing" }), GEN)).rejects.toMatchObject({ code: "not_done" });
    const w = await loadKitInput(bookKit({ withdrawn_at: "2026-10-27T00:00:00Z" }), GEN).catch((e) => e);
    expect(w).toBeInstanceOf(ManifestLoadError);
    expect((w as ManifestLoadError).code).toBe("withdrawn");
  });
});

describe("loadKitInput — catalogue kit (article, no book)", () => {
  it("finds the worksheet by params.article_id and concepts from topic_articles.objectives", async () => {
    const admin = bookKit({ book_id: null, chapter_ref: null, params: { video_parts: 1, format_version: 3, language: "en", article_id: ARTICLE } });
    admin.tables.artifacts = admin.tables.artifacts.filter((a) => !String(a.storage_path).includes("part2"));
    admin.tables.generations = admin.tables.generations.map((g) => (g.kind === "worksheet" ? { ...g, book_id: null, chapter_ref: null, params: g.id === WS_OLD ? { article_id: ARTICLE } : { article_id: "other-article" } } : g));
    admin.tables.topic_articles = [{ id: ARTICLE, source_article_id: "6c78b8eb-8a9b-4a58-9426-dabc0e415bc0", objectives: [{ id: "o1", text: "State that the cell is the unit of life." }, { id: "o2", text: "Distinguish prokaryotic cells." }] }];
    const kit = await loadKitInput(admin, GEN);
    expect(kit.worksheetGenerationId).toBe(WS_OLD); // the only done worksheet on THIS article
    expect(kit.input.article_id).toBe(ARTICLE);
    expect(kit.input.article_source_id).toBe("6c78b8eb-8a9b-4a58-9426-dabc0e415bc0");
    expect(kit.input.concept_source).toBe("article_objectives");
    expect(kit.input.concepts?.map((c) => c.concept_id)).toEqual(["o1", "o2"]);
    expect(kit.input.book_id).toBeNull();
    expect(kit.input.items.map((i) => i.q_id)).toEqual([`ws:${WS_OLD.slice(0, 8)}:q1`]);
  });

  it("no article and no book → no worksheet, no concepts", async () => {
    const admin = bookKit({ book_id: null, chapter_ref: null, params: { format_version: 3 } });
    const kit = await loadKitInput(admin, GEN);
    expect(kit.worksheetGenerationId).toBeNull();
    expect(kit.input.items).toEqual([]);
    expect(kit.input.concepts).toBeNull();
    expect(new Set(kit.artifactRows.map((r) => r.generation_id))).toEqual(new Set([GEN]));
  });
});

describe("loadKitInput — bank traces (S3 slice A: the objective_ref path runs)", () => {
  const QS = "0c6f23a2-81ed-4f50-865c-3e5c913e2a16";
  const OLD_ARTICLE = "11111111-1111-4111-8111-111111111111"; // the topic's previous article version
  const EN_SOURCE = "22222222-2222-4222-8222-222222222222"; // the English article a translation came from
  const b = (n: number) => `b000000${n}-0000-4000-8000-000000000000`;
  const s = (n: number) => `5000000${n}-0000-4000-8000-000000000000`;

  /** A catalogue kit whose newest worksheet is a composed quiz (params.question_set_id). */
  function quizKit(opts: { kitArticleSource?: string | null; questionIds?: string[]; bank?: Row[]; prompts?: string[] } = {}) {
    const admin = bookKit({ book_id: null, chapter_ref: null, params: { video_parts: 1, format_version: 3, language: "en", article_id: ARTICLE } });
    admin.tables.artifacts = admin.tables.artifacts.filter((a) => !String(a.storage_path).includes("part2"));
    admin.tables.generations = admin.tables.generations.map((g) =>
      g.kind === "worksheet" ? { ...g, book_id: null, chapter_ref: null, params: g.id === WS_NEW ? { article_id: ARTICLE, question_set_id: QS } : { article_id: "other-article" } } : g,
    );
    admin.tables.topic_articles = [{ id: ARTICLE, source_article_id: opts.kitArticleSource ?? null, objectives: [{ id: "o1", text: "Cell wall" }, { id: "o2", text: "Vacuole" }] }];
    admin.tables.question_sets = [{ id: QS, question_ids: opts.questionIds ?? [b(1), b(2), b(3), b(4)] }];
    admin.tables.topic_questions = opts.bank ?? [
      { id: b(1), article_id: ARTICLE, objective_ref: "o1", source_item_id: null, status: "approved", stem: "The wall is ____.", difficulty: 2 },
      { id: b(2), article_id: OLD_ARTICLE, objective_ref: "o2", source_item_id: null, status: "approved", stem: "What stores sap?", difficulty: 1 }, // stale: older article version
      { id: b(3), article_id: ARTICLE, objective_ref: "o9", source_item_id: null, status: "approved", stem: "Name the organelle.", difficulty: 3 }, // stale: objective gone
      { id: b(4), article_id: ARTICLE, objective_ref: "o2", source_item_id: null, status: "approved", stem: "A DIFFERENT stem", difficulty: 3 }, // positional join not confirmed
    ];
    const prompts = opts.prompts ?? ["The wall is ____.", "What stores sap?", "Name the organelle.", "Which part is green?"];
    admin.files[`${OWNER}/${WS_NEW}/worksheet_questions.json`] = JSON.stringify({ questions: prompts.map((p, i) => ({ id: `q${i + 1}`, type: "mcq", prompt: p, answer: "x" })) });
    return admin;
  }
  const map = (m: ReturnType<typeof assemble>) => Object.fromEntries(m.items.map((i) => [i.q_id.split(":").pop(), `${i.method}${i.concept_ids.length ? ":" + i.concept_ids.join(",") : ""}`]));

  it("a fresh tag maps by objective_ref; stale tags (older article version, objective gone) and an unconfirmed position fall back to the model", async () => {
    const admin = quizKit();
    const { input } = await loadKitInput(admin, GEN);
    expect(input.items.map((i) => i.bank_item_id)).toEqual([b(1), b(2), b(3), undefined]);
    expect(input.items[0]).toMatchObject({ bank_article_id: ARTICLE, objective_ref: "o1", difficulty: 2 });
    expect(input.items[1]).toMatchObject({ bank_article_id: OLD_ARTICLE, objective_ref: "o2" });
    expect(input.items[3].bank_article_id).toBeUndefined();
    // one batch read for the bank rows, none for sources (no translations)
    expect(admin.log.filter((l) => l.startsWith("topic_questions.select"))).toHaveLength(1);
    const m = assemble(input, { model: null, items: [] }, "t");
    expect(map(m)).toEqual({ q1: "objective_ref:o1", q2: "model", q3: "model", q4: "model" });
    expect(m.items[0]).toMatchObject({ confidence: 1, availability: "available", bank_item_id: b(1), difficulty: 2 });
    expect(m.derivation_version).toBe(MANIFEST_DERIVATION_VERSION);
  });

  it("a translation follows source_item_id to the source item's article: valid only when that is the kit article's source", async () => {
    const bank = [
      { id: b(1), article_id: ARTICLE, objective_ref: "o1", source_item_id: s(1), status: "approved", stem: "The wall is ____.", difficulty: 2 },
      { id: b(2), article_id: ARTICLE, objective_ref: "o2", source_item_id: s(2), status: "approved", stem: "What stores sap?", difficulty: 1 },
      { id: b(3), article_id: ARTICLE, objective_ref: "o2", source_item_id: s(9), status: "approved", stem: "Name the organelle.", difficulty: 1 }, // source row missing
      { id: s(1), article_id: EN_SOURCE, objective_ref: "o1", source_item_id: null, status: "approved", stem: "en 1", difficulty: 2 },
      { id: s(2), article_id: OLD_ARTICLE, objective_ref: "o2", source_item_id: null, status: "approved", stem: "en 2", difficulty: 1 }, // translated from an older English version
    ];
    const admin = quizKit({ kitArticleSource: EN_SOURCE, bank, questionIds: [b(1), b(2), b(3)], prompts: ["The wall is ____.", "What stores sap?", "Name the organelle."] });
    const { input } = await loadKitInput(admin, GEN);
    expect(input.article_source_id).toBe(EN_SOURCE);
    expect(input.items.map((i) => i.bank_source_article_id)).toEqual([EN_SOURCE, OLD_ARTICLE, null]);
    expect(admin.log.filter((l) => l.startsWith("topic_questions.select"))).toHaveLength(2); // bank rows, then their sources
    expect(map(assemble(input, { model: null, items: [] }, "t"))).toEqual({ q1: "objective_ref:o1", q2: "model", q3: "model" });
  });

  it("an item that declares its own bank_item_id needs no question set and no stem match", async () => {
    const admin = quizKit({ questionIds: [] });
    admin.files[`${OWNER}/${WS_NEW}/worksheet_questions.json`] = JSON.stringify({ questions: [{ id: "q1", type: "mcq", prompt: "reworded", answer: "x", bank_item_id: b(1) }] });
    const { input } = await loadKitInput(admin, GEN);
    expect(input.items[0]).toMatchObject({ bank_item_id: b(1), bank_article_id: ARTICLE, objective_ref: "o1" });
    expect(map(assemble(input, { model: null, items: [] }, "t"))).toEqual({ q1: "objective_ref:o1" });
  });

  it("no question set, or a bank read error, leaves the items untraced (model pass), never a failed load", async () => {
    const none = quizKit();
    none.tables.generations = none.tables.generations.map((g) => (g.id === WS_NEW ? { ...g, params: { article_id: ARTICLE } } : g));
    const a = await loadKitInput(none, GEN);
    expect(a.input.items.every((i) => i.bank_item_id === undefined && i.bank_article_id === undefined)).toBe(true);
    expect(none.log.some((l) => l.startsWith("question_sets.") || l.startsWith("topic_questions."))).toBe(false);

    const broken = quizKit();
    const from = broken.from.bind(broken);
    broken.from = (t: string) => (t === "topic_questions" ? { select: () => ({ in: async () => ({ data: null, error: { message: "boom" } }) }) } : from(t));
    const r = await loadKitInput(broken, GEN);
    expect(r.input.items).toHaveLength(4);
    expect(r.input.items.every((i) => i.bank_article_id === undefined)).toBe(true);
  });
});

describe("helpers", () => {
  it("normStem ignores case, punctuation and spacing", () => {
    expect(normStem("  What  stores SAP? ")).toBe(normStem("what stores sap"));
    expect(normStem("Cell-wall")).toBe("cell wall");
  });
  it("scriptPartFromPath", () => {
    expect(scriptPartFromPath("o/g/script.json")).toBe(1);
    expect(scriptPartFromPath("o/g/script_part3.json")).toBe(3);
    expect(scriptPartFromPath("o/g/lesson.mp4")).toBeNull();
    expect(scriptPartFromPath("o/g/myscript.json")).toBeNull();
  });
  it("conceptsFromGrounding tolerates the three shapes and rejects junk", () => {
    const list = [{ concept_id: "c1", name: "A", definition: "d" }];
    expect(conceptsFromGrounding({ concepts: { concepts: list } })).toEqual(list);
    expect(conceptsFromGrounding({ concepts: list })).toEqual(list);
    expect(conceptsFromGrounding(list)).toEqual(list);
    expect(conceptsFromGrounding({ concepts: { concepts: [] } })).toBeNull();
    expect(conceptsFromGrounding(null)).toBeNull();
    expect(conceptsFromGrounding("x")).toBeNull();
    expect(conceptsFromGrounding([{ name: "no id" }])).toBeNull();
  });
  it("answerText", () => {
    expect(answerText({ answer: "x" })).toBe("x");
    expect(answerText({ answer: false })).toBe("false");
    expect(answerText({ answer: ["a", "b"] })).toBe('["a","b"]');
    expect(answerText({ pairs: [{ a: "1", b: "2" }] })).toBe("1 → 2");
    expect(answerText({})).toBe('""');
  });
});

describe("loadKitInput — concurrent downloads (fix/sk-speed)", () => {
  it("returns exactly what the sequential loader returned (fixtures/loaded-sequential.json, captured before the change)", async () => {
    const { default: sequential } = await import("./fixtures/loaded-sequential.json");
    expect(JSON.parse(JSON.stringify(await loadKitInput(bookKit(), GEN)))).toEqual(sequential);
  });
});
