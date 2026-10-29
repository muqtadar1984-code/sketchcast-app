// 0174 (written 2026-10-30, dry-run on production inside a transaction that
// was aborted, NOT applied) — SK S7 slice K1: the knowledge blocks, the
// product → release link, the import log, the importers' writer and the
// language-aware search. Same lint pattern as migration-0173: read the SQL,
// strip comments, assert the DDL the access and safety rules rest on.
// Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/migration-0174-sk-knowledge-blocks.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const DIR = path.resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) =>
  readFileSync(path.join(DIR, f), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/--[^\n]*/g, "")
    .replace(/[ \t]+/g, " ")
    .toLowerCase();

const up = read("0174_sk_knowledge_blocks.sql");
const down = read("0174_sk_knowledge_blocks_rollback.sql");

/** The body of one `create or replace function public.<name>(…) … $$;`. */
function fn(name: string): string {
  const start = up.indexOf(`create or replace function public.${name}(`);
  expect(start, `function ${name}`).toBeGreaterThan(-1);
  const end = up.indexOf("$$;", up.indexOf("$$", start) + 2);
  return up.slice(start, end + 3);
}

describe("0174_sk_knowledge_blocks.sql", () => {
  it("is one transaction", () => {
    expect(up.trim().startsWith("begin;")).toBe(true);
    expect(up.trim().endsWith("commit;")).toBe(true);
  });

  it("sk_ts_config: IMMUTABLE, en/ar/fr/es/pt stemming, everything else simple", () => {
    const f = fn("sk_ts_config");
    expect(f).toMatch(/\(lang text\)\s+returns regconfig\s+language sql\s+immutable/);
    expect(f).toMatch(/set search_path = pg_catalog/);
    expect(f).toMatch(/split_part\(coalesce\(lang, ''\), '-', 1\)/); // 'ms-arab' → 'ms'
    for (const [code, cfg] of [["en", "english"], ["ar", "arabic"], ["fr", "french"], ["es", "spanish"], ["pt", "portuguese"]]) {
      expect(f).toContain(`when '${code}' then 'pg_catalog.${cfg}'::regconfig`);
    }
    expect(f).toMatch(/else 'pg_catalog\.simple'::regconfig/);
  });

  it("sk_knowledge_blocks: closed source kinds and block kinds, 8000-char cap, tsv generated from the block's language", () => {
    expect(up).toMatch(/create table if not exists public\.sk_knowledge_blocks \(/);
    expect(up).toMatch(/id bigserial primary key/);
    expect(up).toMatch(/source_kind text not null check \(source_kind in \('sketchcast_book', 'article', 'user_book'\)\)/);
    expect(up).toMatch(/kind text not null check \(kind in \('section', 'exercise_stem', 'paragraph', 'glossary', 'misconception', 'worked_example'\)\)/);
    expect(up).toMatch(/text text not null check \(length\(text\) between 1 and 8000\)/);
    expect(up).toMatch(/release_id bigint,/);
    expect(up).toMatch(/chapter int,/);
    expect(up).toMatch(/tsv tsvector generated always as \(/);
    expect(up).toMatch(/to_tsvector\(public\.sk_ts_config\(language\), coalesce\(title, ''\)\)/);
    expect(up).toMatch(/to_tsvector\(public\.sk_ts_config\(language\), text\)/);
    expect(up).toMatch(/\) stored,/);
  });

  it("indexes: GIN on tsv, btree on (kind, id, version) and (kind, id, chapter), one block per anchor", () => {
    expect(up).toMatch(/on public\.sk_knowledge_blocks using gin \(tsv\)/);
    expect(up).toMatch(/on public\.sk_knowledge_blocks \(source_kind, source_id, version\)/);
    expect(up).toMatch(/on public\.sk_knowledge_blocks \(source_kind, source_id, chapter\)/);
    expect(up).toMatch(/create unique index if not exists sk_knowledge_blocks_anchor_uq\s+on public\.sk_knowledge_blocks \(source_kind, source_id, language, version, chapter, kind, anchor\) nulls not distinct/);
  });

  it("blocks and the import log are service role only: RLS on, no policies, nothing granted to clients", () => {
    for (const t of ["sk_knowledge_blocks", "sk_release_imports"]) {
      expect(up).toMatch(new RegExp(`alter table public\\.${t} enable row level security;`));
      expect(up).toMatch(new RegExp(`revoke all on public\\.${t} from anon, authenticated;`));
      expect(up).not.toMatch(new RegExp(`create policy[^;]*on public\\.${t}`));
      expect(up).not.toMatch(new RegExp(`grant [^;]* on public\\.${t} to`));
    }
    expect(up).not.toMatch(/to (anon|authenticated)\s*;/);
  });

  it("sk_book_products gains the release link (nullable), one product per (work_uid, language), existing rows untouched", () => {
    for (const c of ["work_uid text", "language text", "release_id bigint", "edition_key text", "cover_key text"]) {
      expect(up).toContain(`alter table public.sk_book_products add column if not exists ${c}`);
    }
    expect(up).toMatch(/add column if not exists release_kind text check \(release_kind in \('final', 'draft'\)\)/);
    expect(up).not.toMatch(/add column[^;]*not null/);
    expect(up).toMatch(/create unique index if not exists sk_book_products_work_language_uq\s+on public\.sk_book_products \(work_uid, language\) where work_uid is not null;/);
    expect(up).not.toMatch(/update public\.sk_book_products/);
  });

  it("sk_release_imports: one row per release, closed status set", () => {
    expect(up).toMatch(/release_id bigint primary key/);
    expect(up).toMatch(/status text not null check \(status in \('ok', 'error', 'skipped'\)\)/);
    expect(up).toMatch(/blocks int not null default 0/);
  });

  it("never writes or references the book app's pub_* tables", () => {
    expect(up).not.toMatch(/pub_[a-z_]+/);
  });

  it("sk_knowledge_replace: one transaction, deletes the scopes then inserts, refuses blocks outside the scopes", () => {
    const f = fn("sk_knowledge_replace");
    expect(f).toMatch(/\(p_scopes jsonb, p_blocks jsonb\)\s+returns jsonb/);
    expect(f).toMatch(/security definer\s+set search_path = public, pg_temp/);
    expect(f).toMatch(/outside the given scopes/);
    expect(f.indexOf("delete from public.sk_knowledge_blocks")).toBeLessThan(f.indexOf("insert into public.sk_knowledge_blocks"));
    expect(up).toMatch(/revoke all on function public\.sk_knowledge_replace\(jsonb, jsonb\) from public, anon, authenticated;/);
    expect(up).toMatch(/grant execute on function public\.sk_knowledge_replace\(jsonb, jsonb\) to service_role;/);
  });

  it("sk_knowledge_prune: superseded/unapproved articles and removed/deleted books only", () => {
    const f = fn("sk_knowledge_prune");
    expect(f).toMatch(/a\.status = 'approved'/);
    expect(f).toMatch(/n\.status = 'approved' and n\.version > a\.version/);
    expect(f).toMatch(/b\.removed_at is null/);
    expect(f).not.toMatch(/sketchcast_book/); // release blocks are the release importer's business
    expect(up).toMatch(/grant execute on function public\.sk_knowledge_prune\(\) to service_role;/);
  });

  it("sk_search_knowledge: websearch_to_tsquery in the caller's language over ONLY the passed sources, ≤ 600-char snippets", () => {
    const f = fn("sk_search_knowledge");
    expect(f).toMatch(/p_query text,\s*p_lang text,\s*p_sources jsonb,\s*p_chapter int default null,\s*p_limit int default 8/);
    expect(f).toMatch(/returns table \(id bigint, source_kind text, source_id text, version text, chapter int, anchor text, title text, text text, rank real\)/);
    expect(f).toMatch(/security definer\s+set search_path = public, pg_temp/);
    expect(f).toMatch(/websearch_to_tsquery\(public\.sk_ts_config\(p_lang\), coalesce\(p_query, ''\)\)/);
    expect(f).toMatch(/src\.kind = k\.source_kind/);
    expect(f).toMatch(/\(src\.sid is null or src\.sid = k\.source_id\)/);
    expect(f).toMatch(/\(src\.ver is null or src\.ver = k\.version\)/);
    // only an article may be listed without an id
    expect(f).toMatch(/\(nullif\(s->>'id', ''\) is not null or s->>'kind' = 'article'\)/);
    expect(f).toMatch(/\(p_chapter is null or k\.chapter = p_chapter\)/);
    expect(f).toMatch(/left\(ts_headline\(/);
    expect(f).toMatch(/, 600\) as text/);
    expect(f).toMatch(/limit least\(greatest\(coalesce\(p_limit, 8\), 1\), 50\)/);
    expect(up).toMatch(/revoke all on function public\.sk_search_knowledge\(text, text, jsonb, int, int\) from public, anon, authenticated;/);
    expect(up).toMatch(/grant execute on function public\.sk_search_knowledge\(text, text, jsonb, int, int\) to service_role;/);
  });

  it("every SECURITY DEFINER function pins its search_path and is executable by service_role only", () => {
    const definers = up.match(/security definer/g)?.length ?? 0;
    expect(definers).toBe(4);
    expect(up.match(/security definer\s+set search_path = public, pg_temp/g)?.length).toBe(definers);
    expect(up.match(/grant execute on function [^;]* to service_role;/g)?.length).toBe(definers);
    expect(up).not.toMatch(/grant execute on function [^;]* to (anon|authenticated|public)/);
  });

  it("has a rollback that drops exactly what 0174 created", () => {
    expect(down.trim().startsWith("begin;")).toBe(true);
    expect(down.trim().endsWith("commit;")).toBe(true);
    for (const s of [
      "drop function if exists public.sk_search_knowledge(text, text, jsonb, int, int);",
      "drop function if exists public.sk_knowledge_prune();",
      "drop function if exists public.sk_knowledge_versions(text);",
      "drop function if exists public.sk_knowledge_replace(jsonb, jsonb);",
      "drop table if exists public.sk_release_imports;",
      "drop table if exists public.sk_knowledge_blocks;",
      "drop index if exists public.sk_book_products_work_language_uq;",
      "drop function if exists public.sk_ts_config(text);",
    ]) expect(down).toContain(s);
    for (const c of ["work_uid", "language", "release_id", "edition_key", "release_kind", "cover_key"]) {
      expect(down).toContain(`alter table public.sk_book_products drop column if exists ${c};`);
    }
    // the table drop comes before the function its generated column calls
    expect(down.indexOf("drop table if exists public.sk_knowledge_blocks")).toBeLessThan(down.indexOf("drop function if exists public.sk_ts_config"));
    expect(down).not.toMatch(/drop table if exists public\.(sk_book_products|topic_articles|books|chapter_grounding)\b/);
    expect(down).not.toMatch(/pub_/);
    expect(down).not.toMatch(/delete from|update /);
  });
});
