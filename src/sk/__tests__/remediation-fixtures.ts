// SK S3 slice C — the remediation ladder's fixture, built from REAL production
// bank rows (Supabase pblaxsqhjwlqbrwbraxy, read by SELECT on 2026-10-29):
//
//   topic_articles  d3776bf8-1e1e-42e9-a493-4b1e55910db6
//                   "Specialised Cells and Tissues: Structure Fits Function"
//                   — the article of the Biology chapter 5 kit
//                   (generation 4885bc51-0e65-4252-bb41-88df6bcc28bc, 0170 seed);
//                   its misconceptions m1–m6 and objectives o1–o6, verbatim.
//   topic_questions 49919a9f-7d4a-48e3-9f1b-5672745933cf  (THE ladder item:
//                   approved mcq on o2 whose option A names misconception m2)
//                   824b968a-bef3-452d-8e6d-39f553e84c97  (fill_blank, o2)
//                   04fc9b19-f305-4a62-85c3-e2eae3ec559a  (assertion_reason, o2)
//                   2773b9b4-e0ee-4cd3-bba2-ab573598aefd  (short_answer, o2)
//                   549fd679-9118-4cf2-b57e-6ac5a0f43009  (mcq, o1, refs m1)
//                   — every field the app reads copied as stored.
//
// The KIT MAP is hand-built (production has no sk_manifests row for this kit
// yet: maps are built on first open, ~$0.005). It follows derive.ts: concepts
// = the article's objectives, items mapped by objective_ref (I1) to the
// sections whose concept is that objective.
//
// One synthetic row: UNMAPPED_ITEM, a true/false item with no article and no
// objective_ref (marked as such), for "unmapped → no mastery row".
import type { KitManifest, ManifestItem, ManifestSegment } from "../manifest/derive";
import type { FakeDb } from "./fake-supabase";
import { PRODUCT, T0, OWNER } from "./kit-fixtures";

export const CH5_KIT = "4885bc51-0e65-4252-bb41-88df6bcc28bc";
export const CH5_ARTICLE = "d3776bf8-1e1e-42e9-a493-4b1e55910db6";

export const RBC_MCQ = "49919a9f-7d4a-48e3-9f1b-5672745933cf";
export const RBC_FILL = "824b968a-bef3-452d-8e6d-39f553e84c97";
export const RBC_AR = "04fc9b19-f305-4a62-85c3-e2eae3ec559a";
export const RBC_SHORT = "2773b9b4-e0ee-4cd3-bba2-ab573598aefd";
export const GENES_MCQ = "549fd679-9118-4cf2-b57e-6ac5a0f43009";
export const UNMAPPED_ITEM = "c0ffee00-0000-4000-8000-0000000000aa"; // synthetic

export const O2_KEY = `${CH5_ARTICLE}:o2`;
export const O1_KEY = `${CH5_ARTICLE}:o1`;

export const CH5_ARTICLE_ROW = {
  id: CH5_ARTICLE,
  title: "Specialised Cells and Tissues: Structure Fits Function",
  objectives: [
    { id: "o1", text: "Explain why cells in a multicellular organism become specialised and describe differentiation." },
    { id: "o2", text: "Explain how the structure of a red blood cell is related to its function of carrying oxygen." },
    { id: "o3", text: "Explain how the structures of neurones and ciliated cells are related to their functions." },
    { id: "o4", text: "Explain how the structures of root hair cells and palisade cells are related to their functions." },
    { id: "o5", text: "Describe how groups of similar cells form tissues, and how tissues combine to form organs and organ systems." },
    { id: "o6", text: "Name the four types of animal tissue and the meristematic and permanent plant tissues, and state their functions." },
  ],
  misconceptions: [
    { id: "m1", correction: "Nearly all cells in an organism carry the same genes. Cells differ because different genes are switched on, so different proteins are made.", misconception: "Specialised cells are different because they contain different genes." },
    { id: "m2", correction: "Mature mammalian red blood cells have no nucleus. This leaves room for haemoglobin, and haemoglobin is what makes them red.", misconception: "Red blood cells have a nucleus like other cells and the nucleus makes them red." },
    { id: "m3", correction: "Ciliated cells in the airways stay in place in a lining. Their cilia beat to sweep mucus past the cell, not to move the cell.", misconception: "Cilia are the same as flagella and are used to swim through blood." },
    { id: "m4", correction: "A root hair is a long extension of a single living root cell. Its thin shape gives a large surface area for absorbing water and minerals.", misconception: "Root hair cells are hairs that cover a root like fur and are separate from the root." },
    { id: "m5", correction: "Their upright shape lets many cells pack close below the upper surface, where light is strongest, and gives light a clear path to many chloroplasts.", misconception: "Palisade cells are tall to make the leaf thicker." },
    { id: "m6", correction: "A tissue is a group of similar cells with one function. An organ contains several different tissues working together.", misconception: "A tissue and an organ are the same thing." },
  ],
};

const base = { status: "approved", teaching_objective_id: null, article_id: CH5_ARTICLE, source_item_id: null, created_at: "2026-10-25T08:26:46.570175+00:00" };

/** The production rows, as stored. */
export const CH5_BANK_ROWS = [
  {
    ...base,
    id: RBC_MCQ,
    objective_ref: "o2",
    item_type: "mcq",
    marks: 1,
    difficulty: 2,
    stem: "Why does the lack of a nucleus in a mature mammalian red blood cell help it to carry oxygen?",
    options: [
      { key: "A", text: "The nucleus would make the cell too red." },
      { key: "B", text: "More space is available for haemoglobin." },
      { key: "C", text: "The cell can then divide more quickly." },
      { key: "D", text: "The cell can then repair itself more easily." },
    ],
    answer: { key: "B" },
    distractor_rationale: {
      A: { why_wrong: "Believes the nucleus is involved in making the cell red, when haemoglobin gives the colour.", misconception_ref: "m2" },
      C: { why_wrong: "Believes red blood cells divide, but without a nucleus they cannot." },
      D: { why_wrong: "Believes red blood cells repair themselves, but without a nucleus they cannot." },
    },
    explanation: "Losing the nucleus frees internal space so more haemoglobin fits, and each cell carries more oxygen.",
  },
  {
    ...base,
    id: RBC_FILL,
    objective_ref: "o2",
    item_type: "fill_blank",
    marks: 1,
    difficulty: 1,
    stem: "The red protein in red blood cells that binds to oxygen in the lungs is called ____.",
    options: null,
    answer: { text: "haemoglobin" },
    distractor_rationale: null,
    explanation: "Haemoglobin binds oxygen in the lungs and releases it in the tissues.",
  },
  {
    ...base,
    id: RBC_AR,
    objective_ref: "o2",
    item_type: "assertion_reason",
    marks: 1,
    difficulty: 4,
    stem: "Assertion (A): The biconcave shape of a red blood cell helps oxygen to enter and leave quickly. Reason (R): The shape gives a large surface area compared with volume and a short distance to the centre of the cell.",
    options: [
      { key: "A", text: "Both A and R are true, and R explains A." },
      { key: "B", text: "Both A and R are true, but R does not explain A." },
      { key: "C", text: "A is true but R is false." },
      { key: "D", text: "A is false but R is true." },
    ],
    answer: { key: "A" },
    distractor_rationale: null,
    explanation: "The large surface area to volume ratio and short diffusion distance are exactly why oxygen exchange is rapid.",
  },
  {
    ...base,
    id: RBC_SHORT,
    objective_ref: "o2",
    item_type: "short_answer",
    marks: 3,
    difficulty: 3,
    stem: "A red blood cell is small and flexible. Explain how this helps it to carry out its function.",
    options: null,
    answer: { text: "Its function is to carry oxygen to respiring tissues. Being small and flexible, it can squeeze in single file through the narrowest capillaries. This brings oxygen close to body cells, so oxygen can be delivered to them." },
    distractor_rationale: null,
    explanation: "The size and flexibility allow access to the smallest capillaries next to cells.",
  },
  {
    ...base,
    id: GENES_MCQ,
    objective_ref: "o1",
    item_type: "mcq",
    marks: 1,
    difficulty: 2,
    stem: "A nerve cell and a muscle cell from the same person have very different shapes and functions. Which statement best explains why?",
    options: [
      { key: "A", text: "They contain different sets of genes." },
      { key: "B", text: "Different genes are switched on in each, so different proteins are made." },
      { key: "C", text: "The nerve cell has lost genes that the muscle cell kept." },
      { key: "D", text: "Only the muscle cell came from the zygote." },
    ],
    answer: { key: "B" },
    distractor_rationale: {
      A: { why_wrong: "Believes specialised cells differ because they hold different genes.", misconception_ref: "m1" },
      C: { why_wrong: "Believes genes are lost during specialisation, whereas nearly all cells keep the same genes.", misconception_ref: "m1" },
      D: { why_wrong: "Believes only some cells descend from the zygote, but all cells of the organism do." },
    },
    explanation: "Cells carry the same genes; differentiation switches different genes on and off, giving different proteins and structures.",
  },
  // SYNTHETIC: no article, no objective_ref — an unmapped bank item.
  { ...base, id: UNMAPPED_ITEM, article_id: null, objective_ref: null, item_type: "true_false", marks: 1, difficulty: 1, stem: "Every organ is made of tissues.", options: null, answer: { value: true }, distractor_rationale: null, explanation: null },
];

const seg = (k: number, sid: string, heading: string, concept: string | null, points: string[]): ManifestSegment => ({
  key: `p1:${sid}`,
  segment_id: sid,
  part: 1,
  k,
  start_s: k * 30,
  end_s: k * 30 + 30,
  slide_t: k * 30 + 28,
  slide_k: k,
  type: "lesson",
  heading,
  points,
  narration: `${heading}.`,
  concept_slug: null,
  assets: [],
  video_path: `${OWNER}/${CH5_KIT}/lesson.mp4`,
  concept: concept ? { concept_id: concept, secondary: [], method: "heading", confidence: 0.95, availability: "available" } : { concept_id: null, secondary: [], method: "none", confidence: 0, availability: "unavailable" },
  visual: { status: "distinct", show: "frame", reason: "new board", judged_by: { model: "m", prompt_version: "v" } },
});

const item = (q_id: string, bank: string, type: string, concept: string | null, segs: string[], over: Partial<ManifestItem> = {}): ManifestItem => ({
  q_id,
  source: "quiz",
  generation_id: CH5_KIT,
  type,
  prompt_hash: q_id,
  concept_ids: concept ? [concept] : [],
  segment_ids: segs,
  method: concept ? "objective_ref" : "model",
  confidence: 1,
  availability: "available",
  bank_item_id: bank,
  ...over,
});

/** The chapter 5 kit's map (hand-built after derive.ts; see the header). */
export function ch5Manifest(): KitManifest {
  const concepts = CH5_ARTICLE_ROW.objectives.map((o) => ({ concept_id: o.id, name: o.text, definition: o.text, segment_ids: [] as string[] }));
  return {
    schema: "sk-kit-manifest/m1",
    derivation_version: 2,
    manifest_id: "m-ch5",
    generation_id: CH5_KIT,
    book_id: null,
    chapter_ref: "5",
    article_id: CH5_ARTICLE,
    parts: [1],
    language: "en",
    format_version: 3,
    pinned: { script_ids: [], video_manifest_ids: [], format_version: 3, artifact_paths: [], artifacts_hash: "h" },
    completeness: { video: "ok", script: "ok", questions: "ok", concepts: "ok", format_version: 3 },
    moves: { intro: "available", segment: "available", slide: "available", practise: "available", walkthrough: "available", explain: "available", remediate: "available" },
    segments: [
      seg(0, "s001", "Why cells specialise", "o1", ["Cells carry the same genes", "Different genes are switched on"]),
      seg(1, "s002", "Red blood cells", "o2", ["No nucleus: more room for haemoglobin", "Biconcave disc: large surface area"]),
      seg(2, "s003", "Tissues and organs", "o5", ["Similar cells form a tissue", "Tissues form an organ"]),
    ],
    concepts,
    items: [
      item("quiz:q1", GENES_MCQ, "mcq", "o1", ["p1:s001"]),
      item("quiz:q2", RBC_MCQ, "mcq", "o2", ["p1:s002"]),
      item("quiz:q3", RBC_SHORT, "short_answer", "o2", ["p1:s002"]),
      item("quiz:q4", RBC_FILL, "fill_blank", "o2", ["p1:s002"]),
      item("quiz:q5", RBC_AR, "assertion_reason", "o2", ["p1:s002"]),
      item("quiz:q6", UNMAPPED_ITEM, "true_false", null, ["p1:s003"], { method: "model", confidence: 0.9 }),
    ],
    retrieval: { fts: "none" },
    derived_by: { model: null, prompt_versions: [], at: new Date(T0).toISOString() },
  } as unknown as KitManifest;
}

/** Add the chapter 5 kit, its article and its bank rows to a kitWorld(). */
export function seedCh5(db: FakeDb): FakeDb {
  db.seed("sk_product_kits", [{ product_id: PRODUCT, chapter_ref: "5", sort: 0, generation_id: CH5_KIT, label: "Specialised Cells and Tissues" }]);
  db.seed("generations", [{ id: CH5_KIT, title: "Specialised Cells and Tissues", kind: "presentation", status: "done", withdrawn_at: null, removed_at: null, owner_id: OWNER }]);
  db.seed("topic_articles", [CH5_ARTICLE_ROW]);
  db.seed("topic_questions", CH5_BANK_ROWS);
  return db;
}
