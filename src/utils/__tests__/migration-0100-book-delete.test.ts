/**
 * Parse-check for supabase/migrations/0100_book_delete_takes_its_kits.sql —
 * applied by hand, so this is the only automated eye on the file. What must
 * hold:
 *  • both functions are SECURITY DEFINER and authorise on auth.uid() = owner,
 *    the 0073 posture — a function that skipped that check would let any
 *    signed-in user delete any book;
 *  • the delete REFUSES, in this order and BEFORE touching a row: other
 *    teachers' kits on the book ('shared_kits' — the function deletes kits
 *    before the book, so the books trigger that counts them would see none),
 *    a book being indexed ('book_indexing'), a kit being built
 *    ('kit_building'); each a fixed token the client translates;
 *  • paths are gathered BEFORE the rows go, kits are deleted BEFORE the book,
 *    and only paths no artifact row still references are returned — a
 *    colleague's adopted copy (0073) must keep its files;
 *  • the FK stays ON DELETE SET NULL — the file must not sneak in a CASCADE
 *    that would let a console or SQL delete wipe student work silently;
 *  • grants: execute to authenticated only; nothing table-level; no data writes.
 * Run: npx vitest run src/utils/__tests__/migration-0100-book-delete.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  path.resolve(__dirname, "../../../supabase/migrations/0100_book_delete_takes_its_kits.sql"),
  "utf-8",
);
const code = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "").toLowerCase();

const fn = (name: string) => {
  const m = code.match(new RegExp(`create or replace function public\\.${name}\\(p_book uuid\\)([\\s\\S]*?)\\$\\$;`));
  if (!m) throw new Error(`${name} not found`);
  return m[1];
};

describe("0100_book_delete_takes_its_kits.sql", () => {
  it("defines both functions as SECURITY DEFINER with a pinned search_path", () => {
    for (const name of ["my_book_impact", "delete_my_book"]) {
      const body = fn(name);
      expect(body).toMatch(/security definer/);
      expect(body).toMatch(/set search_path to 'public'/);
    }
  });

  it("authorises every call on auth.uid() being the book's owner", () => {
    for (const name of ["my_book_impact", "delete_my_book"]) {
      const body = fn(name);
      expect(body).toMatch(/me uuid := auth\.uid\(\)/);
      expect(body).toMatch(/if me is null then\s+raise exception 'not signed in'/);
      expect(body).toMatch(/b\.owner_id <> me then\s+raise exception 'not your book'/);
      expect(body).toMatch(/removed_at is null/);
    }
  });

  it("measures other teachers' kits so the client can refuse before asking", () => {
    const body = fn("my_book_impact");
    expect(body).toMatch(/'others',\s+\(select count\(\*\) from generations g\s+where g\.book_id = p_book and g\.owner_id <> me and g\.withdrawn_at is null\)/);
  });

  it("refuses — shared kits, then indexing, then building — before touching any row", () => {
    const body = fn("delete_my_book");
    const shared = body.search(/g\.owner_id <> me and g\.withdrawn_at is null\) then\s+raise exception 'shared_kits'/);
    const indexing = body.search(/if b\.status = 'processing' then\s+raise exception 'book_indexing'/);
    const building = body.search(/g\.status = 'processing'\) then\s+raise exception 'kit_building'/);
    const firstDelete = body.indexOf("delete from");
    expect(shared).toBeGreaterThan(0);
    expect(indexing).toBeGreaterThan(shared);
    expect(building).toBeGreaterThan(indexing);
    expect(firstDelete).toBeGreaterThan(building);
  });

  it("gathers paths first, deletes kits before the book, returns only unreferenced paths", () => {
    const body = fn("delete_my_book");
    const gather = body.indexOf("array_agg(distinct a.storage_path)");
    const submitted = body.indexOf("array_agg(s.file_path)");
    const delGens = body.indexOf("delete from generations where book_id = p_book");
    const delBook = body.indexOf("delete from books where id = p_book");
    const orphans = body.indexOf("not exists (select 1 from artifacts a2 where a2.storage_path = p)");
    expect(gather).toBeGreaterThan(0);
    expect(submitted).toBeGreaterThan(gather);
    expect(delGens).toBeGreaterThan(submitted);
    expect(delBook).toBeGreaterThan(delGens);
    expect(orphans).toBeGreaterThan(delBook);
    for (const key of ["'kits'", "'submissions'", "'artifacts'", "'submission_files'", "'cover'", "'upload'"]) {
      expect(body).toContain(key);
    }
  });

  it("does not touch the foreign key — SET NULL stays, no CASCADE is introduced", () => {
    expect(code).not.toMatch(/on delete cascade/);
    expect(code).not.toMatch(/alter table/);
  });

  it("grants execute to authenticated only, and writes no data", () => {
    expect(code).toMatch(/revoke all on function public\.my_book_impact\(uuid\) from public, anon/);
    expect(code).toMatch(/revoke all on function public\.delete_my_book\(uuid\) from public, anon/);
    expect(code).toMatch(/grant execute on function public\.my_book_impact\(uuid\) to authenticated/);
    expect(code).toMatch(/grant execute on function public\.delete_my_book\(uuid\) to authenticated/);
    const grants = code.match(/grant [^;]*/g) ?? [];
    for (const g of grants) expect(g).toMatch(/^grant execute on function/);
    // Statements outside the function bodies must be DDL/grants only.
    const outside = code.replace(/as \$\$[\s\S]*?\$\$;/g, "");
    expect(outside).not.toMatch(/\b(insert|update|delete)\b/);
  });
});
