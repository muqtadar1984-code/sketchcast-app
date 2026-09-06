/**
 * Parse-check for supabase/migrations/0114_article_jobs.sql (Phase 2b): one
 * live topic_article per (topic, language) and one live figure_render per
 * article, both as partial unique indexes on jobs.params like 0112's harvest
 * and 0113's derive indexes; article_figures.render_error. Nothing else.
 * Run: npx vitest run src/utils/__tests__/migration-0114-article-jobs.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const M = readFileSync(path.resolve(__dirname, "../../../supabase/migrations/0114_article_jobs.sql"), "utf-8").replace(/\r\n/g, "\n");
const code = M.split("\n").map((l) => l.replace(/--.*$/, "").trimEnd()).filter((l) => l.trim() !== "").join("\n");

describe("0114 — article jobs", () => {
  it("enforces one live topic_article per (topic, language) and one live figure_render per article", () => {
    expect(code).toContain("create unique index if not exists jobs_one_live_article");
    expect(code).toContain("on public.jobs ((params->>'topic_id'), (coalesce(params->>'language', 'en')))");
    expect(code).toContain("where type = 'topic_article' and status in ('queued', 'processing');");
    expect(code).toContain("create unique index if not exists jobs_one_live_figure_render");
    expect(code).toContain("on public.jobs ((params->>'article_id'))");
    expect(code).toContain("where type = 'figure_render' and status in ('queued', 'processing');");
  });
  it("adds render_error to article_figures and nothing else", () => {
    expect(code).toContain("alter table public.article_figures add column if not exists render_error text;");
    expect(code.toLowerCase()).not.toContain("create table");
    expect(code.toLowerCase()).not.toContain("create policy");
    expect(code.toLowerCase()).not.toContain("create or replace function");
    expect(code.startsWith("begin;")).toBe(true);
    expect(code.endsWith("commit;")).toBe(true);
  });
});
