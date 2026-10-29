// 0170 (written 2026-10-29, dry-run on production inside begin…rollback: 9 rows
// seeded, RLS on, no anon/authenticated grants; NOT applied) — the SK S3 book
// product → chapter → kit map and the article-objective key on attempts and
// mastery. Same lint pattern as migration-0169-sk-action-ids.
// Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/migration-0170-sk-product-kits.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const DIR = path.resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) =>
  readFileSync(path.join(DIR, f), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/--[^\n]*/g, "")
    .toLowerCase();

const up = read("0170_sk_product_kits.sql");
const down = read("0170_sk_product_kits_rollback.sql");

const KITS: [string, string][] = [
  ["1", "e064cda5-775d-4b30-a77e-1180123da6a8"],
  ["2", "ae8fc240-4391-4bee-80eb-2c0ce9b572ac"],
  ["4", "eef426bd-523b-4fed-827c-95421263d89a"],
  ["5", "4885bc51-0e65-4252-bb41-88df6bcc28bc"],
  ["6", "3f63956e-9615-4fc2-b1da-b18ae24afb3c"],
  ["8", "cbad6d74-7433-46ad-baed-12724c7e59cf"],
  ["8", "4246bd3e-48e0-407e-adce-872ab84239bc"],
  ["8", "4160b18e-2c3c-4ed6-b4dd-dce706eb0805"],
  ["9", "38cf173c-13ac-4860-86df-ce4256c93925"],
];

describe("0170_sk_product_kits.sql", () => {
  it("creates sk_product_kits with the agreed columns, cascades and primary key", () => {
    expect(up).toMatch(/create table if not exists public\.sk_product_kits \(/);
    expect(up).toMatch(/product_id\s+uuid\s+not null references public\.sk_book_products\(id\) on delete cascade/);
    expect(up).toMatch(/chapter_ref\s+text\s+not null/);
    expect(up).toMatch(/sort\s+int\s+not null default 0/);
    expect(up).toMatch(/generation_id uuid\s+not null references public\.generations\(id\) on delete cascade/);
    expect(up).toMatch(/label\s+text,/);
    expect(up).toMatch(/created_at\s+timestamptz not null default now\(\)/);
    expect(up).toMatch(/primary key \(product_id, chapter_ref, generation_id\)/);
  });

  it("sk_product_kits is service-role only: RLS on, every grant revoked, no policy; no function anywhere", () => {
    expect(up).toMatch(/alter table public\.sk_product_kits enable row level security;/);
    expect(up).toMatch(/revoke all on public\.sk_product_kits from anon, authenticated;/);
    expect(up).not.toMatch(/(create|alter) policy[^;]*on public\.sk_product_kits/);
    expect(up).not.toMatch(/^\s*grant\b[^;]*sk_product_kits/m); // a statement; the table comment mentions a "book grant"
    // the only grant in the file is students' read of their own kit-objective mastery
    expect(up.match(/^\s*grant\b[^;]*;/gm)).toEqual(["grant select on public.sk_objective_mastery to authenticated;"]);
    expect(up).not.toMatch(/create (or replace )?function|security definer/);
  });

  it("seeds exactly the nine Biology kits, by SELECT (nothing on a database without them), idempotently", () => {
    for (const [ch, gid] of KITS) expect(up).toMatch(new RegExp(`\\('${ch}', \\d, '${gid}'::uuid, '[^']+'\\)`));
    expect(up.match(/'[0-9a-f-]{36}'::uuid/g)).toHaveLength(KITS.length);
    expect(up).toMatch(/join public\.sk_book_products p on p\.slug = 'cells-structure-function-organisation'/);
    expect(up).toMatch(/join public\.generations g on g\.id = v\.generation_id and g\.kind = 'presentation' and g\.status = 'done' and g\.withdrawn_at is null/);
    expect(up).toMatch(/on conflict do nothing;/);
    // chapter 8's three kits are ordered blood, respiratory, transport
    expect(up).toMatch(/\('8', 0, 'cbad6d74[^)]*\)[\s\S]*\('8', 1, '4246bd3e[^)]*\)[\s\S]*\('8', 2, '4160b18e/);
  });

  it("adds a nullable objective_key to item_attempts with a partial index, and leaves mastery_state alone", () => {
    expect(up).toMatch(/alter table public\.item_attempts add column if not exists objective_key text;/);
    expect(up).toMatch(/create index if not exists item_attempts_student_objective_key_idx\s+on public\.item_attempts \(student_id, objective_key, at\)\s+where objective_key is not null;/);
    expect(up).not.toMatch(/alter table public\.mastery_state/);
    expect(up).not.toMatch(/drop column|drop table|drop constraint/);
  });

  it("creates sk_objective_mastery keyed on (student_id, objective_key), read-own for students", () => {
    expect(up).toMatch(/create table if not exists public\.sk_objective_mastery \(/);
    expect(up).toMatch(/objective_key\s+text\s+not null check \(objective_key ~ '\^\[0-9a-f-\]\{36\}:\.\+\$'\)/);
    expect(up).toMatch(/primary key \(student_id, objective_key\)/);
    expect(up).toMatch(/check \(independent = false or status = 'mastered'\)/);
    expect(up).toMatch(/alter table public\.sk_objective_mastery enable row level security;/);
    expect(up).toMatch(/revoke all on public\.sk_objective_mastery from anon, authenticated;/);
    expect(up).toMatch(/grant select on public\.sk_objective_mastery to authenticated;/);
    expect(up).toMatch(/for select to authenticated using \(student_id = auth\.uid\(\)\)/);
    expect(up).not.toMatch(/grant (insert|update|delete|all)[^;]*sk_objective_mastery/);
  });

  it("is one transaction", () => {
    expect(up.trim().startsWith("begin;")).toBe(true);
    expect(up.trim().endsWith("commit;")).toBe(true);
  });

  it("has a rollback that drops both tables, the column and its index, and nothing else", () => {
    expect(down).toMatch(/drop table if exists public\.sk_objective_mastery;/);
    expect(down).toMatch(/drop index if exists public\.item_attempts_student_objective_key_idx;/);
    expect(down).toMatch(/alter table public\.item_attempts drop column if exists objective_key;/);
    expect(down).toMatch(/drop table if exists public\.sk_product_kits;/);
    expect(down).not.toMatch(/mastery_state/);
    expect(down.match(/drop table/g)).toHaveLength(2);
    expect(down.trim().startsWith("begin;")).toBe(true);
    expect(down.trim().endsWith("commit;")).toBe(true);
  });
});
