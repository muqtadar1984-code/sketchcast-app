// 0173 (written 2026-10-29, dry-run on production inside begin…rollback, NOT
// applied) — SK S6 slice A: the two fact stores, the consent RPC, the audit
// trigger and the retention sweep. Same lint pattern as migration-0171: read
// the SQL, strip comments, assert the DDL the privacy rules rest on.
// Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/migration-0173-sk-memory-consent.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const DIR = path.resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) =>
  readFileSync(path.join(DIR, f), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/--[^\n]*/g, "")
    .replace(/[ \t]+/g, " ")
    .toLowerCase();

const up = read("0173_sk_memory_consent.sql");
const down = read("0173_sk_memory_consent_rollback.sql");

/** The body of one `create or replace function public.<name>(…) … $$;`. */
function fn(name: string): string {
  const start = up.indexOf(`create or replace function public.${name}(`);
  expect(start, `function ${name}`).toBeGreaterThan(-1);
  const end = up.indexOf("$$;", up.indexOf("$$", start) + 2);
  return up.slice(start, end + 3);
}

describe("0173_sk_memory_consent.sql", () => {
  it("is one transaction", () => {
    expect(up.trim().startsWith("begin;")).toBe(true);
    expect(up.trim().endsWith("commit;")).toBe(true);
  });

  it("sk_workflow_facts: owner cascades with the profile, one row per (owner, kind, key), 12 months by default", () => {
    expect(up).toMatch(/create table if not exists public\.sk_workflow_facts \(/);
    expect(up).toMatch(/owner_id uuid not null references public\.profiles\(id\) on delete cascade/);
    expect(up).toMatch(/unique \(owner_id, kind, key\)/);
    expect(up).toMatch(/expires_at timestamptz not null default \(now\(\) \+ interval '12 months'\)/);
    expect(up).toMatch(/value jsonb not null default '\{\}'::jsonb check \(pg_column_size\(value\) <= 8192\)/);
  });

  it("sk_workflow_facts: RLS on, owner-only select/insert/update/delete, and a client can never set a longer expiry", () => {
    expect(up).toMatch(/alter table public\.sk_workflow_facts enable row level security;/);
    expect(up).toMatch(/revoke all on public\.sk_workflow_facts from anon, authenticated;/);
    expect(up).toMatch(/grant select, insert, update, delete on public\.sk_workflow_facts to authenticated;/);
    for (const op of ["select", "insert", "update", "delete"]) {
      expect(up).toMatch(new RegExp(`create policy sk_workflow_facts_${op}_own on public\\.sk_workflow_facts\\s+for ${op} to authenticated`));
    }
    expect(up.match(/owner_id = \(select auth\.uid\(\)\)/g)?.length).toBe(5); // select, insert, update using+check, delete
    expect(up.match(/expires_at <= now\(\) \+ interval '366 days'/g)?.length).toBe(2); // insert + update
    expect(up).not.toMatch(/sk_workflow_facts to anon/);
  });

  it("sk_learning_facts: student cascades, closed kinds, 90 days, and NO client insert or update", () => {
    expect(up).toMatch(/create table if not exists public\.sk_learning_facts \(/);
    expect(up).toMatch(/student_id uuid not null references public\.profiles\(id\) on delete cascade/);
    expect(up).toMatch(/kind text not null check \(kind in \('misconception', 'explained', 'struggled', 'strength'\)\)/);
    expect(up).toMatch(/expires_at timestamptz not null default \(now\(\) \+ interval '90 days'\)/);
    expect(up).toMatch(/alter table public\.sk_learning_facts enable row level security;/);
    expect(up).toMatch(/grant select, delete on public\.sk_learning_facts to authenticated;/);
    expect(up).not.toMatch(/grant[^;]*\binsert\b[^;]*on public\.sk_learning_facts/);
    expect(up).not.toMatch(/grant[^;]*\bupdate\b[^;]*on public\.sk_learning_facts/);
    expect(up).not.toMatch(/on public\.sk_learning_facts\s+for (insert|update|all)/);
    expect(up).toMatch(/create policy sk_learning_facts_select_own on public\.sk_learning_facts\s+for select to authenticated using \(student_id = \(select auth\.uid\(\)\)\);/);
    expect(up).toMatch(/create policy sk_learning_facts_delete_own on public\.sk_learning_facts\s+for delete to authenticated using \(student_id = \(select auth\.uid\(\)\)\);/);
  });

  it("sk_set_consent: SECURITY DEFINER, pinned search_path, VERIFIED parent only, closed scope set", () => {
    const f = fn("sk_set_consent");
    expect(f).toMatch(/\(p_child uuid, p_scope text, p_grant boolean\)\s+returns public\.consents/);
    expect(f).toMatch(/security definer\s+set search_path = public, pg_temp/);
    expect(f).toMatch(/v_me uuid := auth\.uid\(\)/);
    expect(f).toMatch(/pl\.parent_id = v_me and pl\.child_id = p_child and pl\.verified_at is not null/);
    expect(f).toMatch(/p_child = v_me/); // a child cannot consent for themself
    expect(f).toMatch(/p_scope not in \('voice', 'transcripts', 'analytics'\)/);
    expect(f).toMatch(/errcode = '42501'/);
    // grant = upsert with revoked_at null; revoke = set revoked_at
    expect(f).toMatch(/on conflict \(child_id, scope, guardian_id\)\s+do update set granted_at = now\(\), method = 'in_app', revoked_at = null/);
    expect(f).toMatch(/set revoked_at = now\(\)/);
    // the guardian is always the caller, never a parameter
    expect(f).toMatch(/values \(p_child, v_me, p_scope/);
  });

  it("sk_set_consent: revoking transcripts with no other live consent deletes the memory at once (§9.5)", () => {
    const f = fn("sk_set_consent");
    expect(f).toMatch(/if p_scope = 'transcripts'/);
    expect(f).toMatch(/s\.config -> 'sk_learning_memory' = 'true'::jsonb/);
    expect(f).toMatch(/delete from public\.sk_learning_facts where student_id = p_child;/);
    expect(f).toMatch(/update public\.sk_sessions set history = '\[\]'::jsonb\s+where student_id = p_child/);
    // educational records are never touched
    expect(f).not.toMatch(/item_attempts|mastery_state|sk_objective_mastery/);
  });

  it("sk_set_consent is callable by signed-in users only", () => {
    expect(up).toMatch(/revoke all on function public\.sk_set_consent\(uuid, text, boolean\) from public, anon;/);
    expect(up).toMatch(/grant execute on function public\.sk_set_consent\(uuid, text, boolean\) to authenticated;/);
  });

  it("clears sk_actions.params BEFORE a profile is deleted (while actor_id still holds the id)", () => {
    const f = fn("sk_actions_clear_params_on_profile_delete");
    expect(f).toMatch(/returns trigger/);
    expect(f).toMatch(/security definer\s+set search_path = public, pg_temp/);
    expect(f).toMatch(/update public\.sk_actions set params = '\{\}'::jsonb\s+where actor_id = old\.id/);
    expect(f).toMatch(/return old;/);
    expect(up).toMatch(/create trigger sk_actions_clear_params_on_profile_delete\s+before delete on public\.profiles\s+for each row execute function public\.sk_actions_clear_params_on_profile_delete\(\);/);
  });

  it("sk_memory_sweep: expired facts, 90-day tutor history, 12-month audit rows; service role only; returns counts", () => {
    const f = fn("sk_memory_sweep");
    expect(f).toMatch(/returns jsonb/);
    expect(f).toMatch(/security definer\s+set search_path = public, pg_temp/);
    expect(f).toMatch(/delete from public\.sk_workflow_facts where expires_at <= now\(\);/);
    expect(f).toMatch(/delete from public\.sk_learning_facts where expires_at <= now\(\);/);
    expect(f).toMatch(/update public\.sk_sessions set history = '\[\]'::jsonb\s+where history <> '\[\]'::jsonb and updated_at < now\(\) - interval '90 days';/);
    expect(f).toMatch(/delete from public\.sk_actions where at < now\(\) - interval '12 months';/);
    expect(f).toMatch(/jsonb_build_object\('workflow_facts', v_workflow, 'learning_facts', v_learning, 'history_cleared', v_history, 'sk_actions', v_actions\)/);
    expect(f).not.toMatch(/item_attempts|mastery_state|sk_objective_mastery|assistant_messages/);
    expect(up).toMatch(/revoke all on function public\.sk_memory_sweep\(\) from public, anon, authenticated;/);
    expect(up).toMatch(/grant execute on function public\.sk_memory_sweep\(\) to service_role;/);
  });

  it("every SECURITY DEFINER function pins its search_path", () => {
    const definers = up.match(/security definer/g)?.length ?? 0;
    expect(definers).toBe(3);
    expect(up.match(/security definer\s+set search_path = public, pg_temp/g)?.length).toBe(definers);
  });

  it("does not touch Ask Coach or the educational records", () => {
    expect(up).not.toMatch(/assistant_messages/);
    expect(up).not.toMatch(/(alter|drop|create)[^;]*(item_attempts|mastery_state|sk_objective_mastery)/);
    expect(up).not.toMatch(/alter table public\.consents|drop table/);
  });

  it("has a rollback that drops exactly what 0173 created", () => {
    expect(down.trim().startsWith("begin;")).toBe(true);
    expect(down.trim().endsWith("commit;")).toBe(true);
    expect(down).toMatch(/drop function if exists public\.sk_memory_sweep\(\);/);
    expect(down).toMatch(/drop trigger if exists sk_actions_clear_params_on_profile_delete on public\.profiles;/);
    expect(down).toMatch(/drop function if exists public\.sk_actions_clear_params_on_profile_delete\(\);/);
    expect(down).toMatch(/drop function if exists public\.sk_set_consent\(uuid, text, boolean\);/);
    expect(down).toMatch(/drop table if exists public\.sk_learning_facts;/);
    expect(down).toMatch(/drop table if exists public\.sk_workflow_facts;/);
    expect(down).not.toMatch(/drop table if exists public\.(consents|profiles|sk_actions)\b/);
    expect(down).not.toMatch(/delete from|update /);
  });
});
