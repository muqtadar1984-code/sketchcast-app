/**
 * Parse-check for supabase/migrations/0110_library_members.sql — applied by
 * hand by the founder, so this is the only automated eye on it.
 *
 * The change (topic-catalogue plan §7.1, 2026-09-06): who may enter the Library
 * portal is MEMBERSHIP, granted from the console — never the e-mail domain.
 * What must hold:
 *  • library_members mirrors platform_admins (0014): user_id PK → profiles,
 *    granted_by, note, soft revoke via revoked_at; role is 'editor'|'reviewer'
 *    only — 'admin' is what a platform_admins row already means;
 *  • library_role(uid) answers 'admin' for platform admins FIRST, else the
 *    member's role, else null; is_library_member() is that answer, not null;
 *  • RLS on, everything revoked from anon/authenticated, both functions locked
 *    to the service role (a browser must not be able to list the reviewers);
 *  • the app's grantable roles are exactly the check constraint's values;
 *  • no rows inserted, no plan/cap/credit function touched (portal access is
 *    not product access — that is 0109).
 * Run: npx vitest run src/utils/__tests__/migration-0110-library-members.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { GRANTABLE_LIBRARY_ROLES } from "../library-routing";

const M = readFileSync(
  path.resolve(__dirname, "../../../supabase/migrations/0110_library_members.sql"),
  "utf-8",
).replace(/\r\n/g, "\n");

const code = M.split("\n")
  .map((l) => l.replace(/--.*$/, "").trimEnd())
  .filter((l) => l.trim() !== "")
  .join("\n");

describe("0110 — library_members", () => {
  it("mirrors platform_admins: profile-keyed, granted_by, note, soft revoke", () => {
    expect(code).toContain("create table if not exists public.library_members (");
    expect(code).toContain("user_id    uuid primary key references public.profiles(id) on delete cascade,");
    expect(code).toContain("granted_by uuid references public.profiles(id) on delete set null,");
    expect(code).toContain("revoked_at timestamptz");
    expect(code).toContain("note       text,");
  });

  it("role is exactly the app's grantable roles — admin is not a row", () => {
    const m = code.match(/role\s+text not null check \(role in \(([^)]*)\)\)/);
    expect(m).not.toBeNull();
    const roles = m![1].split(",").map((s) => s.trim().replace(/'/g, "")).sort();
    expect(roles).toEqual([...GRANTABLE_LIBRARY_ROLES].sort());
    expect(roles).not.toContain("admin");
  });

  it("library_role: platform admins first, then the member row, else null", () => {
    const start = code.indexOf("create or replace function public.library_role(uid uuid)");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start, code.indexOf("$$;", start));
    const admin = body.indexOf("(select 'admin' where public.is_platform_admin(uid)),");
    const member = body.indexOf("select m.role from library_members m");
    expect(admin).toBeGreaterThan(-1);
    expect(member).toBeGreaterThan(admin);
    expect(body).toContain("m.revoked_at is null");
    expect(code).toContain("select public.library_role(uid) is not null");
  });

  it("is service-role only: RLS on, no policies, functions locked", () => {
    expect(code).toContain("alter table public.library_members enable row level security;");
    expect(code).toContain("revoke all on public.library_members from anon, authenticated;");
    expect(code.toLowerCase()).not.toContain("create policy");
    for (const fn of ["library_role(uuid)", "is_library_member(uuid)"]) {
      expect(code).toContain(`revoke execute on function public.${fn} from public, anon, authenticated;`);
      expect(code).toContain(`grant execute on function public.${fn} to service_role;`);
      // grant after create, or it grants nothing
      expect(code.indexOf(`grant execute on function public.${fn}`)).toBeGreaterThan(
        code.indexOf(`create or replace function public.${fn.split("(")[0]}(`),
      );
    }
  });

  it("inserts nothing and touches no product function", () => {
    const lower = code.toLowerCase();
    expect(lower).not.toContain("insert into");
    for (const name of ["plan_tier", "fair_use_caps", "premium_voices_allowed", "enforce_fair_use", "credit_ledger_write", "my_fair_use"]) {
      expect(lower).not.toContain(`create or replace function public.${name}(`);
    }
  });

  it("is one transaction and names no e-mail domain", () => {
    expect(code.startsWith("begin;")).toBe(true);
    expect(code.endsWith("commit;")).toBe(true);
    expect(code.toLowerCase()).not.toContain("@sketchcast.app");
  });
});
