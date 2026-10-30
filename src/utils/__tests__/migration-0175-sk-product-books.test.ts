// 0175 (written 2026-10-30, NOT applied) — SketchCast books as Library books:
// the product link on books, the index-job guard, the grant rule, the buyers'
// read policy, adopt_product_kit (a mapped CATALOGUE kit, the book grant as the
// entitlement) and the forged product_ref refusals. Same lint
// pattern as migration-0174: read the SQL, strip comments, assert the DDL the
// access and safety rules rest on.
// Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/migration-0175-sk-product-books.test.ts
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

const up = read("0175_sk_product_books.sql");
const down = read("0175_sk_product_books_rollback.sql");

function fn(name: string): string {
  const start = up.indexOf(`create or replace function public.${name}(`);
  expect(start, `function ${name}`).toBeGreaterThan(-1);
  const end = up.indexOf("$$;", up.indexOf("$$", start) + 2);
  return up.slice(start, end + 3);
}

describe("0175_sk_product_books.sql", () => {
  it("is one transaction", () => {
    expect(up.trim().startsWith("begin;")).toBe(true);
    expect(up.trim().endsWith("commit;")).toBe(true);
  });

  it("books gains the product link, unique per product, and the release it carries", () => {
    expect(up).toMatch(/alter table public\.books add column if not exists sk_product_id uuid\s+references public\.sk_book_products\(id\)/);
    expect(up).toMatch(/alter table public\.books add column if not exists sk_release_id bigint;/);
    expect(up).toMatch(/create unique index if not exists books_sk_product_uq\s+on public\.books \(sk_product_id\) where sk_product_id is not null;/);
  });

  it("a product book never queues an index job: on_book_created gets a WHEN clause, the function body is untouched", () => {
    expect(up).toMatch(/create trigger on_book_created\s+after insert on public\.books\s+for each row\s+when \(new\.sk_product_id is null\)\s+execute function public\.create_index_job_for_book\(\);/);
    expect(up).not.toMatch(/create or replace function public\.create_index_job_for_book/);
    // refuses to guess when the live trigger is not the one the repo names
    expect(up).toMatch(/raise exception '0175: no trigger on public\.books calls create_index_job_for_book/);
  });

  it("has_book_grant is exactly skAccess's book rule for the caller", () => {
    const f = fn("has_book_grant");
    expect(f).toMatch(/returns boolean\s+language sql\s+stable\s+security definer\s+set search_path = public/);
    expect(f).toMatch(/g\.user_id = auth\.uid\(\)/);
    expect(f).toMatch(/g\.product_id = p_product/);
    expect(f).toMatch(/g\.revoked_at is null/);
    expect(f).toMatch(/g\.activated_at <= now\(\)/);
    expect(f).toMatch(/\(g\.expires_at is null or g\.expires_at > now\(\)\)/);
    // no licence, subscription or school path
    expect(f).not.toMatch(/entitlements|school|licen/);
  });

  it("buyers read product books through an extra permissive SELECT policy; no write policy is added", () => {
    expect(up).toMatch(
      /create policy books_sk_product_read on public\.books\s+for select to authenticated\s+using \(sk_product_id is not null and removed_at is null and public\.has_book_grant\(sk_product_id\)\);/,
    );
    expect(up).not.toMatch(/on public\.books\s+(as \w+\s+)?for (insert|update|delete|all)/);
    expect(up).not.toMatch(/create policy \w+ on public\.generations\s+for select/);
    expect(up).not.toMatch(/on public\.chapter_grounding/);
  });

  it("adopt_product_kit: definer; a piece of an APPROVED catalogue kit mapped in sk_product_kits to a product the caller holds a grant for", () => {
    const f = fn("adopt_product_kit");
    expect(f).toMatch(/returns uuid\s+language plpgsql\s+volatile\s+security definer\s+set search_path = public/);
    // 0132's piece rule: the presentation column or a non-blank doc slot of an approved kit
    expect(f).toMatch(/from topic_kits k\s+join sk_product_kits m on m\.generation_id = k\.presentation_generation_id/);
    expect(f).toMatch(/k\.status = 'approved'/);
    expect(f).toMatch(/k\.presentation_generation_id = p_source/);
    expect(f).toMatch(/jsonb_each_text\(coalesce\(k\.doc_generation_ids, '\{\}'::jsonb\)\) d\s+where nullif\(d\.value, ''\) = p_source::text/);
    // the BOOK GRANT is the entitlement, inside the same lookup (one answer for "not mapped" and "not yours")
    expect(f).toMatch(/and has_book_grant\(m\.product_id\)/);
    // no unlock, no allowance: none of the catalogue's entitlement functions or tables
    expect(f).not.toMatch(/catalogue_has_access|catalogue_ineligible_reason|unlock_catalogue_kit|catalogue_unlocks|my_catalogue_allowance/);
    // the source must be done and live
    expect(f).toMatch(/g\.status = 'done' and g\.removed_at is null and g\.withdrawn_at is null/);
    expect(f).toMatch(/p\.role = 'student' or p\.suspended_at is not null/);
  });

  it("adopt_product_kit: idempotent across both adopt functions, 0132's copy (copy flag, no job, no credit) with catalogue_ref AND product_ref", () => {
    const f = fn("adopt_product_kit");
    expect(f).toMatch(/g\.params -> 'product_ref' ->> 'source' = p_source::text\s+or g\.params -> 'catalogue_ref' ->> 'source_generation_id' = p_source::text/);
    expect(f).toMatch(/values \(src\.kind, null, null, src\.title, me, my_school, 'done',/);
    for (const k of ["topic_id", "topic_kit_id", "source_generation_id", "article_id", "article_version", "language"]) expect(f).toContain(`'${k}',`);
    expect(f).toMatch(/'catalogue_ref', jsonb_build_object\(/);
    expect(f).toMatch(/'product_ref', jsonb_build_object\(/);
    for (const k of ["product_id", "release_id", "book_id", "chapter_ref", "source"]) expect(f).toContain(`'${k}',`);
    const on = f.indexOf("set_config('sketchcast.generation_copy', 'on', true)");
    const ins = f.indexOf("insert into generations");
    const off = f.indexOf("set_config('sketchcast.generation_copy', '', true)");
    expect(on).toBeGreaterThan(-1);
    expect(on).toBeLessThan(ins);
    expect(off).toBeGreaterThan(f.indexOf("insert into artifacts"));
    expect(f).not.toMatch(/insert into jobs|credit_ledger/);
  });

  it("forged params.product_ref is refused by RESTRICTIVE policies (0133's lesson)", () => {
    expect(up).toMatch(
      /create policy gen_no_product_ref_insert on public\.generations\s+as restrictive for insert to authenticated\s+with check \(not \(coalesce\(params, '\{\}'::jsonb\) \? 'product_ref'\)\);/,
    );
    expect(up).toMatch(
      /create policy gen_no_product_ref_update on public\.generations\s+as restrictive for update to authenticated\s+using \(true\)\s+with check \(not \(coalesce\(params, '\{\}'::jsonb\) \? 'product_ref'\)\);/,
    );
  });

  it("grants: nothing to anon or public; adopt to authenticated only", () => {
    expect(up).toMatch(/revoke all on function public\.has_book_grant\(uuid\) from public, anon;/);
    expect(up).toMatch(/revoke all on function public\.adopt_product_kit\(uuid\) from public, anon;/);
    expect(up).toMatch(/grant execute on function public\.adopt_product_kit\(uuid\) to authenticated;/);
    expect(up).not.toMatch(/to anon/);
  });
});

describe("0175_sk_product_books_rollback.sql", () => {
  it("drops what 0175 created and restores the trigger without its WHEN clause", () => {
    expect(down.trim().startsWith("begin;")).toBe(true);
    expect(down.trim().endsWith("commit;")).toBe(true);
    for (const p of ["books_sk_product_read", "gen_no_product_ref_insert", "gen_no_product_ref_update"]) expect(down).toContain(`drop policy if exists ${p}`);
    expect(down).toContain("drop function if exists public.adopt_product_kit(uuid);");
    expect(down).toContain("drop function if exists public.has_book_grant(uuid);");
    expect(down).toMatch(/create trigger on_book_created\s+after insert on public\.books\s+for each row execute function public\.create_index_job_for_book\(\);/);
    expect(down).toContain("alter table public.books drop column if exists sk_product_id;");
    expect(down).toContain("alter table public.books drop column if exists sk_release_id;");
    // the policy that uses has_book_grant goes before the function
    expect(down.indexOf("drop policy if exists books_sk_product_read")).toBeLessThan(down.indexOf("drop function if exists public.has_book_grant"));
  });
});
