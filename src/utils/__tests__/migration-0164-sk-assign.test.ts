// 0164 (written 2026-10-28, dry-run on production inside begin…rollback, NOT
// applied) — `assign`, SK's first confirm-tier action (Final Plan §2.5, §4,
// §8.2, §9.2). Same lint pattern as migration-0163-sk-actions: read the SQL,
// strip comments, assert the DDL the plan's security rules rest on.
// Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/migration-0164-sk-assign.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const DIR = path.resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) =>
  readFileSync(path.join(DIR, f), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/--[^\n]*/g, "")
    .toLowerCase();

const up = read("0164_sk_assign_action.sql");
const down = read("0164_sk_assign_action_rollback.sql");

describe("0164_sk_assign_action.sql", () => {
  it("defines the one RPC, security definer with a pinned search_path, service_role only (§8.1)", () => {
    expect(up).toMatch(/create or replace function public\.sk_assign_with_token\(p_token uuid, p_context_hash text\)\s+returns jsonb/);
    expect(up).toMatch(/security definer\s+set search_path = public/);
    expect(up).toMatch(/revoke all on function public\.sk_assign_with_token\(uuid, text\) from public, anon, authenticated/);
    expect(up).toMatch(/grant execute on function public\.sk_assign_with_token\(uuid, text\) to service_role/);
    expect(up).not.toMatch(/grant .* to authenticated/);
    expect(up).not.toMatch(/create policy/);
    // exactly one function, no tables
    expect([...up.matchAll(/create or replace function/g)]).toHaveLength(1);
    expect(up).not.toMatch(/create table/);
  });

  it("locks the token row and consumes it through 0163's sk_consume_action_token before any write (§9.2 atomic)", () => {
    expect(up).toMatch(/select \* into r from public\.sk_action_tokens where id = p_token for update/);
    expect(up).toMatch(/outcome := public\.sk_consume_action_token\(p_token, p_context_hash\)/);
    const consumeAt = up.indexOf("sk_consume_action_token(p_token");
    const writeAt = up.indexOf("insert into public.generation_shares");
    expect(consumeAt).toBeGreaterThan(0);
    expect(writeAt).toBeGreaterThan(consumeAt);
    // a non-done consume returns at once with that outcome and writes nothing
    expect(up).toMatch(/if outcome <> 'done' then\s+return jsonb_build_object\('outcome', outcome\);/);
  });

  it("reads the params from the STORED token row, never from an argument (§8.2)", () => {
    expect(up).toMatch(/r\.params->>'generation_id'/);
    expect(up).toMatch(/r\.params->>'class_id'/);
    expect(up).toMatch(/r\.params->>'due_at'/);
    // the only arguments are the token id and the live context hash
    expect(up).not.toMatch(/p_generation|p_class|p_due/);
  });

  it("checks BOTH ownerships — the generation (own, live, done, assignable kind) and the class (own) — RLS checks only the first", () => {
    expect(up).toMatch(/from public\.generations g\s+where g\.id = v_generation\s+and g\.owner_id = r\.user_id\s+and g\.withdrawn_at is null\s+and g\.status = 'done'\s+and g\.kind::text not in \('lesson_plan', 'question_bank'\)/);
    expect(up).toMatch(/from public\.classes c\s+where c\.id = v_class\s+and c\.teacher_id = r\.user_id/);
    expect(up).toContain("'generation_not_assignable'");
    expect(up).toContain("'class_not_owned'");
    expect(up).toContain("'bad_params'");
  });

  it("a refusal burns the token (no raise after the consume); only a wrong-action token is refused BEFORE the consume", () => {
    expect(up).not.toMatch(/raise exception/);
    const wrongAction = up.indexOf("'wrong_action'");
    const consumeAt = up.indexOf("sk_consume_action_token(p_token");
    expect(wrongAction).toBeGreaterThan(0);
    expect(wrongAction).toBeLessThan(consumeAt);
    expect(up).toMatch(/if r\.action is distinct from 'assign' then/);
  });

  it("upserts generation_shares on (generation_id, class_id) — the §9.2 idempotency key — updating the due date like the Library does", () => {
    expect(up).toMatch(/insert into public\.generation_shares \(generation_id, class_id, shared_by, due_at\)/);
    expect(up).toMatch(/on conflict \(generation_id, class_id\) do update\s+set due_at = excluded\.due_at,\s+shared_by = excluded\.shared_by\s+returning id into v_share/);
    expect(up).not.toMatch(/student_id/); // class shares only in S1
  });

  it("writes the sk_actions audit row with the token id, tier confirm, kind act", () => {
    expect(up).toMatch(/insert into public\.sk_actions\s+\(actor_id, school_id, action, tier, kind, params, ok, result, generation_id, token_id, at, ms\)/);
    expect(up).toMatch(/'assign', 'confirm', 'act', r\.params, true,\s+jsonb_build_object\('share_id', v_share\), v_generation, p_token, now\(\), 0\)/);
  });

  it("returns the plan's outcome vocabulary", () => {
    for (const o of ["'not_found'", "'refused'", "'done'"]) expect(up).toContain(`'outcome', ${o}`);
    expect(up).toMatch(/'outcome', 'done',\s+'share_id', v_share,\s+'class_id', v_class,\s+'generation_id', v_generation,\s+'due_at', v_due/);
  });

  it("is one idempotent transaction", () => {
    expect(up.trim().startsWith("begin;")).toBe(true);
    expect(up.trim().endsWith("commit;")).toBe(true);
    expect(up).toMatch(/create or replace function/);
  });

  it("has a rollback that drops the function and nothing else", () => {
    expect(down).toMatch(/drop function if exists public\.sk_assign_with_token\(uuid, text\)/);
    expect(down).not.toMatch(/drop table/);
    expect(down).not.toMatch(/sk_consume_action_token/);
  });
});
