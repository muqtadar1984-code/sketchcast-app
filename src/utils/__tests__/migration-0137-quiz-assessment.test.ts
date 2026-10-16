/**
 * Parse-check for supabase/migrations/0137_public_catalogue_quiz_assessment.sql
 * (catalogue Phase D part 2 follow-up): public_catalogue().has_online_assessment
 * must be true when EITHER the kit's 'worksheet' OR its 'quiz' generation
 * (doc_generation_ids keys) has an artifacts row of kind 'questions_json'.
 * Everything else — the signature, every other column, the joins — must be
 * 0131's body verbatim, and the rollback file must BE 0131's body verbatim.
 * Run: npx vitest run src/utils/__tests__/migration-0137-quiz-assessment.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIG = path.resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIG, f), "utf-8").replace(/\r\n/g, "\n");
const PREV = read("0131_public_catalogue_strand.sql");
const M = read("0137_public_catalogue_quiz_assessment.sql");
const R = read("0137_public_catalogue_quiz_assessment_rollback.sql");

/** The function definition alone: from `create or replace` to the end of the file. */
const fn = (sql: string) => {
  const a = sql.indexOf("create or replace function public.public_catalogue()");
  expect(a, "missing public_catalogue definition").toBeGreaterThan(-1);
  return sql.slice(a).trim();
};

const WORKSHEET = "nullif(coalesce(k.doc_generation_ids, '{}'::jsonb) ->> 'worksheet', '')::uuid";
const QUIZ = "nullif(coalesce(k.doc_generation_ids, '{}'::jsonb) ->> 'quiz', '')::uuid";

describe("0137 — has_online_assessment keys on the worksheet OR the online quiz", () => {
  it("defines exactly one function, public_catalogue(), with 0131's signature", () => {
    expect(M.match(/create or replace function/g)?.length).toBe(1);
    const sig = (sql: string) => fn(sql).slice(0, fn(sql).indexOf("as $$"));
    expect(sig(M)).toBe(sig(PREV));
    expect(sig(M)).toContain("has_online_assessment boolean");
    expect(sig(M)).toMatch(/security definer\s+set search_path = public/);
  });

  it("the flag is an EXISTS over artifacts of kind questions_json for the worksheet OR the quiz generation", () => {
    const clause = fn(M).slice(fn(M).indexOf("    exists ("), fn(M).indexOf("t.bank_maturity = 'exam_ready'"));
    expect(clause).toContain("from artifacts ar");
    expect(clause).toContain("ar.kind = 'questions_json'");
    expect(clause).toMatch(/ar\.generation_id in \(\s*nullif\(coalesce\(k\.doc_generation_ids, '\{\}'::jsonb\) ->> 'worksheet', ''\)::uuid,\s*nullif\(coalesce\(k\.doc_generation_ids, '\{\}'::jsonb\) ->> 'quiz', ''\)::uuid\)/);
    expect(clause).toContain(WORKSHEET);
    expect(clause).toContain(QUIZ);
    // the old single-key equality is gone
    expect(clause).not.toContain("ar.generation_id = ");
  });

  it("changes nothing else: the body equals 0131's once the 0131 clause is rewritten", () => {
    const old = `      where ar.generation_id = ${WORKSHEET}\n`;
    const nu = `      where ar.generation_id in (\n              ${WORKSHEET},\n              ${QUIZ})\n`;
    expect(fn(PREV)).toContain(old);
    expect(fn(PREV).replace(old, nu)).toBe(fn(M));
  });

  it("the rollback restores 0131's body verbatim (worksheet only)", () => {
    expect(fn(R)).toBe(fn(PREV));
    expect(fn(R)).not.toContain("'quiz'");
  });

  it("is a function replacement only: no table, index, policy or data change", () => {
    for (const sql of [M, R]) {
      expect(sql).not.toMatch(/\b(create|alter|drop)\s+(table|type|policy|index|view|trigger)\b/i);
      expect(sql).not.toMatch(/\b(insert|update|delete)\s+(into|public\.|from)\b/i);
    }
  });
});
