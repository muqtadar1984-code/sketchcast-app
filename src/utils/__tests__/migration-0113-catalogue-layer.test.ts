/**
 * Parse-check for supabase/migrations/0113_catalogue_layer.sql — the three
 * refinements from the curriculum review (plan Phase 2a). What must hold:
 *  • curriculum_nodes.kind carries exactly the six levels and is nullable;
 *  • the backfill covers every code shape the two shipped seeds use and only
 *    fills rows whose kind is NULL (idempotent);
 *  • topic_candidates gains node_ids (uuid[], default empty) and rationale;
 *  • jobs gains params and one live topic_derive per curriculum is enforced;
 *  • nothing else: no new table, no policy, no generations trigger.
 * Run: npx vitest run src/utils/__tests__/migration-0113-catalogue-layer.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const M = readFileSync(
  path.resolve(__dirname, "../../../supabase/migrations/0113_catalogue_layer.sql"),
  "utf-8",
).replace(/\r\n/g, "\n");
const code = M.split("\n")
  .map((l) => l.replace(/--.*$/, "").trimEnd())
  .filter((l) => l.trim() !== "")
  .join("\n");

describe("0113 — curriculum_nodes.kind", () => {
  it("has exactly the six levels and stays nullable", () => {
    const m = code.match(/kind in \(([^)]*)\)/);
    expect(m).not.toBeNull();
    expect(m![1].split(",").map((s) => s.trim().replace(/'/g, "")).sort()).toEqual(
      ["chapter", "objective", "strand", "sub_strand", "topic", "unit"],
    );
    expect(code).toContain("check (kind is null or kind in");
  });

  it("backfills every shipped code shape, only where kind is null", () => {
    const updates = [...code.matchAll(/update public\.curriculum_nodes set kind = '(\w+)'\s*\n\s*where kind is null and ([^\n]+)/g)];
    expect(updates.map((u) => u[1]).sort()).toEqual(["chapter", "objective", "strand", "sub_strand", "topic", "unit"]);
    // every update is guarded by `kind is null`
    expect((code.match(/update public\.curriculum_nodes set kind/g) ?? []).length).toBe(6);
    expect((code.match(/where kind is null/g) ?? []).length).toBe(6);
    // the Cambridge objective regex names every sub-strand code the seed uses
    for (const sub of ["Bs", "Bp", "Be", "Cm", "Cp", "Cc", "Pf", "Pl", "Ps", "ESp", "ESc", "ESs", "TWSm", "TWSp", "TWSc", "TWSa", "SIC"]) {
      expect(code).toContain(sub);
    }
  });
});

describe("0113 — grouped candidates and job inputs", () => {
  it("adds node_ids and rationale to topic_candidates", () => {
    expect(code).toContain("add column if not exists node_ids uuid[] not null default '{}'");
    expect(code).toContain("add column if not exists rationale text");
  });
  it("adds jobs.params and one live derive per curriculum", () => {
    expect(code).toContain("alter table public.jobs add column if not exists params jsonb;");
    expect(code).toContain("create unique index if not exists jobs_one_live_derive");
    expect(code).toContain("on public.jobs ((params->>'curriculum_id'))");
    expect(code).toContain("where type = 'topic_derive' and status in ('queued', 'processing');");
  });
  it("does nothing else", () => {
    expect(code.toLowerCase()).not.toContain("create table");
    expect(code.toLowerCase()).not.toContain("create policy");
    expect(code.toLowerCase()).not.toContain("create or replace function");
    expect(code.startsWith("begin;")).toBe(true);
    expect(code.endsWith("commit;")).toBe(true);
  });
});
