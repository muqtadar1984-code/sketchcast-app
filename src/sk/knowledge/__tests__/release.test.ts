// SK S7 K1 — the release importer against fixture bundles in the contract's
// shape (`sketchcast.book-release/1`, en + ar, exercises WITH answers) and the
// production pub_releases columns (0172 as applied 2026-10-30, incl.
// withdrawn_by). Covers: hash verification (a good bundle passes, a tampered
// one is refused), no answer ever becomes a block, idempotency, finals beat
// drafts, superseded / withdrawn handling, and the poll with pub_releases
// missing or 0174 not applied.
// Run: node node_modules/vitest/vitest.mjs run src/sk/knowledge/__tests__/release.test.ts
import { describe, expect, it } from "vitest";
import { pythonDumps, sha256Hex } from "../canonical-json";
import { importRelease, pickRelease, pollReleases, releaseBlocks, verifyBundle, type BundleReader, type ReleaseRow } from "../release";
import { fakeDb } from "./fake-db";

const BOOK_APPROVAL = 77;
const ANSWERS = ["ANSWER-SEVEN-42", "SOLUTION-STEP-SUBTRACT-3", "MARK-POINT-SECRET", "OPTION-DISTRACTOR-Q"];

function chapter(n: number, lang: "en" | "ar") {
  const en = lang === "en";
  const sections = [
    {
      sid: "s1",
      title: en ? "Why letters?" : "لماذا الحروف؟",
      blocks: [
        { type: "paragraph", text: en ? "A letter can stand for an unknown number." : "يمكن أن يمثل الحرف عددا مجهولا." },
        { type: "key_term", term: en ? "Variable" : "متغير", text: en ? "a letter that stands for a number" : "حرف يمثل عددا" },
        { type: "key_idea", text: en ? "Do the same to both sides." : "افعل الشيء نفسه للطرفين." },
        { type: "think", text: en ? "What is x?" : "ما قيمة س؟", answer: ANSWERS[0] },
        { type: "figure", ref: "fig:balance", caption: en ? "A balance" : "ميزان" },
      ],
    },
    { sid: "s2", title: en ? "Solving" : "الحل", blocks: [{ type: "paragraph", text: en ? `Chapter ${n}: solve 2x + 3 = 7 step by step.` : "حل المعادلة خطوة بخطوة." }] },
  ];
  const exercises = [
    { xid: "x1", tier: "guided", item_type: "short_answer", stem: en ? "Solve x + 3 = 10." : "حل س + 3 = 10.", options: null, answer: ANSWERS[0], marking_scheme: [{ point: ANSWERS[2], marks: 1 }], worked_solution: ANSWERS[1], source_item_id: null },
    { xid: "x2", tier: "independent", item_type: "mcq", stem: en ? "Which is a variable?" : "أي مما يلي متغير؟", options: ["x", ANSWERS[3]], answer: "x", marking_scheme: null, worked_solution: ANSWERS[1], source_item_id: "item:1" },
  ];
  const content_sha256 = sha256Hex(pythonDumps({ sections, exercises }));
  return {
    chapter: n,
    title: en ? `Chapter ${n} — The Language of Algebra` : `الفصل ${n}`,
    content_sha256,
    // chapter 2 is covered by a BOOK-level approval (as Biology ch 2–10 by r4.1); the rest by Gate D
    approval: n === 2 ? { kind: "book", id: BOOK_APPROVAL, by: "founder@sketchcast.app", on: "2026-10-26" } : { kind: "gate_d", id: 400 + n, by: "editor@sketchcast.app", on: "2026-10-30" },
    objectives: [{ code: "7Ae.01", text: "Use letters" }],
    sections,
    exercises,
    videos: [],
    topics: [{ topic_id: "t1", slug: "linear-equations" }],
    pdf: { key: `books/mle/runs/run-1/ch0${n}.pdf`, sha256: "00" },
  };
}

function release(id: number, opts: { lang?: "en" | "ar"; kind?: "final" | "draft"; superseded_by?: number | null; withdrawn?: boolean; chapters?: number[] } = {}) {
  const lang = opts.lang ?? "en";
  const kind = opts.kind ?? "final";
  const edition_key = `${lang}-${kind === "final" ? id : `draft-2026-10-30-${id}`}`;
  const chapters = (opts.chapters ?? [1, 2]).map((n) => chapter(n, lang));
  const bundle = {
    schema: "sketchcast.book-release/1",
    release: { id, release_kind: kind, edition_key, supersedes: null, released_at: "2026-10-30T09:00:00Z", released_by: "founder@sketchcast.app" },
    work: { uid: "mastering-linear-equations", slug: "mastering-linear-equations", title: "Algebra: Mastering Linear Equations", subtitle: null, language: lang, subject: "Mathematics", curriculum_code: "c", grade_band: "Stage 7", age_band: "11–14", revision_key: "d1", cover: null },
    chapters,
    figures: {},
    files: { digital_pdf: null, print_pdf: null },
    integrity: { chapter_hash_rule: "sha256(json.dumps({sections, exercises}, sort_keys=True, ensure_ascii=False))" },
  };
  const text = JSON.stringify(bundle, null, 2);
  const key = `books/mastering-linear-equations/editions/${edition_key}/bundle.json`;
  const row: ReleaseRow = {
    id,
    work_uid: "mastering-linear-equations",
    slug: "mastering-linear-equations",
    release_kind: kind,
    edition_key,
    language: lang,
    revision_key: "d1",
    gate_e_approval_id: kind === "final" ? 900 : null,
    title: "Algebra: Mastering Linear Equations",
    subtitle: null,
    subject: "Mathematics",
    curriculum_code: "c",
    grade_band: "Stage 7",
    age_band: "11–14",
    chapters: chapters.map((c) => ({
      chapter: c.chapter,
      title: c.title,
      content_sha256: c.content_sha256,
      approval_id: c.approval.id,
      approval_kind: c.approval.kind as "gate_d" | "book",
      gate_d_approval_id: c.approval.kind === "gate_d" ? c.approval.id : null, // null when the approval is the book-level one
      pdf_key: c.pdf.key,
    })),
    chapter_count: chapters.length,
    bundle_key: key,
    bundle_sha256: sha256Hex(Buffer.from(text, "utf8")),
    digital_pdf_key: null,
    digital_pdf_sha256: null,
    print_pdf_key: null,
    print_pdf_sha256: null,
    cover_key: null,
    cover_sha256: null,
    released_by: "founder@sketchcast.app",
    released_at: "2026-10-30T09:00:00Z",
    run_id: null,
    superseded_by: opts.superseded_by ?? null,
    withdrawn_at: opts.withdrawn ? "2026-10-31T00:00:00Z" : null,
    withdrawn_reason: opts.withdrawn ? "typo in chapter 1" : null,
    withdrawn_by: opts.withdrawn ? "founder@sketchcast.app" : null,
  };
  return { row, bundle, text, key };
}

function s3With(files: Record<string, string>): BundleReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async getBytes(key: string) {
      reads.push(key);
      if (!(key in files)) throw new Error(`NoSuchKey ${key}`);
      return new Uint8Array(Buffer.from(files[key], "utf8"));
    },
  };
}

describe("verifyBundle — the contract's hash rule", () => {
  it("a good bundle passes", () => {
    const r = release(12);
    expect(verifyBundle(r.row, Buffer.from(r.text)).problems).toEqual([]);
  });
  it("a tampered chapter is refused even when the bundle hash is recomputed", () => {
    const r = release(12);
    const tampered = JSON.parse(r.text);
    tampered.chapters[0].sections[0].blocks[0].text = "A letter can stand for a KNOWN number.";
    const text = JSON.stringify(tampered);
    const row = { ...r.row, bundle_sha256: sha256Hex(Buffer.from(text)) };
    expect(verifyBundle(row, Buffer.from(text)).problems).toEqual(["chapter 1: content_sha256 does not match its sections and exercises"]);
  });
  it("a changed answer changes the hash too (exercises are hashed)", () => {
    const r = release(12);
    const t = JSON.parse(r.text);
    t.chapters[1].exercises[0].answer = "8";
    expect(verifyBundle({ ...r.row, bundle_sha256: "" }, Buffer.from(JSON.stringify(t))).problems.join()).toMatch(/chapter 2: content_sha256/);
  });
  it("refuses a bundle whose bytes do not match the row, a wrong schema, a wrong release id", () => {
    const r = release(12);
    expect(verifyBundle(r.row, Buffer.from(r.text + " ")).problems[0]).toMatch(/bundle sha256/);
    const other = JSON.parse(r.text);
    other.schema = "sketchcast.book-release/2";
    other.release.id = 13;
    const p = verifyBundle({ ...r.row, bundle_sha256: "" }, Buffer.from(JSON.stringify(other))).problems.join(" | ");
    expect(p).toMatch(/schema is "sketchcast.book-release\/2"/);
    expect(p).toMatch(/release.id 13 is not row 12/);
  });
  it("refuses a chapter whose hash differs from the release row's chapters", () => {
    const r = release(12);
    const row = { ...r.row, chapters: r.row.chapters.map((c) => (c.chapter === 2 ? { ...c, content_sha256: "ab".repeat(32) } : c)) };
    expect(verifyBundle(row, Buffer.from(r.text)).problems).toEqual(["chapter 2: hash differs from the release row"]);
  });
});

describe("verifyBundle — chapter approvals (gate_d or book)", () => {
  const patched = (r: ReturnType<typeof release>, f: (b: { chapters: { approval: Record<string, unknown> | null }[] }) => void) => {
    const b = JSON.parse(r.text);
    f(b);
    return Buffer.from(JSON.stringify(b));
  };
  it("a book-approved chapter passes with gate_d_approval_id null on the row", () => {
    const r = release(12);
    expect(r.bundle.chapters[1].approval).toMatchObject({ kind: "book", id: BOOK_APPROVAL });
    expect(r.row.chapters[1]).toMatchObject({ approval_kind: "book", approval_id: BOOK_APPROVAL, gate_d_approval_id: null });
    expect(verifyBundle(r.row, Buffer.from(r.text)).problems).toEqual([]);
  });
  it("a row written before the contract change (no approval_kind / approval_id) still verifies", () => {
    const r = release(12);
    const row = { ...r.row, chapters: r.row.chapters.map((c) => {
      const old = { ...c };
      delete old.approval_id;
      delete old.approval_kind;
      return old;
    }) };
    expect(verifyBundle(row, Buffer.from(r.text)).problems).toEqual([]);
  });
  it("an approval with no id is refused, whatever its kind", () => {
    const r = release(12);
    const bytes = patched(r, (b) => { delete b.chapters[0].approval!.id; b.chapters[1].approval!.id = null; });
    expect(verifyBundle({ ...r.row, bundle_sha256: "" }, bytes).problems).toEqual(["chapter 1: approval has no id", "chapter 2: approval has no id"]);
  });
  it("a missing approval or an unknown kind is refused", () => {
    const r = release(12);
    const bytes = patched(r, (b) => { b.chapters[0].approval = null; b.chapters[1].approval!.kind = "gate_c"; });
    expect(verifyBundle({ ...r.row, bundle_sha256: "", chapters: r.row.chapters.map((c) => ({ ...c, approval_kind: null })) }, bytes).problems).toEqual([
      "chapter 1: no approval",
      'chapter 2: approval kind "gate_c" is not gate_d or book',
    ]);
  });
  it("a gate_d chapter still needs its gate_d_approval_id on the row", () => {
    const r = release(12);
    const row = { ...r.row, chapters: r.row.chapters.map((c) => ({ ...c, gate_d_approval_id: null })) };
    expect(verifyBundle(row, Buffer.from(r.text)).problems).toEqual(["chapter 1: a gate_d approval needs gate_d_approval_id on the release row"]);
  });
  it("the row and the bundle must agree on the approval kind and id", () => {
    const r = release(12);
    const row = { ...r.row, chapters: r.row.chapters.map((c) => (c.chapter === 2 ? { ...c, approval_kind: "gate_d" as const, approval_id: 5 } : c)) };
    expect(verifyBundle(row, Buffer.from(r.text)).problems).toEqual([
      "chapter 2: approval kind book differs from the release row (gate_d)",
      "chapter 2: approval id 77 differs from the release row (5)",
    ]);
  });
  it("a final with a book-approved chapter imports", async () => {
    const r = release(12);
    const db = fakeDb({ pub_releases: [r.row] });
    expect(await importRelease(db, s3With({ [r.key]: r.text }), r.row)).toMatchObject({ status: "ok", release_id: 12 });
  });
});

describe("releaseBlocks — sections and exercise STEMS only", () => {
  it("one block per section and per exercise stem, anchored by sid / xid, in the release's language", () => {
    const r = release(12, { lang: "ar" });
    const blocks = releaseBlocks(r.row, r.bundle as never);
    expect(blocks.map((b) => `${b.chapter}:${b.kind}:${b.anchor}`)).toEqual([
      "1:section:s1", "1:section:s2", "1:exercise_stem:x1", "1:exercise_stem:x2",
      "2:section:s1", "2:section:s2", "2:exercise_stem:x1", "2:exercise_stem:x2",
    ]);
    expect(blocks.every((b) => b.language === "ar" && b.version === "12" && b.release_id === 12 && b.source_id === "mastering-linear-equations")).toBe(true);
    expect(blocks[0].text).toContain("متغير: حرف يمثل عددا");
  });
  it("NO block contains an answer, worked solution, marking scheme or option", () => {
    for (const lang of ["en", "ar"] as const) {
      const r = release(12, { lang });
      const all = releaseBlocks(r.row, r.bundle as never).map((b) => `${b.title} ${b.text}`).join("\n");
      for (const secret of ANSWERS) expect(all).not.toContain(secret);
    }
  });
});

describe("importRelease", () => {
  it("imports en and ar as two products of one work, replaces blocks, logs ok", async () => {
    const en = release(12, { lang: "en" });
    const ar = release(13, { lang: "ar" });
    const db = fakeDb();
    const s3 = s3With({ [en.key]: en.text, [ar.key]: ar.text });
    expect(await importRelease(db, s3, en.row)).toMatchObject({ status: "ok", release_id: 12, blocks: 8 });
    expect(await importRelease(db, s3, ar.row)).toMatchObject({ status: "ok", release_id: 13, blocks: 8 });
    expect(db.blocks).toHaveLength(16);
    const products = db.tables.sk_book_products;
    expect(products.map((p) => [p.slug, p.work_uid, p.language, p.release_id, p.release_kind, p.status])).toEqual([
      ["mastering-linear-equations", "mastering-linear-equations", "en", 12, "final", "approved"],
      ["mastering-linear-equations-ar", "mastering-linear-equations", "ar", 13, "final", "approved"],
    ]);
    expect(db.tables.sk_release_imports.map((r) => [r.release_id, r.status, r.blocks])).toEqual([[12, "ok", 8], [13, "ok", 8]]);
    for (const secret of ANSWERS) expect(JSON.stringify(db.blocks)).not.toContain(secret);
  });

  it("is idempotent: the same release again is skipped without reading S3 or writing", async () => {
    const en = release(12);
    const db = fakeDb();
    const s3 = s3With({ [en.key]: en.text });
    await importRelease(db, s3, en.row);
    const calls = db.calls.length;
    expect(await importRelease(db, s3, en.row)).toEqual({ status: "skipped", release_id: 12, reason: "already imported" });
    expect(s3.reads).toHaveLength(1);
    expect(db.calls.length).toBe(calls);
    expect(db.blocks).toHaveLength(8);
  });

  it("a tampered bundle is refused: nothing replaced, the error is logged", async () => {
    const good = release(12);
    const bad = release(14, { chapters: [1] });
    const t = JSON.parse(bad.text);
    t.chapters[0].exercises[0].stem = "Tampered stem";
    const db = fakeDb();
    await importRelease(db, s3With({ [good.key]: good.text }), good.row);
    const r = await importRelease(db, s3With({ [bad.key]: JSON.stringify(t) }), bad.row);
    expect(r.status).toBe("error");
    expect((r as { error: string }).error).toMatch(/refused: .*chapter 1: content_sha256/);
    expect(db.blocks.every((b) => b.version === "12")).toBe(true);
    expect(db.tables.sk_release_imports.find((x) => x.release_id === 14)).toMatchObject({ status: "error" });
  });

  it("an unreadable bundle (S3 AccessDenied) is an error, not a crash", async () => {
    const r = await importRelease(fakeDb(), { getBytes: async () => { throw new Error("AccessDenied"); } }, release(12).row);
    expect(r).toMatchObject({ status: "error", error: "AccessDenied" });
  });

  it("FINALS ONLY: a draft release is skipped — no S3 read, no product, no blocks, logged with the founder's reason", async () => {
    const draft = release(21, { kind: "draft" });
    const db = fakeDb({ pub_releases: [draft.row] });
    const s3 = s3With({ [draft.key]: draft.text });
    const r = await importRelease(db, s3, draft.row);
    expect(r).toEqual({ status: "skipped", release_id: 21, reason: "draft releases are not used (founder 2026-10-30)" });
    expect(s3.reads).toEqual([]);
    expect(db.tables.sk_book_products).toEqual([]);
    expect(db.blocks).toEqual([]);
    expect(db.calls.filter((c) => c.rpc === "sk_knowledge_replace")).toEqual([]);
    expect(db.tables.sk_release_imports).toEqual([
      expect.objectContaining({ release_id: 21, work_uid: "mastering-linear-equations", status: "skipped", blocks: 0, error: "draft releases are not used (founder 2026-10-30)" }),
    ]);
  });

  it("FINALS ONLY: a final release is imported and its product is approved, release_kind final", async () => {
    const fin = release(20, { kind: "final" });
    const draft = release(22, { kind: "draft" });
    const db = fakeDb({ pub_releases: [fin.row, draft.row] });
    const s3 = s3With({ [fin.key]: fin.text, [draft.key]: draft.text });
    expect(await importRelease(db, s3, fin.row)).toMatchObject({ status: "ok", release_id: 20, blocks: 8 });
    expect(db.tables.sk_book_products[0]).toMatchObject({ status: "approved", release_kind: "final", release_id: 20 });
    // a later draft of the same book changes nothing
    expect(await importRelease(db, s3, draft.row)).toMatchObject({ status: "skipped", reason: "draft releases are not used (founder 2026-10-30)" });
    expect(db.tables.sk_book_products[0]).toMatchObject({ release_kind: "final", release_id: 20 });
    expect(new Set(db.blocks.map((b) => b.version))).toEqual(new Set(["20"]));
  });

  it("draft blocks imported earlier are removed: the product falls back to its live final", async () => {
    const fin = release(84, { kind: "final" });
    const draft = release(85, { kind: "draft" });
    const db = fakeDb({
      pub_releases: [fin.row, draft.row],
      sk_book_products: [{ id: "p1", slug: "mastering-linear-equations", title: "T", status: "draft", work_uid: "mastering-linear-equations", language: "en", release_id: 85, release_kind: "draft" }],
    });
    for (const b of releaseBlocks(draft.row, draft.bundle as never)) db.blocks.push({ ...b, id: db.blocks.length + 1, created_at: "2026-10-30" });
    const r = await importRelease(db, s3With({ [fin.key]: fin.text, [draft.key]: draft.text }), draft.row);
    expect(r).toMatchObject({ status: "skipped", reconciled: { status: "imported", result: { status: "ok", release_id: 84 } } });
    expect(new Set(db.blocks.map((b) => b.version))).toEqual(new Set(["84"]));
    expect(db.tables.sk_book_products[0]).toMatchObject({ id: "p1", status: "approved", release_kind: "final", release_id: 84 });
  });

  it("draft blocks imported earlier with no live final: blocks removed, product unavailable", async () => {
    const draft = release(86, { kind: "draft" });
    const db = fakeDb({
      pub_releases: [draft.row],
      sk_book_products: [{ id: "p2", slug: "mle", title: "T", status: "draft", work_uid: "mastering-linear-equations", language: "en", release_id: 86, release_kind: "draft" }],
    });
    for (const b of releaseBlocks(draft.row, draft.bundle as never)) db.blocks.push({ ...b, id: db.blocks.length + 1, created_at: "2026-10-30" });
    const r = await pollReleases(db, { s3: s3With({}) });
    expect(r).toMatchObject({ status: "ok", imported: [], skipped: [86], unavailable: ["p2"] });
    expect(db.blocks).toEqual([]);
    expect(db.tables.sk_book_products[0]).toMatchObject({ status: "retired", release_id: null, release_kind: null });
  });

  it("a final adopts an already-approved product with the same slug and no work_uid (Biology-style)", async () => {
    const d = release(30);
    const db = fakeDb({ sk_book_products: [{ id: "bio", slug: "mastering-linear-equations", title: "Old", status: "approved", work_uid: null, language: null, release_id: null, release_kind: null, languages: ["en"] }] });
    await importRelease(db, s3With({ [d.key]: d.text }), d.row);
    expect(db.tables.sk_book_products).toHaveLength(1);
    expect(db.tables.sk_book_products[0]).toMatchObject({ id: "bio", status: "approved", work_uid: "mastering-linear-equations", language: "en", release_id: 30, release_kind: "final" });
  });

  it("a superseded release is not imported: the book points at its live release", async () => {
    const old = release(40, { superseded_by: 41 });
    const cur = release(41);
    const db = fakeDb({ pub_releases: [old.row, cur.row] });
    const s3 = s3With({ [old.key]: old.text, [cur.key]: cur.text });
    const r = await importRelease(db, s3, old.row);
    expect(r).toMatchObject({ status: "skipped", reason: "superseded by 41", reconciled: { status: "imported", result: { status: "ok", release_id: 41 } } });
    expect(s3.reads).toEqual([cur.key]);
    expect(new Set(db.blocks.map((b) => b.version))).toEqual(new Set(["41"]));
    expect(db.tables.sk_release_imports.find((x) => x.release_id === 40)).toMatchObject({ status: "skipped" });
  });

  it("a withdrawn release with nothing live: its blocks go and the product is marked unavailable", async () => {
    const r1 = release(50);
    const db = fakeDb({ pub_releases: [r1.row] });
    const s3 = s3With({ [r1.key]: r1.text });
    await importRelease(db, s3, r1.row);
    expect(db.blocks).toHaveLength(8);
    const withdrawn = { ...r1.row, withdrawn_at: "2026-10-31T00:00:00Z", withdrawn_reason: "legal", withdrawn_by: "founder@sketchcast.app" };
    db.tables.pub_releases[0] = withdrawn;
    const r = await importRelease(db, s3, withdrawn);
    expect(r).toMatchObject({ status: "skipped", reason: "withdrawn", reconciled: { status: "unavailable" } });
    expect(db.blocks).toHaveLength(0);
    expect(db.tables.sk_book_products[0]).toMatchObject({ status: "retired", release_id: null, release_kind: null, edition_key: null });
  });
});

describe("pickRelease", () => {
  it("the newest live FINAL; drafts, superseded and withdrawn never", () => {
    const rows = [release(1, { kind: "draft" }).row, release(2, { kind: "draft" }).row, release(3, { kind: "final", withdrawn: true }).row];
    expect(pickRelease(rows)).toBeNull();
    expect(pickRelease([...rows, release(4, { kind: "final" }).row, release(5, { kind: "draft" }).row])?.id).toBe(4);
    expect(pickRelease([release(6, { superseded_by: 7 }).row])).toBeNull();
  });
});

describe("pollReleases", () => {
  it("pub_releases missing (42P01 / schema cache) → waiting_for_book_app, quietly, nothing written", async () => {
    const db = fakeDb({}, { missing: ["pub_releases"] });
    expect(await pollReleases(db, { s3: s3With({}) })).toEqual({ status: "waiting_for_book_app" });
    expect(db.calls).toEqual([]);
    const pg = { from: () => ({ select: () => ({ is: () => ({ is: () => ({ order: async () => ({ data: null, error: { code: "42P01", message: 'relation "public.pub_releases" does not exist' } }) }) }) }) }), rpc: async () => ({}) };
    expect(await pollReleases(pg as never, { s3: s3With({}) })).toEqual({ status: "waiting_for_book_app" });
  });

  it("the real table exists but is empty and 0174 is not applied → waiting_for_0174 (the production state on 2026-10-30)", async () => {
    let call = 0;
    const chain = (res: unknown) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "is", "not", "eq"]) b[m] = () => b;
      b.order = async () => res;
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve(res).then(ok);
      return b;
    };
    const db = {
      from: (t: string) => (call++, t === "pub_releases" ? chain({ data: [], error: null }) : chain({ data: null, error: { code: "42703", message: "column sk_book_products.work_uid does not exist" } })),
      rpc: async () => ({ data: null, error: { message: "refused" } }),
    };
    expect(await pollReleases(db as never, { s3: s3With({}) })).toEqual({ status: "waiting_for_0174", live: 0 });
    expect(call).toBe(2);
  });

  it("imports what changed, leaves the unchanged alone, and marks a book with no live release unavailable", async () => {
    const en = release(60, { lang: "en" });
    const ar = release(61, { lang: "ar" });
    const gone = { ...release(70).row, work_uid: "old-book", slug: "old-book" };
    const draftOnly = { ...release(63, { kind: "draft" }).row, work_uid: "draft-only-book", slug: "draft-only-book" };
    const db = fakeDb({
      pub_releases: [en.row, ar.row, draftOnly],
      sk_book_products: [{ id: "p-old", slug: "old-book", title: "Old", status: "approved", work_uid: "old-book", language: "en", release_id: 70, release_kind: "final" }],
    });
    db.blocks.push({ ...releaseBlocks(gone, release(70).bundle as never)[0], source_id: "old-book", id: 999, created_at: "2026-10-01" });
    const s3 = s3With({ [en.key]: en.text, [ar.key]: ar.text });
    const first = await pollReleases(db, { s3 });
    expect(first).toMatchObject({ status: "ok", live: 3, imported: [60, 61], unchanged: [], skipped: [63], unavailable: ["p-old"], errors: [] });
    expect(db.blocks.some((b) => b.source_id === "old-book")).toBe(false);
    expect(db.blocks.some((b) => b.source_id === "draft-only-book")).toBe(false);
    expect(db.tables.sk_book_products.some((p) => p.work_uid === "draft-only-book")).toBe(false);
    expect(db.tables.sk_release_imports.find((x) => x.release_id === 63)).toMatchObject({ status: "skipped", error: "draft releases are not used (founder 2026-10-30)" });
    expect(db.tables.sk_book_products.find((p) => p.id === "p-old")).toMatchObject({ status: "retired", release_id: null });

    // the draft is logged once, not every day
    const second = await pollReleases(db, { s3 });
    expect(second).toMatchObject({ status: "ok", imported: [], unchanged: [60, 61], skipped: [], unavailable: [] });
    expect(s3.reads).toHaveLength(2);

    // a new final supersedes 60
    const next = release(62, { lang: "en" });
    db.tables.pub_releases[0] = { ...en.row, superseded_by: 62 };
    db.tables.pub_releases.push(next.row);
    const third = await pollReleases(db, { s3: s3With({ [next.key]: next.text }) });
    expect(third).toMatchObject({ imported: [62], unchanged: [61] });
    expect(new Set(db.blocks.filter((b) => b.language === "en").map((b) => b.version))).toEqual(new Set(["62"]));
  });
});
