/**
 * Parse-check for supabase/migrations/0085_country.sql — the operator applies
 * it by hand, so this is the only automated eye on the file. Two promises are
 * load-bearing enough to pin:
 *  • DDL + grants ONLY — the founder has NOT approved any country values for
 *    existing users, so the file must contain no statement that writes rows.
 *  • the 0010 grant posture — COLUMN-scoped update for authenticated, never
 *    table-level (a bare `grant update on profiles` would reopen the
 *    role/school_id self-escalation hole 0010 closed).
 * Run: npx vitest run src/utils/__tests__/migration-0085-country.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  path.resolve(__dirname, "../../../supabase/migrations/0085_country.sql"),
  "utf-8",
);

/** The file with comments stripped — promises are checked against real
 * statements, not prose. */
const code = sql
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/--[^\n]*/g, "")
  .toLowerCase();

describe("0085_country.sql", () => {
  it("adds both columns idempotently", () => {
    expect(code).toMatch(/alter table profiles add column if not exists country text/);
    expect(code).toMatch(/alter table profiles add column if not exists country_source text/);
  });

  it("pins the alpha-2 shape and the source vocabulary, both nullable", () => {
    expect(code).toMatch(/check \(country is null or country ~ '\^\[a-z\]\{2\}\$'\)/);
    expect(code).toMatch(/check \(country_source is null or country_source in \('signup', 'assumed', 'staff'\)\)/);
  });

  it("grants update COLUMN-scoped to authenticated — the 0010/0069 posture", () => {
    expect(code).toMatch(/grant update \(country, country_source\) on public\.profiles to authenticated/);
    // A table-level grant would be a security regression: every `grant update`
    // in the file must carry a column list.
    const grants = code.match(/grant update[^;]*/g) ?? [];
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) expect(g).toMatch(/^grant update \(/);
  });

  it("writes NO data — DDL, comments and grants only (no backfill of any kind)", () => {
    expect(code).not.toMatch(/\binsert\b/);
    expect(code).not.toMatch(/\bdelete\b/);
    expect(code).not.toMatch(/\bcopy\b/);
    expect(code).not.toMatch(/\btruncate\b/);
    // `update` may appear only inside `grant update` / `revoke update` — never
    // as a statement head touching rows.
    const updates = code.match(/\bupdate\b/g) ?? [];
    const granted = code.match(/\b(?:grant|revoke) update\b/g) ?? [];
    expect(updates.length).toBe(granted.length);
  });

  it("balances statements — every one ends with a semicolon", () => {
    const statements = code
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    // Nothing after the final semicolon, and every statement is one we expect.
    expect(statements.length).toBeGreaterThanOrEqual(7); // 2 add + 2 comment + 2×(drop+add constraint counts as 2 each = 4) + 1 grant → 9, keep a floor
    for (const s of statements) {
      expect(s).toMatch(/^(alter table|comment on|grant update)/);
    }
  });
});
