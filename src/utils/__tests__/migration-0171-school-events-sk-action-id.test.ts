// 0171 (written 2026-10-29, dry-run on production inside begin…rollback, NOT
// applied) — the SK action id on a school notice SK posts (S5 slice D).
// Same lint pattern as migration-0169-sk-action-ids: read the SQL, strip
// comments, assert the DDL the idempotency rule rests on.
// Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/migration-0171-school-events-sk-action-id.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const DIR = path.resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) =>
  readFileSync(path.join(DIR, f), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/--[^\n]*/g, "")
    .toLowerCase();

const up = read("0171_school_events_sk_action_id.sql");
const down = read("0171_school_events_sk_action_id_rollback.sql");

describe("0171_school_events_sk_action_id.sql", () => {
  it("adds a nullable uuid sk_action_id to school_events, idempotently, with no foreign key", () => {
    expect(up).toMatch(/alter table public\.school_events add column if not exists sk_action_id uuid;/);
    expect(up).not.toMatch(/references/);
    expect(up).not.toMatch(/sk_action_id uuid (not null|default)/);
  });

  it("makes a notice write unique per action (one action writes one row), partial on non-null", () => {
    expect(up).toMatch(
      /create unique index if not exists school_events_sk_action_uidx\s+on public\.school_events \(sk_action_id\)\s+where sk_action_id is not null;/,
    );
  });

  it("documents the column", () => {
    expect(up).toMatch(/comment on column public\.school_events\.sk_action_id is\s+'sk action token id/);
  });

  it("changes no policy, grant or function: se_admin_write / se_coordinator_write decide the write", () => {
    expect(up).not.toMatch(/create policy|drop policy|alter policy|row level security/);
    expect(up).not.toMatch(/\bgrant\b|\brevoke\b/);
    expect(up).not.toMatch(/create (or replace )?function/);
    expect(up).not.toMatch(/security definer/);
    expect(up).not.toMatch(/create table|drop table|drop column/);
    // Only school_events is touched.
    expect(up.match(/public\.(\w+)/g)?.every((m) => m === "public.school_events")).toBe(true);
  });

  it("is one transaction", () => {
    expect(up.trim().startsWith("begin;")).toBe(true);
    expect(up.trim().endsWith("commit;")).toBe(true);
  });

  it("has a rollback that drops exactly the index and the column", () => {
    expect(down).toMatch(/drop index if exists public\.school_events_sk_action_uidx;/);
    expect(down).toMatch(/alter table public\.school_events drop column if exists sk_action_id;/);
    expect(down).not.toMatch(/drop table/);
    expect(down.trim().startsWith("begin;")).toBe(true);
    expect(down.trim().endsWith("commit;")).toBe(true);
  });
});
