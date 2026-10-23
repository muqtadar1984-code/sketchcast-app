/**
 * Parse-check for supabase/migrations/0154_pinterest_pin_engine.sql — the
 * Pinterest Pin Engine's tables. What must hold: a pin is never drafted or
 * posted twice; approval names its approver and a rejection its reason; one
 * daily round per day and one open round at a time; one live post job; the
 * token is ciphertext in a one-row table; RLS on with no policies; the agent
 * ships OFF and in dry run; a rollback that undoes all of it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIG = path.resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIG, f), "utf-8").replace(/\r\n/g, "\n");
const M = read("0154_pinterest_pin_engine.sql");
const R = read("0154_pinterest_pin_engine_rollback.sql");
const code = M.split("\n").map((l) => l.replace(/--.*$/, "").trimEnd()).join("\n");

const TABLES = ["pinterest_boards", "pinterest_pins", "pinterest_publish_rounds", "pinterest_pin_stats", "pinterest_oauth"];

describe("0154 pinterest pin engine", () => {
  it("never drafts or posts the same pin twice", () => {
    expect(code).toMatch(/unique \(source_kind, source_ref, language, format, template\)/);
    expect(code).toMatch(/on public\.pinterest_pins \(content_hash\) where content_hash is not null/);
    expect(code).toMatch(/pinterest_pin_id\s+text\s+unique/);
  });

  it("makes approval name its approver and rejection give a reason", () => {
    expect(code).toMatch(/status not in \('approved', 'scheduled', 'posting', 'posted'\) or \(approved_by is not null and approved_at is not null\)/);
    expect(code).toMatch(/status <> 'rejected' or coalesce\(btrim\(reject_reason\), ''\) <> ''/);
  });

  it("fails fast rather than stalling job writes while the jobs indexes build", () => {
    expect(code).toMatch(/set local lock_timeout = '5s';/);
  });

  it("allows one daily round per day, one open round and one live post job", () => {
    expect(code).toMatch(/on public\.pinterest_publish_rounds \(day\) where trigger = 'daily'/);
    expect(code).toMatch(/on public\.pinterest_publish_rounds \(\(true\)\) where status in \('requested', 'running'\)/);
    expect(code).toMatch(/on public\.jobs \(\(true\)\) where type = 'pin_post' and status in \('queued', 'processing'\)/);
  });

  it("keeps the token as ciphertext in a single-row table", () => {
    expect(code).toMatch(/id\s+smallint\s+primary key default 1 check \(id = 1\)/);
    expect(code).toMatch(/ciphertext\s+text\s+not null/);
    expect(code).not.toMatch(/access_token|refresh_token/);
  });

  it("is service-role only", () => {
    for (const t of TABLES) expect(code).toMatch(new RegExp(`alter table public\\.${t}\\s+enable row level security`));
    expect(code).not.toMatch(/create policy/);
    expect(code).toMatch(/values \('pinterest-pins', 'pinterest-pins', false,/);
  });

  it("ships the agent OFF and in dry run, and boards as planned", () => {
    expect(code).toMatch(/'enabled', false,\s*\n\s*'dry_run', true/);
    expect(code).toMatch(/status\s+text\s+not null default 'planned'/);
    expect(code).toMatch(/on conflict \(key\) do nothing/);
  });

  it("rolls back every table, index, the settings row and an empty bucket", () => {
    for (const t of TABLES) expect(R).toMatch(new RegExp(`drop table if exists public\\.${t};`));
    expect(R).toMatch(/drop index if exists public\.jobs_one_live_pin_post/);
    expect(R).toMatch(/drop index if exists public\.jobs_one_live_pin_draft/);
    expect(R).toMatch(/delete from public\.platform_settings where key = 'pinterest_agent'/);
    expect(R).toMatch(/not exists \(select 1 from storage\.objects where bucket_id = 'pinterest-pins'\)/);
  });
});
