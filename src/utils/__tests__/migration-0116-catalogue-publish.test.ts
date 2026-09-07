/**
 * Parse-check for supabase/migrations/0116_catalogue_publish.sql (Phase 4, the
 * publish). What must hold:
 *  • one live `topic_publish` job per KIT — a partial unique index on
 *    jobs.params shaped like 0114's jobs_one_live_article and 0115's
 *    jobs_one_live_questions, keyed on params->>'kit_id' (a kit is one
 *    language, so the kit id already separates the channels);
 *  • it is ONE additive transaction: no table, no policy, no function, no
 *    enum change, and nothing added to topic_publications — 0112's shape,
 *    with unique (topic_kit_id, part, channel_language) as the idempotency
 *    key, is what makes a re-run finish a publish instead of doubling it;
 *  • no credential is stored: the migration must not mention a token, a
 *    secret or a refresh token anywhere, because every YouTube credential
 *    lives in the worker's environment (plan §10);
 *  • no publish RPC: gate 2 is the kit's `approved` status, which 0115's
 *    approve_topic_kit() already owns, so there is no new status for a
 *    SECURITY DEFINER function to write atomically;
 *  • the app side agrees: the publish route's live pre-check keys on the same
 *    expression the index does, and maps its 23505 to the same 409.
 * Run: npx vitest run src/utils/__tests__/migration-0116-catalogue-publish.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIG = path.resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIG, f), "utf-8").replace(/\r\n/g, "\n");
const M = read("0116_catalogue_publish.sql");

/** Comment-stripped DDL only. */
const code = M.split("\n")
  .map((l) => l.replace(/--.*$/, "").trimEnd())
  .filter((l) => l.trim() !== "")
  .join("\n");

const ROUTE = path.resolve(__dirname, "..", "..", "app", "api", "library", "topics", "[id]", "publish", "route.ts");

describe("0116 — catalogue publish", () => {
  it("enforces one live topic_publish job per kit, keyed like 0114's and 0115's job indexes", () => {
    expect(code).toContain("create unique index if not exists jobs_one_live_publish");
    expect(code).toContain("on public.jobs ((params->>'kit_id'))");
    expect(code).toContain("where type = 'topic_publish' and status in ('queued', 'processing');");
  });

  it("is one additive transaction: no table, no policy, no function, no enum change", () => {
    expect(code.startsWith("begin;")).toBe(true);
    expect(code.endsWith("commit;")).toBe(true);
    for (const forbidden of ["create table", "create policy", "create or replace function", "alter type", "drop table", "drop function"]) {
      expect(code.toLowerCase(), forbidden).not.toContain(forbidden);
    }
    // exactly one statement besides begin/commit
    expect(code.match(/;/g)).toHaveLength(3);
  });

  it("adds nothing to topic_publications — 0112's shape is the idempotency key", () => {
    expect(code).not.toMatch(/alter table[^\n]*topic_publications/i);
    expect(code).not.toMatch(/topic_publications/);
    // …and 0112 is where that shape (and its unique key) lives
    const M0112 = read("0112_topic_catalogue.sql");
    expect(M0112).toContain("create table if not exists public.topic_publications (");
    expect(M0112).toContain("unique (topic_kit_id, part, channel_language)");
    expect(M0112).toContain("youtube_video_id   text");
  });

  it("stores no credential: the DDL has no token, secret or key of any kind", () => {
    for (const word of ["token", "secret", "oauth", "credential", "youtube"]) {
      expect(code.toLowerCase(), word).not.toContain(word);
    }
    // …and the header says so, so the next reader does not add one
    expect(M).toContain("NEVER stored here");
  });

  it("adds no publish RPC — the gate is the kit's approved status, which 0115 owns", () => {
    expect(code).not.toMatch(/publish_topic_kit/);
    expect(code).not.toMatch(/security definer/i);
    expect(code).not.toMatch(/grant execute/i);
  });

  it("the publish route's live pre-check keys on the index's expression and maps its 23505 to the 409", () => {
    const route = readFileSync(ROUTE, "utf8");
    expect(route).toMatch(/const\s+PUBLISH_JOB_TYPE\s*=\s*["']topic_publish["']/);
    expect(route).toMatch(/\.eq\(\s*["']params->>kit_id["']\s*,\s*kit\.id\s*\)/);
    expect(route).toMatch(/\.in\(\s*["']status["']\s*,\s*\[\s*["']queued["']\s*,\s*["']processing["']\s*\]\s*\)/);
    const race = route.slice(route.indexOf('jErr.code === "23505"'));
    expect(race).toMatch(/return\s+conflict\(/);
    expect(race.indexOf("conflict(")).toBeLessThan(race.indexOf("dbError("));
  });
});
