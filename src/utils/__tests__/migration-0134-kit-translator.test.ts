/**
 * Parse-check for supabase/migrations/0134_kit_translator.sql (the Kit
 * Translator, plan revision 3, T0). What must hold:
 *  • topic_kits gains translation_status / translation / precheck /
 *    supersede_reason, each with its check list, and nothing else changes
 *    on the kit row;
 *  • `staged` joins the article and item status lists (R2) and the two
 *    constraints are REPLACED (drop + add), never a second check beside the
 *    old one that would still refuse 'staged';
 *  • items carry source_item_id and translation_kit_id, unique per (source
 *    item, translation kit) so a retranslation stages beside the live set
 *    (revision 3);
 *  • the glossary table is keyed (language, subject, sense), RLS on, nothing
 *    granted to anon/authenticated;
 *  • one live kit_translate per (source kit, language), the 0114/0115/0116
 *    partial-unique-index pattern, keyed exactly as translate-job.ts
 *    pre-checks;
 *  • approve_topic_kit's translation branch verifies the video and deck
 *    ARTIFACTS exist before any flip (storage first, then one transaction),
 *    promotes the staged article and items, never touches topics.status, and
 *    audits as library_kit_translation_approve; the English branch keeps
 *    0115's topic → video_approved move; reject's translation branch likewise
 *    leaves the topic alone;
 *  • catalogue_current_kits keeps the YouTube clause for English and admits a
 *    translation on translation_status approved/stale only (D5);
 *  • a rollback file restores 0115/0128 verbatim.
 * Run: npx vitest run src/utils/__tests__/migration-0134-kit-translator.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIG = path.resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIG, f), "utf-8").replace(/\r\n/g, "\n");
const M = read("0134_kit_translator.sql");
const R = read("0134_kit_translator_rollback.sql");

/** Comment-stripped DDL only. */
const code = M.split("\n")
  .map((l) => l.replace(/--.*$/, "").trimEnd())
  .filter((l) => l.trim() !== "")
  .join("\n");

const between = (text: string, start: string, end: string) => {
  const a = text.indexOf(start);
  expect(a, `missing ${start}`).toBeGreaterThan(-1);
  const b = text.indexOf(end, a + start.length);
  return b === -1 ? text.slice(a) : text.slice(a, b);
};

const APPROVE = between(code, "create or replace function public.approve_topic_kit", "revoke execute on function public.approve_topic_kit");
const REJECT = between(code, "create or replace function public.reject_topic_kit", "revoke execute on function public.reject_topic_kit");
const CURRENT = between(code, "create or replace function public.catalogue_current_kits", "comment on function public.catalogue_current_kits");
const TRANSLATE_JOB = readFileSync(path.resolve(__dirname, "..", "..", "app", "api", "library", "topics", "[id]", "kit", "translate-job.ts"), "utf-8");

describe("0134 — the Kit Translator", () => {
  it("is one transaction", () => {
    expect(code.trim().startsWith("begin;")).toBe(true);
    expect(code.trim().endsWith("commit;")).toBe(true);
  });

  it("adds the four translation columns to topic_kits with their check lists", () => {
    for (const col of ["translation_status text", "translation       jsonb", "precheck          jsonb", "supersede_reason  text"]) expect(code).toContain(col);
    expect(code).toMatch(/translation_status in \('staged','in_review','approved','stale','blocked','failed'\)/);
    expect(code).toMatch(/supersede_reason in \('cosmetic','correction'\)/);
    expect(code).toContain("create index if not exists topic_kits_translations_idx");
  });

  it("REPLACES the article and item status constraints with the superset that has 'staged'", () => {
    expect(code).toContain("alter table public.topic_articles drop constraint if exists topic_articles_status_check");
    expect(code).toMatch(/topic_articles_status_check\s+check \(status in \('draft','staged','in_review','approved','superseded','rejected'\)\)/);
    expect(code).toContain("alter table public.topic_questions drop constraint if exists topic_questions_status_check");
    expect(code).toMatch(/topic_questions_status_check\s+check \(status in \('draft','staged','approved','rejected','retired'\)\)/);
  });

  it("gives items their source and their translation kit, unique per pair", () => {
    expect(code).toContain("source_item_id     uuid references public.topic_questions(id) on delete set null");
    expect(code).toContain("translation_kit_id uuid references public.topic_kits(id) on delete set null");
    expect(code).toMatch(/create unique index if not exists topic_questions_translation_uniq\s+on public\.topic_questions \(source_item_id, translation_kit_id\)\s+where source_item_id is not null and translation_kit_id is not null/);
  });

  it("creates the glossary keyed by sense, RLS on, nothing granted to clients", () => {
    const g = between(code, "create table if not exists public.topic_term_translations", "drop trigger");
    expect(g).toContain("unique (language, subject, sense)");
    expect(g).toMatch(/source\s+text not null default 'model' check \(source in \('model','reviewer'\)\)/);
    expect(code).toContain("alter table public.topic_term_translations enable row level security");
    expect(code).toContain("revoke all on public.topic_term_translations from anon, authenticated");
    expect(code).not.toMatch(/grant .* on public\.topic_term_translations/);
  });

  it("enforces one live kit_translate per (source kit, language), keyed as translate-job.ts pre-checks", () => {
    expect(code).toMatch(/create unique index if not exists jobs_one_live_translate\s+on public\.jobs \(\(params->>'source_kit_id'\), \(params->>'language'\)\)\s+where type = 'kit_translate' and status in \('queued', 'processing'\)/);
    expect(TRANSLATE_JOB).toMatch(/\.eq\("params->>source_kit_id", opts\.sourceKitId\)/);
    expect(TRANSLATE_JOB).toMatch(/\.eq\("params->>language", opts\.language\)/);
    expect(TRANSLATE_JOB).toMatch(/type:\s*TRANSLATE_JOB_TYPE/);
    expect(TRANSLATE_JOB).toMatch(/const TRANSLATE_JOB_TYPE = "kit_translate"/);
  });

  it("approve: the translation branch checks the artifacts BEFORE the flip, promotes the staged set, never moves the topic, and audits", () => {
    // `code` has no blank lines (comment-stripped), so the English branch
    // starts right after the translation branch's `end if;`
    const branch = between(APPROVE, "if k.translation_status is not null then", "end if;\n  select status into t_status");
    expect(branch).toContain("a.kind = 'video_mp4'");
    expect(branch).toContain("a.kind = 'deck_pptx'");
    // the checks come before any update
    expect(branch.indexOf("a.kind = 'video_mp4'")).toBeLessThan(branch.indexOf("update topic_articles"));
    expect(branch).toMatch(/update topic_articles\s+set status = 'approved'/);
    expect(branch).toMatch(/update topic_questions set status = 'approved'\s+where translation_kit_id = k\.id and status = 'staged'/);
    expect(branch).toMatch(/update topic_kits\s+set status = 'approved', translation_status = 'approved'/);
    expect(branch).not.toMatch(/update topics\b/);
    expect(branch).toContain("'library_kit_translation_approve'");
    // the previous translation steps aside
    expect(branch).toMatch(/update topic_kits set translation_status = 'stale'/);
    expect(branch).toMatch(/update topic_questions set status = 'retired'/);
  });

  it("approve: the English branch is 0115's — topic in_review → video_approved, approved article required", () => {
    const english = APPROVE.slice(APPROVE.indexOf("select status into t_status from topics where id = k.topic_id for update;\n  if t_status is distinct from 'in_review'"));
    expect(english).toContain("update topics set status = 'video_approved'");
    expect(english).toContain("if a_status is distinct from 'approved' then");
    expect(english).toContain("'library_kit_approve'");
  });

  it("reject: the translation branch rejects the article, retires the items, fails the translation and leaves the topic", () => {
    const branch = between(REJECT, "if k.translation_status is not null then", "end if;\n  select status into t_status");
    expect(branch).toMatch(/update topic_articles set status = 'rejected'/);
    expect(branch).toMatch(/update topic_questions set status = 'retired'/);
    expect(branch).toMatch(/status = 'rejected', translation_status = 'failed'/);
    expect(branch).not.toMatch(/update topics\b/);
    expect(branch).toContain("'library_kit_translation_reject'");
    const english = REJECT.slice(REJECT.indexOf("select status into t_status from topics"));
    expect(english).toContain("update topics set status = 'in_review'");
  });

  it("current kits: YouTube for English, translation_status approved/stale for a translation, blocked hidden", () => {
    expect(CURRENT).toMatch(/k\.language = 'en' and exists \(/);
    expect(CURRENT).toContain("p.privacy = 'public'");
    expect(CURRENT).toMatch(/k\.language <> 'en' and coalesce\(k\.translation_status, 'approved'\) in \('approved', 'stale'\)/);
    expect(CURRENT).not.toContain("'blocked'");
    expect(CURRENT).toContain("t.bank_maturity <> 'none'");
  });

  it("only the two RPCs write 'approved' on a kit, an article or an item", () => {
    const outside = code.replace(APPROVE, "").replace(REJECT, "");
    expect(outside).not.toMatch(/set status = 'approved'/);
    expect(outside).not.toMatch(/translation_status = 'approved'/);
  });

  it("the rollback restores 0115's RPCs and 0128's rule", () => {
    expect(R).toContain("drop table if exists public.topic_term_translations");
    expect(R).toContain("drop index if exists public.jobs_one_live_translate");
    expect(R).toMatch(/check \(status in \('draft','approved','rejected','retired'\)\)/);
    expect(R).toMatch(/check \(status in \('draft','in_review','approved','superseded','rejected'\)\)/);
    expect(R).toContain("update topics set status = 'video_approved'");
    expect(R).not.toContain("translation_status is not null");
    const cur = between(R, "create or replace function public.catalogue_current_kits", "commit;");
    expect(cur).not.toContain("k.language <> 'en'");
  });
});
