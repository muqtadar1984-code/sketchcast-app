/**
 * Parse-check for supabase/migrations/0109_staff_tier.sql — applied by hand by
 * the founder, so this is the only automated eye on it.
 *
 * The change (topic-catalogue plan §1.5, 2026-09-06): SketchCast staff are
 * premium users of their own product. `staff` is a plan_tier value decided by
 * MEMBERSHIP (an unrevoked platform_admins row), never by the e-mail domain —
 * the demo accounts are @sketchcast.app and must stay on trial. What must hold:
 *  • plan_tier(): the staff branch is FIRST — above school_suspended — and
 *    keys on is_platform_admin(uid); every other branch is 0101's, verbatim
 *    (0101's body was verified against prod with pg_get_functiondef on
 *    2026-09-06 and reproduced here);
 *  • fair_use_caps(): one new row, ('staff', sentinel, sentinel, sentinel);
 *    strip it and the body is byte-identical to 0107's;
 *  • premium_voices_allowed(): the SAME helper 0105 defined, with the same
 *    threshold line and the same ACL, and the paid list is 0105's plus 'staff';
 *  • THE FREE-RIDE GUARANTEE (inherited from 0103/0107): credit_ledger_write,
 *    fair_use_used and fair_use_used_since are NOT redefined here;
 *  • nothing INSERTS a platform_admins row: who is staff is the console's
 *    decision, per account, never a migration's.
 * Run: npx vitest run src/utils/__tests__/migration-0109-staff-tier.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PAID_VOICE_TIERS } from "../narration";
import { PRESENT_TIERS } from "../present/access";

const MIG = path.resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIG, f), "utf-8").replace(/\r\n/g, "\n");
const M0109 = read("0109_staff_tier.sql");
const M0107 = read("0107_seven_piece_kit_allowances.sql");
const M0105 = read("0105_premium_voices_threshold.sql");

/** The `create or replace function public.<name>(…) … $tag$;` block, given the tag. */
function fn(sql: string, name: string, tag: string): string {
  // Anchored to a line start: 0107's header COMMENT names the function too, and
  // a bare indexOf would slice from the prose, not the DDL.
  const m = new RegExp("^create or replace function public[.]" + name + "[(]", "m").exec(sql);
  expect(m, `${name} not found`).not.toBeNull();
  const start = m!.index;
  const end = sql.indexOf(`\n${tag};`, start);
  expect(end, `${name} has no closing ${tag};`).toBeGreaterThan(start);
  return sql.slice(start, end + `\n${tag};`.length);
}

/** Comment-stripped DDL only. */
const code = (sql: string) =>
  sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, "").trimEnd())
    .filter((l) => l.trim() !== "")
    .join("\n");

describe("0109 — plan_tier", () => {
  const body = fn(M0109, "plan_tier", "$$");

  it("returns 'staff' for platform_admins members, and nothing else decides it", () => {
    expect(body).toContain("(select 'staff' where public.is_platform_admin(uid)),");
    // Never the e-mail domain.
    expect(M0109.toLowerCase()).not.toContain("sketchcast.app'");
    expect(body).not.toMatch(/email/i);
  });

  it("puts staff FIRST — above the school suspension lock", () => {
    const staff = body.indexOf("'staff'");
    const suspended = body.indexOf("'school_suspended'");
    expect(staff).toBeGreaterThan(-1);
    expect(suspended).toBeGreaterThan(staff);
  });

  it("keeps every 0101 branch, in 0101's order", () => {
    const order = ["'staff'", "'school_suspended'", "'school'", "'pro_plus'", "'school_trial'", "'school_expired'", "'promo'", "'trial'"];
    let last = -1;
    for (const tok of order) {
      const i = body.indexOf(tok, last + 1);
      expect(i, `${tok} out of order`).toBeGreaterThan(last);
      last = i;
    }
    expect(M0109).toContain("revoke execute on function public.plan_tier(uuid) from public, anon, authenticated;");
  });
});

describe("0109 — fair_use_caps", () => {
  const mine = fn(M0109, "fair_use_caps", "$function$");
  const theirs = fn(M0107, "fair_use_caps", "$function$");

  it("adds exactly one row: staff, unlimited on all three columns", () => {
    expect(mine).toContain("('staff',     2147483647, 2147483647, 2147483647),");
    expect(mine.split("'staff'").length - 1).toBe(1);
  });

  it("is otherwise byte-identical to 0107's body", () => {
    const stripped = code(mine)
      .split("\n")
      .filter((l) => !l.includes("'staff'"))
      .join("\n");
    expect(stripped).toBe(code(theirs));
  });
});

describe("0109 — premium_voices_allowed", () => {
  const mine = fn(M0109, "premium_voices_allowed", "$function$");
  const theirs = fn(M0105, "premium_voices_allowed", "$function$");

  it("keeps 0105's threshold line and its null guard", () => {
    expect(mine).toContain("comp_threshold constant integer := 100000;");
    expect(code(mine).split("100000").length - 1).toBe(1);
    expect(mine).toMatch(/if uid is null then\n\s*return false;/);
    expect(mine).toContain("greatest(coalesce(p.max_books, 0), coalesce(p.max_chapters, 0)) >= comp_threshold");
  });

  it("the paid list is 0105's plus 'staff' — and equals the app's PAID_VOICE_TIERS", () => {
    const list = (b: string) => {
      const m = b.match(/return plan_tier\(uid\) in \(([^)]*)\);/);
      expect(m).not.toBeNull();
      return m![1].split(",").map((t) => t.trim().replace(/'/g, "")).sort();
    };
    const before = list(theirs);
    const after = list(mine);
    expect(after).toEqual([...before, "staff"].sort());
    expect(after).toEqual([...PAID_VOICE_TIERS].sort());
  });

  it("re-states the service-role-only ACL after the create", () => {
    const create = M0109.indexOf("create or replace function public.premium_voices_allowed");
    const revoke = M0109.indexOf("revoke execute on function public.premium_voices_allowed(uuid) from public, anon, authenticated;");
    const grant = M0109.indexOf("grant execute on function public.premium_voices_allowed(uuid) to service_role;");
    expect(revoke).toBeGreaterThan(create);
    expect(grant).toBeGreaterThan(create);
  });
});

describe("0109 — what it must not do", () => {
  it("does not redefine the billing functions (the free-ride guarantee)", () => {
    for (const name of ["credit_ledger_write", "fair_use_used", "fair_use_used_since", "enforce_fair_use", "my_fair_use"]) {
      expect(M0109).not.toContain(`create or replace function public.${name}(`);
    }
  });

  it("inserts no rows anywhere — who is staff is the console's call", () => {
    expect(code(M0109).toLowerCase()).not.toContain("insert into");
    expect(code(M0109).toLowerCase()).not.toContain("update ");
  });

  it("is wrapped in one transaction", () => {
    const c = code(M0109);
    expect(c.startsWith("begin;")).toBe(true);
    expect(c.endsWith("commit;")).toBe(true);
  });
});

describe("0109 — the app agrees", () => {
  it("staff may drive a Present board", () => {
    expect(PRESENT_TIERS.has("staff")).toBe(true);
  });
});
