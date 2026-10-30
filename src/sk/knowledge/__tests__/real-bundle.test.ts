// SK S7 K1 — the FIRST real book-app bundle (pub_releases id 1, Linear
// Equations ch1, draft en-draft-2026-10-30-1, fetched read-only from S3 on
// 2026-10-30), trimmed to 2 sections / 4 exercises with its content_sha256
// recomputed by our rule. (The UNtrimmed bundle's stated hash 57c0813b… was
// reproduced exactly by canonical-json.ts before trimming.) What the real
// shape taught us, pinned here:
//   * bundle.release has NO id (written before the row): the edition key ties it;
//   * sections carry `heading` (not `title`) and `source_gaps`;
//   * chapters carry `review.blind_answers` — ANSWERS — which must never be indexed;
//   * exercises carry answer / worked_solution / marking_scheme / pairs / items.
// Run: node node_modules/vitest/vitest.mjs run src/sk/knowledge/__tests__/real-bundle.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chapterContentSha256, parseRawJson, sha256Hex } from "../canonical-json";
import { importRelease, pollReleases, releaseBlocks, verifyBundle, type ReleaseRow } from "../release";
import { fakeDb } from "./fake-db";

const TEXT = readFileSync(path.join(__dirname, "fixtures/release-mle-draft-1.trimmed.json"), "utf8");
const BUNDLE = JSON.parse(TEXT);
const KEY = "books/mastering-linear-equations/editions/en-draft-2026-10-30-1/bundle.json";

/** pub_releases row 1 as it is on production, with the trimmed bundle's hashes. */
function row(over: Partial<ReleaseRow> = {}, text = TEXT): ReleaseRow {
  const b = JSON.parse(text);
  return {
    id: 1, work_uid: "mastering-linear-equations", slug: "mastering-linear-equations", release_kind: "draft",
    edition_key: "en-draft-2026-10-30-1", language: "en", revision_key: "d1", gate_e_approval_id: null,
    title: "Algebra: Mastering Linear Equations", subtitle: null, subject: "mathematics/algebra", curriculum_code: "cambridge_ls_maths_0862",
    grade_band: "7,8,9", age_band: "11-14",
    chapters: b.chapters.map((c: { chapter: number; title: string; content_sha256: string; pdf: { key: string } }) => ({ chapter: c.chapter, title: c.title, content_sha256: c.content_sha256, gate_d_approval_id: 10, pdf_key: c.pdf.key })),
    chapter_count: 1, bundle_key: KEY, bundle_sha256: sha256Hex(Buffer.from(text)), digital_pdf_key: null, digital_pdf_sha256: null,
    print_pdf_key: null, print_pdf_sha256: null, cover_key: null, cover_sha256: null, released_by: "muqtadar.quraishi@sketchcast.app",
    released_at: "2026-10-30T02:26:51Z", run_id: 31, superseded_by: null, withdrawn_at: null, withdrawn_reason: null, withdrawn_by: null,
    ...over,
  };
}

/** The same chapter as a FINAL (what a Gate E release of it would carry). */
function asFinal() {
  const b = JSON.parse(TEXT);
  b.release = { ...b.release, release_kind: "final", edition_key: "en-1", gate_e_approval_id: 900 };
  const text = JSON.stringify(b);
  return { text, row: row({ release_kind: "final", edition_key: "en-1", gate_e_approval_id: 900, id: 2, bundle_key: KEY.replace("en-draft-2026-10-30-1", "en-1") }, text) };
}

const secrets = (() => {
  const ch = BUNDLE.chapters[0];
  const out: string[] = [];
  for (const x of ch.exercises) {
    for (const v of [x.answer, x.worked_solution, ...(x.marking_scheme ?? []).map((m: { point: string }) => m.point)]) if (typeof v === "string" && v.length >= 20) out.push(v); // short answers ("coefficient") are ordinary teaching words
  }
  for (const a of ch.review?.blind_answers ?? []) if (a.answer.length >= 20) out.push(a.answer);
  return out;
})();

describe("the real bundle shape (sketchcast.book-release/1, release 1)", () => {
  it("parses, and its content_sha256 verifies by the contract's rule", () => {
    expect(BUNDLE.schema).toBe("sketchcast.book-release/1");
    expect(BUNDLE.release.id).toBeUndefined();
    const raw = parseRawJson(TEXT) as { chapters: { [k: string]: never }[] };
    expect(chapterContentSha256(raw.chapters[0])).toBe(BUNDLE.chapters[0].content_sha256);
    expect(verifyBundle(row(), Buffer.from(TEXT)).problems).toEqual([]);
  });

  it("an edition key that does not match the row is refused (the bundle has no id to check)", () => {
    expect(verifyBundle(row({ edition_key: "en-draft-2026-10-30-2" }), Buffer.from(TEXT)).problems).toEqual([
      'bundle edition_key "en-draft-2026-10-30-1" is not en-draft-2026-10-30-2',
    ]);
  });

  it("flattens sections by `heading`, one block per section and per exercise stem", () => {
    const blocks = releaseBlocks(row(), BUNDLE);
    expect(blocks.map((b) => `${b.kind}:${b.anchor}`)).toEqual(["section:s1", "section:s2", "exercise_stem:x1", "exercise_stem:x2", "exercise_stem:x3", "exercise_stem:x4"]);
    expect(blocks[0].title).toBe(BUNDLE.chapters[0].sections[0].heading);
    expect(blocks[0].text.split("\n").length).toBeGreaterThan(3);
    expect(blocks.every((b) => b.chapter === 1 && b.language === "en")).toBe(true);
  });

  it("no answer, worked solution, mark point or review blind answer becomes a block", () => {
    expect(secrets.length).toBeGreaterThan(3);
    const all = releaseBlocks(row(), BUNDLE).map((b) => b.text).join("\n");
    for (const s of secrets) expect(all, s).not.toContain(s);
  });

  it("as a DRAFT (its real kind) it is skipped: no S3 read, no product, no blocks", async () => {
    const db = fakeDb({ pub_releases: [row()] });
    const reads: string[] = [];
    const r = await importRelease(db, { getBytes: async (k) => (reads.push(k), new Uint8Array(Buffer.from(TEXT))) }, row());
    expect(r).toMatchObject({ status: "skipped", reason: "draft releases are not used (founder 2026-10-30)" });
    expect(reads).toEqual([]);
    expect(db.tables.sk_book_products).toEqual([]);
    expect(db.blocks).toEqual([]);
  });

  it("the poll's DRY run reports it skipped and writes nothing, even with 0174 missing", async () => {
    const db = fakeDb({ pub_releases: [row()] });
    const r = await pollReleases(db, { dryRun: true, s3: { getBytes: async () => { throw new Error("no read expected"); } } });
    expect(r).toMatchObject({ status: "ok", live: 1, skipped: [1], imported: [], dryRun: true });
    expect(db.tables.sk_release_imports).toEqual([]);
    expect(db.calls).toEqual([]);
  });

  it("the same chapter as a FINAL imports: approved product, 6 blocks, no answers", async () => {
    const { text, row: fin } = asFinal();
    const db = fakeDb({ pub_releases: [fin] });
    const r = await importRelease(db, { getBytes: async () => new Uint8Array(Buffer.from(text)) }, fin);
    expect(r).toMatchObject({ status: "ok", release_id: 2, blocks: 6 });
    expect(db.tables.sk_book_products[0]).toMatchObject({ work_uid: "mastering-linear-equations", language: "en", release_id: 2, edition_key: "en-1", release_kind: "final", status: "approved", cover_key: null });
    const all = db.blocks.map((b) => b.text).join("\n");
    for (const s of secrets) expect(all).not.toContain(s);
  });
});
