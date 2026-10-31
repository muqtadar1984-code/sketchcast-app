// Worksheet practice tests — the 0178 tables as the schema-aware FakeDb
// (src/sk/__tests__/fake-supabase.ts, SK B5) knows them: column types, NOT
// NULL, CHECKs, UNIQUE and foreign keys, so a row the real table would refuse
// fails here too. Not a *.test.ts file: a fixture beside the suites.

import { FakeDb, type TableSpec } from "@/sk/__tests__/fake-supabase";
import type { DbRow } from "@/sk/store-supabase";

const QTYPES = ["fill_blank", "short", "true_false", "match", "mcq", "subjective"] as const;
const now = () => new Date().toISOString();

export const PRACTICE_SPECS: Record<string, TableSpec> = {
  profiles: { columns: { id: { type: "uuid", notNull: true } } },
  generations: { columns: { id: { type: "uuid", notNull: true } } },
  sk_practice_sessions: {
    strictColumns: true,
    unique: [{ cols: ["id"] }],
    columns: {
      id: { type: "uuid", notNull: true },
      student_id: { type: "uuid", notNull: true, references: { table: "profiles" } },
      kit_id: { type: "uuid", notNull: true, references: { table: "generations" } },
      started_at: { type: "timestamptz", notNull: true, default: now },
      last_at: { type: "timestamptz", notNull: true, default: now },
    },
  },
  sk_practice_attempts: {
    strictColumns: true,
    unique: [{ cols: ["session_id", "generation_id", "question_id", "attempt_no"] }],
    columns: {
      id: { type: "uuid", notNull: true, default: () => crypto.randomUUID() },
      session_id: { type: "uuid", notNull: true, references: { table: "sk_practice_sessions" } },
      student_id: { type: "uuid", notNull: true, references: { table: "profiles" } },
      generation_id: { type: "uuid", notNull: true, references: { table: "generations" } },
      question_id: { type: "text", notNull: true, check: (v) => String(v).length >= 1 && String(v).length <= 80 },
      question_type: { type: "text", notNull: true, in: QTYPES },
      concept: { type: "text", check: (v) => String(v).length >= 1 && String(v).length <= 200 },
      kind: { type: "text", notNull: true, in: ["answer", "help"] },
      answer: { type: "jsonb" },
      outcome: { type: "text", notNull: true, in: ["correct", "incorrect", "review", "help"] },
      correct: { type: "bool", notNull: true, default: () => false },
      attempt_no: { type: "int", notNull: true, check: (v) => Number(v) >= 1 },
      rung: { type: "text", notNull: true, default: () => "none", in: ["none", "hint", "step", "answer"] },
      hints_used: { type: "int", notNull: true, default: () => 0, check: (v) => Number(v) >= 0 },
      time_ms: { type: "int", check: (v) => Number(v) >= 0 && Number(v) <= 3_600_000 },
      created_at: { type: "timestamptz", notNull: true, default: now },
    },
    checks: {
      correct_is_outcome: (r: DbRow) => r.correct === (r.outcome === "correct"),
      help_has_no_answer: (r: DbRow) => r.kind === "answer" || (r.answer == null && r.outcome === "help"),
      answer_is_not_help: (r: DbRow) => r.kind === "help" || r.outcome !== "help",
    },
  },
  sk_practice_help: {
    strictColumns: true,
    unique: [{ cols: ["generation_id", "question_id", "question_hash", "rung"] }],
    columns: {
      generation_id: { type: "uuid", notNull: true, references: { table: "generations" } },
      question_id: { type: "text", notNull: true },
      question_hash: { type: "text", notNull: true, check: (v) => String(v).length === 64 },
      rung: { type: "text", notNull: true, in: ["hint", "step", "answer"] },
      body: { type: "text", notNull: true, check: (v) => String(v).length >= 1 && String(v).length <= 2000 },
      model: { type: "text", notNull: true },
      cost_usd: { type: "numeric", notNull: true, default: () => 0, check: (v) => Number(v) >= 0 },
      created_at: { type: "timestamptz", notNull: true, default: now },
    },
  },
};

export const STU = "22222222-2222-4222-8222-222222222222";
export const STU2 = "33333333-3333-4333-8333-333333333333";
export const KIT = "11111111-1111-4111-8111-111111111111";
export const WS = "44444444-4444-4444-8444-444444444444";
export const SESSION = "55555555-5555-4555-8555-555555555555";
export const SESSION2 = "66666666-6666-4666-8666-666666666666";

export function practiceDb(): FakeDb {
  const db = new FakeDb(PRACTICE_SPECS);
  db.seed("profiles", [{ id: STU }, { id: STU2 }]);
  db.seed("generations", [{ id: KIT }, { id: WS }]);
  return db;
}

/** A worksheet's questions.json, key included (what loadQuizArtifact returns). */
export const PAPER = {
  title: "Cells",
  instructions: "Answer every question.",
  questions: [
    { id: "q1", type: "fill_blank", prompt: "The green pigment in leaves is ____.", answer: "Chlorophyll", marks: 1 },
    { id: "q2", type: "true_false", prompt: "Animal cells have a cell wall.", answer: false, marks: 1 },
    { id: "q3", type: "mcq", prompt: "Which organelle releases energy?", options: ["Nucleus", "Mitochondrion", "Vacuole"], answer: "Mitochondrion", marks: 1, concept: "cell organelles", hint: "Think about respiration." },
    { id: "q4", type: "match", prompt: "Match each part to its job.", pairs: [{ left: "Nucleus", right: "controls the cell" }, { left: "Membrane", right: "lets substances in and out" }], marks: 2 },
    { id: "q5", type: "short", prompt: "What is 22 divided by 7, to 2 decimal places?", answer: "3.142857", marks: 1 },
    { id: "q6", type: "subjective", prompt: "Explain why plants need light.", answer_outline: "Light energy drives photosynthesis, making glucose.", marks: 3 },
  ],
};
