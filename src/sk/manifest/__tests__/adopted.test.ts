/**
 * Adopted catalogue kits (2026-10-31): a copy is new generation rows over the
 * SOURCE's files. The loader reads the copy's sibling pieces, the read path
 * pins by generation id (not by the source's folder), and the second copy of
 * a source gets the first one's map re-pinned — no model call.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/manifest/__tests__/adopted.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { FakeAdmin, type Row } from "./fake-admin";
import { loadKitInput } from "../load";
import { deriveAndStore, type ModelCall } from "../service";
import { pinnedGenerationIds, readManifest } from "../store";
import { rebaseManifest, type KitManifest } from "../derive";

const CAT = "c0000000-0000-4000-8000-000000000000"; // the catalogue system account
const SRC = "5a000000-0000-4000-8000-000000000001"; // the catalogue kit's lesson
const SRC_WS = "5a000000-0000-4000-8000-000000000002"; // its worksheet
const SRC_DECK = "5a000000-0000-4000-8000-000000000003"; // its deck
const TK = "7c000000-0000-4000-8000-000000000001"; // topic_kits.id
const ART = "a7000000-0000-4000-8000-000000000001";
const ANNE = "a0000000-0000-4000-8000-00000000000a";
const BEN = "b0000000-0000-4000-8000-00000000000b";
const A_GEN = "a1000000-0000-4000-8000-000000000001";
const A_WS = "a1000000-0000-4000-8000-000000000002";
const B_GEN = "b1000000-0000-4000-8000-000000000001";
const B_WS = "b1000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-10-31T10:00:00.000Z");

const ref = (source: string) => ({ catalogue_ref: { topic_id: "t", topic_kit_id: TK, source_generation_id: source, article_id: ART, language: "en" } });
const gen = (id: string, owner: string, kind: string, params: Record<string, unknown>, created = "2026-10-30T17:59:15+00:00"): Row => ({
  id,
  owner_id: owner,
  book_id: null,
  chapter_ref: null,
  kind,
  status: "done",
  withdrawn_at: null,
  params,
  created_at: created,
});
/** A row over the SOURCE's file (what adopt copies: same storage_path, new generation_id). */
const row = (gid: string, src: string, kind: string, file: string): Row => ({ id: `${gid.slice(0, 4)}-${kind}-${file}`, generation_id: gid, kind, storage_path: `${CAT}/${src}/${file}`, created_at: "2026-10-30T17:59:15+00:00" });
const pieces = (gid: string, wsid: string) => [
  row(gid, SRC, "script_json", "script.json"),
  row(gid, SRC, "video_mp4", "lesson.mp4"),
  row(gid, SRC, "thumbnail_png", "thumb.png"),
  row(wsid, SRC_WS, "questions_json", "worksheet_questions.json"),
  row(wsid, SRC_WS, "docx", "worksheet.docx"),
  row(wsid, SRC_WS, "answer_key_docx", "answer_key.docx"),
];

const SCRIPT = JSON.stringify({
  part: 1,
  of: 1,
  language: "en",
  script: {
    script_id: "SCR-bio-2",
    segments: [
      { segment_id: "s001", type: "hook", text: "Why do cells differ?", slide_heading: "Hook", slide_points: [], scene: { concept: null, elements: [] } },
      { segment_id: "s002", type: "explore", text: "Plant cells have a wall.", slide_heading: "Cell wall", slide_points: ["rigid"], scene: { concept: "o1", elements: [] } },
      { segment_id: "s003", type: "explore", text: "The vacuole stores sap.", slide_heading: "Big vacuole", slide_points: ["sap"], scene: { concept: null, elements: [] } },
    ],
  },
  video: { manifest_id: "VID-bio-2", segments: [{ segment_id: "s001", clip_duration_seconds: 8 }, { segment_id: "s002", clip_duration_seconds: 12 }, { segment_id: "s003", clip_duration_seconds: 10 }] },
});
const QUESTIONS = JSON.stringify({ questions: [{ id: "q1", type: "short", prompt: "What is rigid?", answer: "the wall" }, { id: "q2", type: "short", prompt: "What stores sap?", answer: "vacuole" }] });

function world() {
  return new FakeAdmin(
    {
      generations: [
        gen(SRC, CAT, "presentation", { format_version: 3, language: "en", article_id: ART }),
        gen(SRC_WS, CAT, "worksheet", { article_id: ART }),
        gen(SRC_DECK, CAT, "deck", { article_id: ART }),
        gen(A_GEN, ANNE, "presentation", ref(SRC)), // a copy carries only its lineage
        gen(A_WS, ANNE, "worksheet", ref(SRC_WS)),
        gen(B_GEN, BEN, "presentation", ref(SRC), "2026-10-31T09:00:00+00:00"),
        gen(B_WS, BEN, "worksheet", ref(SRC_WS), "2026-10-31T09:00:00+00:00"),
      ],
      artifacts: [
        row(SRC, SRC, "script_json", "script.json"),
        row(SRC, SRC, "video_mp4", "lesson.mp4"),
        row(SRC, SRC, "thumbnail_png", "thumb.png"),
        row(SRC_WS, SRC_WS, "questions_json", "worksheet_questions.json"),
        row(SRC_WS, SRC_WS, "docx", "worksheet.docx"),
        row(SRC_WS, SRC_WS, "answer_key_docx", "answer_key.docx"),
        ...pieces(A_GEN, A_WS),
        ...pieces(B_GEN, B_WS),
      ],
      topic_kits: [{ id: TK, presentation_generation_id: SRC, doc_generation_ids: { worksheet: SRC_WS, deck: SRC_DECK } }],
      topic_articles: [{ id: ART, source_article_id: null, objectives: [{ id: "o1", text: "Cell wall" }, { id: "o2", text: "Vacuole" }] }],
      topic_questions: [],
      sk_manifests: [],
    },
    { [`${CAT}/${SRC}/script.json`]: SCRIPT, [`${CAT}/${SRC_WS}/worksheet_questions.json`]: QUESTIONS },
  );
}

/** Both passes answer: s001 → none, s003 → o2; both items mapped. */
const model: ModelCall = async (req) => {
  const items = req.user.includes("QUESTIONS:");
  const q = /ws:[0-9a-f]{8}:q\d/g;
  const ids = Array.from(new Set(req.user.match(q) ?? []));
  const text = items
    ? JSON.stringify({ items: ids.map((id, i) => ({ q: id, concepts: [i === 0 ? "o1" : "o2"], segments: [i === 0 ? "p1:s002" : "p1:s003"], confidence: 0.95, reason: "r" })) })
    : JSON.stringify({ assignments: [{ segment: "p1:s001", primary: null, secondary: [], confidence: 0.9, reason: "hook" }, { segment: "p1:s003", primary: "o2", secondary: [], confidence: 0.93, reason: "sap" }] });
  return { text, usage: { input_tokens: 1500, output_tokens: 300 } };
};

describe("loadKitInput — an adopted catalogue copy reads its sibling pieces", () => {
  it("takes the article from catalogue_ref and the worksheet from her sibling copy; pins only her rows", async () => {
    const kit = await loadKitInput(world(), A_GEN);
    expect(kit.input.article_id).toBe(ART);
    expect(kit.input.concept_source).toBe("article_objectives");
    expect(kit.input.concepts?.map((c) => c.concept_id)).toEqual(["o1", "o2"]);
    expect(kit.worksheetGenerationId).toBe(A_WS);
    expect(kit.input.items.map((i) => i.q_id)).toEqual([`ws:${A_WS.slice(0, 8)}:q1`, `ws:${A_WS.slice(0, 8)}:q2`]);
    expect(new Set(kit.input.artifacts.map((r) => r.generation_id))).toEqual(new Set([A_GEN, A_WS]));
    expect(kit.input.scripts[0].script.script_id).toBe("SCR-bio-2");
    expect(kit.input.has_video).toEqual({ 1: true });
  });

  it("no sibling worksheet copied yet → the catalogue kit's own worksheet (topic_kits)", async () => {
    const a = world();
    a.tables.generations = a.tables.generations.filter((g) => g.id !== A_WS);
    a.tables.artifacts = a.tables.artifacts.filter((r) => r.generation_id !== A_WS);
    const kit = await loadKitInput(a, A_GEN);
    expect(kit.worksheetGenerationId).toBe(SRC_WS);
    expect(kit.input.items).toHaveLength(2);
  });
});

describe("one lesson map per catalogue source", () => {
  it("the first copy derives (two Haiku calls) and its map reads back READY (pins by generation id, not the source folder)", async () => {
    const a = world();
    const call = vi.fn(model);
    const r = await deriveAndStore(a, A_GEN, { now: NOW, call });
    expect(r.status).toBe("ready");
    expect(call).toHaveBeenCalledTimes(2);
    if (r.status !== "ready") throw new Error("unreachable");
    expect(r.manifest.pinned.generation_ids).toEqual([A_GEN, A_WS]);
    expect(pinnedGenerationIds(r.manifest)).toEqual([A_GEN, A_WS]);
    expect(r.manifest.segments.map((s) => s.slide_k)).toEqual([1, 2, 3]);
    // a later read re-checks the pins and stays ready (the source's own rows are not hers)
    const again = await readManifest(a, A_GEN, new Date(NOW.getTime() + 60_000));
    expect(again.status).toBe("ready");
  });

  it("a second teacher's copy of the same source gets the map COPIED: ready, no model call, her ids throughout", async () => {
    const a = world();
    await deriveAndStore(a, A_GEN, { now: NOW, call: model });
    const call = vi.fn(model);
    const r = await deriveAndStore(a, B_GEN, { now: NOW, call });
    expect(call).not.toHaveBeenCalled();
    expect(r.status).toBe("ready");
    if (r.status !== "ready") throw new Error("unreachable");
    expect(r.stats?.copiedFrom).toBe(A_GEN);
    expect(r.stats?.usage).toEqual({ input_tokens: 0, output_tokens: 0, usd: 0 });
    const m = r.manifest;
    const first = (a.tables.sk_manifests.find((x) => x.generation_id === A_GEN)!.manifest as KitManifest);
    expect(m.generation_id).toBe(B_GEN);
    expect(m.manifest_id).not.toBe(first.manifest_id);
    expect(m.pinned.generation_ids).toEqual([B_GEN, B_WS]);
    expect(m.items.map((i) => [i.q_id, i.generation_id])).toEqual([
      [`ws:${B_WS.slice(0, 8)}:q1`, B_WS],
      [`ws:${B_WS.slice(0, 8)}:q2`, B_WS],
    ]);
    expect(m.items.map((i) => i.concept_ids)).toEqual(first.items.map((i) => i.concept_ids));
    expect(m.segments.map((s) => s.concept.concept_id)).toEqual(first.segments.map((s) => s.concept.concept_id));
    expect(m.derived_by.copied_from).toBe(A_GEN);
    const stored = a.tables.sk_manifests.find((x) => x.generation_id === B_GEN)!;
    expect((stored.derived_by as { copied_from?: string }).copied_from).toBe(A_GEN);
    expect((await readManifest(a, B_GEN, NOW)).status).toBe("ready");
  });

  it("the catalogue SOURCE's own map (the SK tutor builds it) donates to the first copy", async () => {
    const a = world();
    const src = await deriveAndStore(a, SRC, { now: NOW, call: model });
    expect(src.status).toBe("ready");
    const call = vi.fn(model);
    const r = await deriveAndStore(a, A_GEN, { now: NOW, call });
    expect(call).not.toHaveBeenCalled();
    expect(r.stats?.copiedFrom).toBe(SRC);
    if (r.status !== "ready") throw new Error("unreachable");
    expect(r.manifest.items.map((i) => i.q_id)).toEqual([`ws:${A_WS.slice(0, 8)}:q1`, `ws:${A_WS.slice(0, 8)}:q2`]);
    expect(r.manifest.pinned.format_version).toBeNull(); // the copy's own (adopt stamps no format_version)
    expect((await readManifest(a, A_GEN, NOW)).status).toBe("ready");
  });

  it("a donor over different files (another worksheet) is not used: the kit derives", async () => {
    const a = world();
    await deriveAndStore(a, A_GEN, { now: NOW, call: model });
    // Ben's worksheet copy points at another file
    a.tables.artifacts = a.tables.artifacts.map((r) => (r.generation_id === B_WS && r.kind === "questions_json" ? { ...r, storage_path: `${CAT}/${SRC_WS}/worksheet_questions_v2.json` } : r));
    a.files[`${CAT}/${SRC_WS}/worksheet_questions_v2.json`] = QUESTIONS;
    const call = vi.fn(model);
    const r = await deriveAndStore(a, B_GEN, { now: NOW, call });
    expect(r.status).toBe("ready");
    expect(call).toHaveBeenCalledTimes(2);
    expect(r.stats?.copiedFrom).toBeUndefined();
  });

  it("a donor whose own rows drifted is re-checked, flipped stale and skipped", async () => {
    const a = world();
    await deriveAndStore(a, A_GEN, { now: NOW, call: model });
    a.tables.artifacts.push({ id: "late", generation_id: A_GEN, kind: "docx", storage_path: `${ANNE}/${A_GEN}/extra.docx`, created_at: "2026-10-31T09:30:00+00:00" });
    const call = vi.fn(model);
    const r = await deriveAndStore(a, B_GEN, { now: NOW, call });
    expect(call).toHaveBeenCalledTimes(2);
    expect(r.stats?.copiedFrom).toBeUndefined();
    expect(a.tables.sk_manifests.find((x) => x.generation_id === A_GEN)!.status).toBe("stale");
  });

  it("donors: false always derives", async () => {
    const a = world();
    await deriveAndStore(a, A_GEN, { now: NOW, call: model });
    const call = vi.fn(model);
    await deriveAndStore(a, B_GEN, { now: NOW, call, donors: false });
    expect(call).toHaveBeenCalledTimes(2);
  });
});

describe("rebaseManifest (pure)", () => {
  it("refuses a donor with another script or other items; a copy's own format_version is pinned", async () => {
    const a = world();
    const r = await deriveAndStore(a, A_GEN, { now: NOW, call: model });
    if (r.status !== "ready") throw new Error("unreachable");
    const { input } = await loadKitInput(a, B_GEN);
    expect(rebaseManifest(r.manifest, A_GEN, input, NOW.toISOString())).not.toBeNull();
    expect(rebaseManifest({ ...r.manifest, pinned: { ...r.manifest.pinned, script_ids: ["other"] } }, A_GEN, input, NOW.toISOString())).toBeNull();
    // the catalogue source (format 3) donates to a copy whose params carry none
    const fromSource = rebaseManifest(r.manifest, SRC, { ...input, format_version: null }, NOW.toISOString());
    expect(fromSource?.pinned.format_version).toBeNull();
    expect(fromSource?.format_version).toBeNull();
    expect(rebaseManifest(r.manifest, A_GEN, { ...input, items: input.items.slice(0, 1) }, NOW.toISOString())).toBeNull();
    expect(rebaseManifest(r.manifest, A_GEN, { ...input, items: input.items.map((i, k) => (k ? { ...i, prompt: "changed" } : i)) }, NOW.toISOString())).toBeNull();
  });
});
