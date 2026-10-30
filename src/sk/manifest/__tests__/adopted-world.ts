// An adopted catalogue kit's world for the manifest and adopt suites (not a
// test file): the catalogue source (lesson, worksheet, deck), two teachers'
// copies over the SAME files, the topic kit and its article. A copy's params
// carry only its lineage, as adopt_catalogue_piece / adopt_product_kit stamp it.
import { FakeAdmin, type Row } from "./fake-admin";
import type { ModelCall } from "../service";

export const CAT = "c0000000-0000-4000-8000-000000000000"; // the catalogue system account
export const SRC = "5a000000-0000-4000-8000-000000000001"; // the catalogue kit's lesson
export const SRC_WS = "5a000000-0000-4000-8000-000000000002"; // its worksheet
export const SRC_DECK = "5a000000-0000-4000-8000-000000000003"; // its deck
export const TK = "7c000000-0000-4000-8000-000000000001"; // topic_kits.id
export const ART = "a7000000-0000-4000-8000-000000000001";
export const ANNE = "a0000000-0000-4000-8000-00000000000a";
export const BEN = "b0000000-0000-4000-8000-00000000000b";
export const A_GEN = "a1000000-0000-4000-8000-000000000001";
export const A_WS = "a1000000-0000-4000-8000-000000000002";
export const B_GEN = "b1000000-0000-4000-8000-000000000001";
export const B_WS = "b1000000-0000-4000-8000-000000000002";
export const NOW = new Date("2026-10-31T10:00:00.000Z");

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

export const SCRIPT = JSON.stringify({
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
export const QUESTIONS = JSON.stringify({ questions: [{ id: "q1", type: "short", prompt: "What is rigid?", answer: "the wall" }, { id: "q2", type: "short", prompt: "What stores sap?", answer: "vacuole" }] });

export function world() {
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
export const model: ModelCall = async (req) => {
  const items = req.user.includes("QUESTIONS:");
  const q = /ws:[0-9a-f]{8}:q\d/g;
  const ids = Array.from(new Set(req.user.match(q) ?? []));
  const text = items
    ? JSON.stringify({ items: ids.map((id, i) => ({ q: id, concepts: [i === 0 ? "o1" : "o2"], segments: [i === 0 ? "p1:s002" : "p1:s003"], confidence: 0.95, reason: "r" })) })
    : JSON.stringify({ assignments: [{ segment: "p1:s001", primary: null, secondary: [], confidence: 0.9, reason: "hook" }, { segment: "p1:s003", primary: "o2", secondary: [], confidence: 0.93, reason: "sap" }] });
  return { text, usage: { input_tokens: 1500, output_tokens: 300 } };
};
