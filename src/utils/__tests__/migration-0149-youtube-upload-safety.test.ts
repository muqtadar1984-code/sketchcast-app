/**
 * Parse-check for supabase/migrations/0149_youtube_upload_safety.sql — the
 * worker's YouTube upload safety (Bulk YouTube Posting plan, Phase 1). What
 * must hold: the two publication columns the adopt check reads; a ledger
 * keyed by (quota day, channel) with RLS on; one atomic increment that adds
 * rather than overwrites; service-role only; a rollback that drops it all.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIG = path.resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIG, f), "utf-8").replace(/\r\n/g, "\n");
const M = read("0149_youtube_upload_safety.sql");
const R = read("0149_youtube_upload_safety_rollback.sql");
const code = M.split("\n").map((l) => l.replace(/--.*$/, "").trimEnd()).join("\n");

describe("0149 youtube upload safety", () => {
  it("adds the token and its start time to topic_publications", () => {
    expect(code).toMatch(/add column if not exists upload_token\s+text/);
    expect(code).toMatch(/add column if not exists upload_started_at timestamptz/);
  });

  it("keys the ledger by quota day and channel, with RLS on", () => {
    expect(code).toMatch(/primary key \(quota_day, channel_language\)/);
    expect(code).toMatch(/alter table public\.youtube_quota_ledger enable row level security/);
    expect(code).not.toMatch(/create policy/);
  });

  it("adds to the existing row instead of overwriting it", () => {
    expect(code).toMatch(/on conflict \(quota_day, channel_language\) do update/);
    expect(code).toMatch(/units\s+= l\.units \+ excluded\.units/);
    expect(code).toMatch(/uploads\s+= l\.uploads \+ excluded\.uploads/);
    expect(code).toMatch(/coalesce\(\(l\.calls ->> p_method\)::integer, 0\) \+ 1/);
  });

  it("is service-role only and the rollback drops everything", () => {
    expect(code).toMatch(/revoke all on function public\.youtube_quota_add\(date, text, text, integer, integer\) from public, anon, authenticated/);
    expect(code).toMatch(/grant execute on function public\.youtube_quota_add\(date, text, text, integer, integer\) to service_role/);
    expect(R).toMatch(/drop function if exists public\.youtube_quota_add\(date, text, text, integer, integer\)/);
    expect(R).toMatch(/drop table if exists public\.youtube_quota_ledger/);
    expect(R).toMatch(/drop column if exists upload_token/);
  });
});
