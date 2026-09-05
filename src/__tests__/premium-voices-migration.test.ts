/**
 * Migration 0105 is a DIFF of the live my_fair_use(), not a retype of it.
 *
 * my_fair_use() is 100 lines of metering that six product surfaces read. The
 * only safe way to add a field to every branch is to take the body that is
 * running and add to it — a retype silently reverts whatever the last hand
 * edit was. So this test does the arithmetic: strip 0105's additions back out
 * and what remains must equal 0101's body byte for byte. (0101's body was
 * verified line-by-line against the live prod body with pg_get_functiondef on
 * 2026-09-05; the two differ only in the `0100:`/`0101:` comment tokens the
 * migration renumbering left behind.)
 *
 * It also pins the two things a careless later edit would break: the threshold
 * is written ONCE, and `unlimited` still means what it meant.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8").replace(/\r\n/g, "\n");
const M0105 = read("0105_premium_voices_threshold.sql");
const M0101 = read("0101_school_self_serve_trial.sql");

/** The `create or replace function public.my_fair_use() … $function$;` block. */
function myFairUse(sql: string): string {
  const start = sql.indexOf("create or replace function public.my_fair_use()");
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf("\n$function$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + "\n$function$;".length);
}

/** Remove exactly the additions 0105 declares it makes — nothing else. */
function stripAdditions(block: string): string {
  const kept = block
    .split("\n")
    .filter((l) => {
      const s = l.trim();
      return !(
        s === "premium boolean;" ||
        s === "premium := premium_voices_allowed(uid);" ||
        s === "'premium_voices', premium," ||
        /^--\s*0105:/.test(s)
      );
    })
    .join("\n");
  // The one addition that could not be a whole line: the early `unlimited`
  // return is a single-line jsonb_build_object.
  return kept.split(", 'premium_voices', premium)").join(")");
}

describe("0105 — the migration file", () => {
  it("is numbered above every migration this repo carries and above prod's 0104", () => {
    // The worker repo applied 0104_visual_assets_asset_format separately, so
    // 0104 is taken even though no file for it exists here.
    const numbers = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => Number(f.slice(0, 4)));
    expect(Math.max(...numbers)).toBe(105);
    expect(numbers.filter((n) => n === 105)).toHaveLength(1);
    expect(numbers).not.toContain(104); // taken by the worker repo, never reused here
  });

  it("writes the threshold exactly once, and only inside the helper", () => {
    const code = M0105.split("\n")
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n");
    expect(code.split("100000").length - 1).toBe(1);
    expect(code).toContain("comp_threshold constant integer := 100000;");
    // …and nowhere else in the repo's SQL.
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql") && x !== "0105_premium_voices_threshold.sql")) {
      expect(read(f)).not.toContain("premium_voices_allowed");
    }
  });

  it("defines premium_voices_allowed(uid) as the one place the rule lives", () => {
    expect(M0105).toContain("create or replace function public.premium_voices_allowed(uid uuid)");
    expect(M0105).toContain("returns boolean");
    expect(M0105).toContain(
      "greatest(coalesce(p.max_books, 0), coalesce(p.max_chapters, 0)) >= comp_threshold",
    );
    expect(M0105).toContain(
      "return plan_tier(uid) in ('pro', 'pro_plus', 'family', 'homeschool', 'school');",
    );
    // A null uid must answer "no", not blow up inside my_fair_use.
    expect(M0105).toMatch(/if uid is null then\n\s*return false;/);
  });
});

describe("0105 — my_fair_use is the prod body plus premium_voices, and nothing else", () => {
  const before = myFairUse(M0101);
  const after = myFairUse(M0105);

  it("redefines it", () => {
    expect(after).not.toBe(before);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it("stripping the additions gives back 0101's body, byte for byte", () => {
    expect(stripAdditions(after)).toBe(before);
  });

  it("reads the answer once and reports it in EVERY branch that returns an object", () => {
    expect(after.split("premium := premium_voices_allowed(uid);").length - 1).toBe(1);
    // six returned objects: school_suspended, the early unlimited, school_expired,
    // promo, school_trial, and the ordinary one.
    const returns = before.split("jsonb_build_object(").length - 1;
    expect(after.split("'premium_voices', premium").length - 1).toBe(6);
    expect(returns).toBeGreaterThanOrEqual(6);
    // the two branches that return BEFORE the main object are covered
    expect(after).toMatch(/'tier', tier, 'unlimited', false, 'locked', true,\n\s*'premium_voices', premium,/);
    expect(after).toContain(
      "return jsonb_build_object('tier', 'unlimited', 'unlimited', true, 'premium_voices', premium);",
    );
  });

  it("leaves `unlimited` exactly as it was — any override, any size", () => {
    // The comp-override branch still keys off "set at all", NOT the threshold:
    // the 11 seeded 20-book accounts keep unlimited generation.
    expect(after).toContain("p.max_books is not null or p.max_chapters is not null");
    expect(after).not.toContain("max_books >= ");
    expect(after).toContain("'unlimited', eff_cap >= 2147483647");
    expect(after).toContain("'unlimited', false");
    // and the metering arithmetic is untouched
    for (const line of [
      "select * into caps from fair_use_caps(tier);",
      "eff_cap := caps.parts_cap + fair_use_granted(uid);",
      "select * into c from fair_use_avail(uid, 'credits', eff_cap);",
    ]) {
      expect(after).toContain(line);
    }
  });
});
