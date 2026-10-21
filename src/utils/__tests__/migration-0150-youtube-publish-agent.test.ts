/**
 * Parse-check for supabase/migrations/0150_youtube_publish_agent.sql — the
 * YouTube Publishing Agent's queue and rounds. What must hold: one daily
 * round per quota day and one open round at a time; a kit waits in the queue
 * once at a time; RLS on with no policies; a rollback that drops both.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIG = path.resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIG, f), "utf-8").replace(/\r\n/g, "\n");
const M = read("0150_youtube_publish_agent.sql");
const R = read("0150_youtube_publish_agent_rollback.sql");
const code = M.split("\n").map((l) => l.replace(/--.*$/, "").trimEnd()).join("\n");

describe("0150 youtube publish agent", () => {
  it("allows one daily round per quota day and one open round at a time", () => {
    expect(code).toMatch(/on public\.youtube_publish_rounds \(quota_day\) where trigger = 'daily'/);
    expect(code).toMatch(/on public\.youtube_publish_rounds \(\(true\)\) where status in \('requested', 'running'\)/);
  });

  it("holds a kit in the queue once at a time", () => {
    expect(code).toMatch(/on public\.youtube_publish_queue \(kit_id\) where status in \('pending', 'selected', 'queued'\)/);
    expect(code).toMatch(/check \(status in \('pending', 'selected', 'queued', 'done', 'failed', 'skipped', 'cancelled'\)\)/);
  });

  it("is service-role only and the rollback drops both tables", () => {
    expect(code).toMatch(/alter table public\.youtube_publish_rounds enable row level security/);
    expect(code).toMatch(/alter table public\.youtube_publish_queue\s+enable row level security/);
    expect(code).not.toMatch(/create policy/);
    expect(R).toMatch(/drop table if exists public\.youtube_publish_queue/);
    expect(R).toMatch(/drop table if exists public\.youtube_publish_rounds/);
  });
});
