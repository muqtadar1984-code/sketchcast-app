// SK S3 slice B — fixtures for the student kit player: a small Kit Manifest
// (four sections over two video parts, one trusted frame, one caption_only,
// one same-part fallback and one cross-part fallback) and a product → kit map
// world shaped like the Biology book's (chapter 8 carries three kits).
import type { KitManifest, ManifestItem, ManifestSegment } from "../manifest/derive";
import { FakeDb } from "./fake-supabase";

export const T0 = Date.parse("2026-10-29T10:00:00Z");
const DAY = 86_400_000;

export const PRODUCT = "161828e0-32aa-40df-bbf3-16eb32c82504";
export const SLUG = "cells-structure-function-organisation";
export const OTHER_PRODUCT = "26f0c1aa-1111-4aaa-8aaa-000000000001";
export const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
export const STUDENT = "0f6a2c1e-7b3d-4e5f-8a9b-0c1d2e3f4a5b";
export const STRANGER = "0f6a2c1e-7b3d-4e5f-8a9b-0c1d2e3f4a5c";

export const CELLS = "e064cda5-775d-4b30-a77e-1180123da6a8"; // chapter 1
export const BLOOD = "cbad6d74-7433-46ad-baed-12724c7e59cf"; // chapter 8, sort 0
export const RESP = "4246bd3e-48e0-407e-adce-872ab84239bc"; // chapter 8, sort 1
export const TRANSPORT = "4160b18e-2c3c-4ed6-b4dd-dce706eb0805"; // chapter 8, sort 2
export const UNMAPPED = "9a9a9a9a-0000-4000-8000-000000000009"; // a done presentation, not in the map
export const ELSEWHERE = "9a9a9a9a-0000-4000-8000-00000000000b"; // mapped to ANOTHER product

export const ITEM_MCQ = "5788dd4a-a674-49fa-ab1d-e71d8d888c46";
export const ITEM_TF = "a48f35f1-5a12-44e2-851b-a27d7b7163ff";
export const ITEM_OFFMAP = "a5c8ebbe-d00e-4951-81d0-b6fd3d1a55aa"; // a real bank item no section of the kit uses

const seg = (k: number, part: number, sid: string, heading: string, narration: string, visual: ManifestSegment["visual"], points: string[] = []): ManifestSegment => ({
  key: `p${part}:${sid}`,
  segment_id: sid,
  part,
  k,
  start_s: k * 10 - (part === 2 ? 30 : 0),
  end_s: k * 10 + 10 - (part === 2 ? 30 : 0),
  slide_t: k * 10 + 9 - (part === 2 ? 30 : 0),
  slide_k: k,
  type: "lesson",
  heading,
  points,
  narration,
  concept_slug: null,
  assets: [],
  video_path: `${OWNER}/${CELLS}/${part === 1 ? "lesson.mp4" : `lesson_part${part}.mp4`}`,
  concept: { concept_id: null, secondary: [], method: "none", confidence: 0, availability: "unavailable" },
  visual,
});

const judged = { model: "m", prompt_version: "v" };
const unjudged = { model: null, prompt_version: null };

export const NARRATION_0 = "A cell is the smallest unit of life. Every living thing is made of cells, from bacteria to blue whales.";

const item = (q_id: string, segment_ids: string[], over: Partial<ManifestItem> = {}): ManifestItem => ({
  q_id,
  source: "quiz",
  generation_id: CELLS,
  type: "mcq",
  prompt_hash: q_id,
  concept_ids: [],
  segment_ids,
  method: "objective_ref",
  confidence: 1,
  availability: "available",
  ...over,
});

export function kitManifest(): KitManifest {
  return {
    schema: "sk-kit-manifest/m1",
    derivation_version: 2,
    manifest_id: "m-cells",
    generation_id: CELLS,
    book_id: null,
    chapter_ref: null,
    article_id: null,
    parts: [1, 2],
    language: "en",
    format_version: 3,
    pinned: { script_ids: [], video_manifest_ids: [], format_version: 3, artifact_paths: [], artifacts_hash: "h" },
    completeness: { video: "ok", script: "ok", questions: "ok", concepts: "none", format_version: 3 },
    moves: { intro: "available", segment: "available", slide: "degraded", practise: "available", walkthrough: "available", explain: "available", remediate: "degraded" },
    segments: [
      seg(0, 1, "s001", "What is a cell?", NARRATION_0, { status: "distinct", show: "frame", reason: "new board", judged_by: judged }, ["Cells are the basic unit of life"]),
      seg(1, 1, "s002", "Plant and animal cells", "Plant cells have a cell wall. Animal cells do not.", { status: "unknown", show: "caption_only", reason: "no frame check in app (S1)", judged_by: unjudged }, ["Plant cells have a wall", "Animal cells have none"]),
      seg(2, 1, "s003", "The nucleus", "The nucleus holds the cell's genetic material.", { status: "misleading", show: "fallback_frame", fallback_k: 0, reason: "borrowed", judged_by: judged }),
      seg(3, 2, "s004", "Cell membrane", "The membrane controls what enters and leaves.", { status: "misleading", show: "fallback_frame", fallback_k: 0, reason: "borrowed", judged_by: judged }),
    ],
    concepts: [],
    items: [
      item("quiz:q1", ["p1:s001"], { bank_item_id: ITEM_MCQ }),
      item("quiz:q2", ["p1:s001"], { bank_item_id: ITEM_TF, type: "true_false" }),
      item("ws:q1", ["p1:s002"], { source: "worksheet" }), // no bank trace: not served on the student path yet
      item("quiz:q3", ["p1:s003"], { bank_item_id: ITEM_OFFMAP, availability: "unavailable" }), // uncertain mapping: never used
    ],
    retrieval: { fts: "none" },
    derived_by: { model: null, prompt_versions: [], at: new Date(T0).toISOString() },
  } as unknown as KitManifest;
}

const gen = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, title, kind: "presentation", status: "done", withdrawn_at: null, removed_at: null, owner_id: OWNER, ...over });
const map = (generation_id: string, chapter_ref: string, sort = 0, product_id = PRODUCT, label: string | null = null) => ({ product_id, chapter_ref, sort, generation_id, label });

/** The kit-map world: the founder-style staff grant for STUDENT, nothing for STRANGER. */
export function kitWorld(opts: { tutorDays?: number } = {}): FakeDb {
  const db = new FakeDb({}, () => T0);
  db.seed("sk_book_products", [
    { id: PRODUCT, slug: SLUG, status: "approved", title: "Cells" },
    { id: OTHER_PRODUCT, slug: "another-book", status: "approved", title: "Another" },
  ]);
  db.seed("sk_product_kits", [map(TRANSPORT, "8", 2), map(CELLS, "1", 0, PRODUCT, "Cells"), map(RESP, "8", 1), map(BLOOD, "8", 0), map(ELSEWHERE, "1", 0, OTHER_PRODUCT)]);
  db.seed("generations", [
    gen(CELLS, "Cells · Cells"),
    gen(BLOOD, "Blood and Its Components"),
    gen(RESP, "The Human Respiratory System"),
    gen(TRANSPORT, "Transport in Plants"),
    gen(UNMAPPED, "Not in the book"),
    gen(ELSEWHERE, "Another book's kit"),
  ]);
  db.seed("profiles", [
    { id: STUDENT, school_id: null },
    { id: STRANGER, school_id: null },
  ]);
  db.seed("book_access_grants", [
    {
      id: "7e3a2f4b-5c6d-4e7f-8a9b-0c1d2e3f4a5c",
      user_id: STUDENT,
      product_id: PRODUCT,
      source: "staff",
      activated_at: new Date(T0 - DAY).toISOString(),
      expires_at: null,
      tutor_expires_at: new Date(T0 + (opts.tutorDays ?? 365) * DAY).toISOString(),
      revoked_at: null,
      usage_allowance: null,
    },
  ]);
  db.seed("artifacts", [
    { id: "b0000000-0000-4000-8000-000000000001", generation_id: CELLS, kind: "video_mp4", storage_path: `${OWNER}/${CELLS}/lesson_part2.mp4`, created_at: new Date(T0).toISOString() },
    { id: "b0000000-0000-4000-8000-000000000002", generation_id: CELLS, kind: "video_mp4", storage_path: `${OWNER}/${CELLS}/lesson.mp4`, created_at: new Date(T0).toISOString() },
    { id: "b0000000-0000-4000-8000-000000000003", generation_id: CELLS, kind: "deck_pptx", storage_path: `${OWNER}/${CELLS}/deck.pptx`, created_at: new Date(T0).toISOString() },
  ]);
  db.seed("topic_questions", [
    { id: ITEM_MCQ, item_type: "mcq", marks: 1, stem: "What is the smallest unit of life?", options: [{ key: "a", text: "A cell" }, { key: "b", text: "An atom" }], answer: { key: "a" }, status: "approved", difficulty: 1, teaching_objective_id: null },
    { id: ITEM_TF, item_type: "true_false", marks: 1, stem: "Every living thing is made of cells.", options: null, answer: { value: true }, status: "approved", difficulty: 1, teaching_objective_id: null },
    { id: ITEM_OFFMAP, item_type: "true_false", marks: 1, stem: "Off the map.", options: null, answer: { value: false }, status: "approved", difficulty: 1, teaching_objective_id: null },
  ]);
  return db;
}
