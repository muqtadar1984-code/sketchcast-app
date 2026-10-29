// 0169 (written 2026-10-29, dry-run on production inside begin…rollback, NOT
// applied) — the SK action id on the rows an S2 action writes AS THE TEACHER.
// Same lint pattern as migration-0164-sk-assign: read the SQL, strip comments,
// assert the DDL the plan's idempotency rule rests on.
// Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/migration-0169-sk-action-ids.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const DIR = path.resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) =>
  readFileSync(path.join(DIR, f), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/--[^\n]*/g, "")
    .toLowerCase();

const up = read("0169_sk_action_ids.sql");
const down = read("0169_sk_action_ids_rollback.sql");

describe("0169_sk_action_ids.sql", () => {
  it("adds a nullable uuid sk_action_id to diary_notes and generations, idempotently, with no foreign key", () => {
    expect(up).toMatch(/alter table public\.diary_notes add column if not exists sk_action_id uuid;/);
    expect(up).toMatch(/alter table public\.generations add column if not exists sk_action_id uuid;/);
    expect(up).not.toMatch(/references/);
    expect(up).not.toMatch(/not null default/);
  });

  it("makes a diary write unique per (action, target) — one reminder action writes one note PER STUDENT", () => {
    expect(up).toMatch(
      /create unique index if not exists diary_notes_sk_action_target_uidx\s+on public\.diary_notes \(sk_action_id, \(coalesce\(student_id, class_id\)\)\)\s+where sk_action_id is not null;/,
    );
  });

  it("makes a generations write unique per (action, kind, part) for slice B", () => {
    expect(up).toMatch(
      /create unique index if not exists generations_sk_action_kind_part_uidx\s+on public\.generations \(sk_action_id, kind, \(coalesce\(params->>'part', '1'\)\)\)\s+where sk_action_id is not null;/,
    );
  });

  it("changes no policy, grant or function: the teacher's own RLS decides the write", () => {
    expect(up).not.toMatch(/create policy|drop policy|alter policy/);
    expect(up).not.toMatch(/\bgrant\b|\brevoke\b/);
    expect(up).not.toMatch(/create (or replace )?function/);
    expect(up).not.toMatch(/security definer/);
    expect(up).not.toMatch(/create table|drop table|drop column/);
  });

  it("is one transaction", () => {
    expect(up.trim().startsWith("begin;")).toBe(true);
    expect(up.trim().endsWith("commit;")).toBe(true);
  });

  it("has a rollback that drops exactly the two indexes and two columns", () => {
    expect(down).toMatch(/drop index if exists public\.diary_notes_sk_action_target_uidx;/);
    expect(down).toMatch(/drop index if exists public\.generations_sk_action_kind_part_uidx;/);
    expect(down).toMatch(/alter table public\.diary_notes drop column if exists sk_action_id;/);
    expect(down).toMatch(/alter table public\.generations drop column if exists sk_action_id;/);
    expect(down).not.toMatch(/drop table/);
    expect(down.trim().startsWith("begin;")).toBe(true);
    expect(down.trim().endsWith("commit;")).toBe(true);
  });
});
