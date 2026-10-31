/**
 * Phase 4 — what SK reads for a learner: "how am I doing?" (tutor.progress)
 * answers from her WORKSHEET PRACTICE mastery when no kit player is open (the
 * student Board), reading her own rows through her session; and the FOCUS
 * concepts an approved plan set (readFocus + focusLine, for the turn route to
 * wire in).
 *
 * Run: node node_modules/vitest/vitest.mjs run src/sk/practice/__tests__/focus-progress.test.ts
 */
import { describe, expect, it } from "vitest";
import { makeCtx } from "@/sk/shell/__tests__/fixtures";
import { tutorProgress } from "@/sk/capabilities/tutor";
import type { SkCapabilityDeps } from "@/sk/shell/types";
import { focusLine, progressFromPractice, readFocus } from "../focus";
import { computeMastery } from "../mastery";
import { KIT, planDb, SESSION, STU, WS } from "./practice-db";

const NOW = new Date("2026-10-31T10:00:00Z");
const row = (o: Record<string, unknown>) => ({ session_id: SESSION, student_id: STU, generation_id: WS, question_type: "fill_blank", concept: null, kind: "answer", outcome: "correct", rung: "none", attempt_no: 1, created_at: "2026-10-30T10:00:00Z", ...o });

function practisedDb() {
  const db = planDb();
  db.seed("sk_practice_sessions", [{ id: SESSION, student_id: STU, kit_id: KIT }]);
  db.seed("sk_practice_concepts", [
    { generation_id: WS, question_id: "q1", question_hash: "a".repeat(64), concept_key: "c1", concept_name: "Pigments", method: "manifest", created_at: "2026-10-29T00:00:00Z" },
    { generation_id: WS, question_id: "q2", question_hash: "b".repeat(64), concept_key: "c1", concept_name: "Pigments", method: "manifest", created_at: "2026-10-29T00:00:00Z" },
    { generation_id: WS, question_id: "q3", question_hash: "c".repeat(64), concept_key: "c1", concept_name: "Pigments", method: "manifest", created_at: "2026-10-29T00:00:00Z" },
    { generation_id: WS, question_id: "q4", question_hash: "d".repeat(64), concept_key: "c2", concept_name: "Membranes", method: "model", created_at: "2026-10-29T00:00:00Z" },
    { generation_id: WS, question_id: "q5", question_hash: "e".repeat(64), concept_key: "c2", concept_name: "Membranes", method: "model", created_at: "2026-10-29T00:00:00Z" },
  ]);
  db.seed("sk_practice_attempts", [
    row({ question_id: "q1" }),
    row({ question_id: "q2" }),
    row({ question_id: "q3" }),
    row({ question_id: "q4", outcome: "incorrect", rung: "hint" }),
    row({ question_id: "q5", outcome: "incorrect", rung: "hint" }),
  ]);
  return db;
}

const deps = (session: unknown): SkCapabilityDeps => ({ session: session as SkCapabilityDeps["session"], now: NOW }) as SkCapabilityDeps;

describe("tutor.progress on the student Board (no kit player) → practice mastery", () => {
  it("names her secure ideas and the ones that need work, from her own rows", async () => {
    const ctx = makeCtx({ role: "student", hat: null, userId: STU, schoolId: null });
    ctx.board = { sessionId: "b1", generationId: KIT };
    const r = await tutorProgress.handler(ctx, {}, deps(practisedDb()));
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("Your progress on Cells: Mastered: Pigments. Needs work: Membranes.");
    expect(r.facts).toEqual([
      { idea: "Membranes", status: "learning", score: 0, questions: 2 },
      { idea: "Pigments", status: "secure", score: 100, questions: 3 },
    ]);
  });

  it("in her language, and the 'nothing yet' line when she has not practised", async () => {
    const ms = makeCtx({ role: "student", hat: null, userId: STU, schoolId: null, locale: "ms" });
    expect((await tutorProgress.handler(ms, {}, deps(practisedDb()))).summary).toMatch(/^Kemajuan anda dalam Cells: Dikuasai: Pigments\./);
    const none = await tutorProgress.handler(makeCtx({ role: "student", hat: null, userId: STU, schoolId: null }), {}, deps(planDb()));
    expect(none.summary).toMatch(/^You haven't answered any questions in this lesson yet/);
  });

  it("only HER rows: another student's attempts are never counted", async () => {
    const db = practisedDb();
    const other = "33333333-3333-4333-8333-333333333333";
    db.seed("sk_practice_attempts", [row({ student_id: other, question_id: "q4" }), row({ student_id: other, question_id: "q5" })]);
    const r = await tutorProgress.handler(makeCtx({ role: "student", hat: null, userId: STU, schoolId: null }), {}, deps(db));
    expect(r.summary).toContain("Needs work: Membranes");
  });

  it("a teacher without a kit player still gets the old no-kit line", async () => {
    const r = await tutorProgress.handler(makeCtx({ role: "teacher", hat: "teacher" }), {}, deps(practisedDb()));
    expect(r).toMatchObject({ ok: false, error: "no tutor" });
  });
});

describe("focus — what an approved plan asks SK to teach next", () => {
  it("reads her focus rows still in force, newest first, for the open kit", async () => {
    const db = planDb();
    db.seed("sk_learn_focus", [
      { student_id: STU, kit_id: KIT, concept_key: "c1", concept_name: "Pigments", until: "2026-11-10T00:00:00Z", created_at: "2026-10-31T09:00:00Z" },
      { student_id: STU, kit_id: KIT, concept_key: "c0", concept_name: "Old idea", until: "2026-10-01T00:00:00Z", created_at: "2026-09-17T00:00:00Z" },
      { student_id: STU, kit_id: WS, concept_key: "c9", concept_name: "Elsewhere", until: "2026-11-10T00:00:00Z", created_at: "2026-10-31T09:00:00Z" },
    ]);
    const rows = await readFocus(db, STU, { kitId: KIT, now: NOW.getTime() });
    expect(rows.map((r) => r.name)).toEqual(["Pigments"]);
    expect((await readFocus(db, STU, { now: NOW.getTime() })).map((r) => r.name).sort()).toEqual(["Elsewhere", "Pigments"]);
  });
  it("one rules line for SK (empty when there is no focus)", () => {
    expect(focusLine([])).toBe("");
    const line = focusLine([{ kitId: KIT, key: "c1", name: "Pigments", until: "" }, { kitId: KIT, key: "c2", name: "Membranes", until: "" }]);
    expect(line).toMatch(/^S6\. FOCUS/);
    expect(line).toContain("Pigments; Membranes");
    expect(line).toMatch(/Never say she is weak/);
  });
  it("progressFromPractice groups names by band", () => {
    const rows = computeMastery({
      attempts: [row({ question_id: "q1" })] as never,
      sessionKit: new Map([[SESSION, KIT]]),
      tags: new Map([[`${WS}:q1`, { key: "c1", name: "Pigments" }]]),
      kitName: () => "Cells",
      now: NOW.getTime(),
    });
    expect(progressFromPractice(rows)).toMatchObject({ secure: [], learning: [], fresh: ["Pigments"], counts: { new: 1, learning: 0, secure: 0 } });
  });
});
