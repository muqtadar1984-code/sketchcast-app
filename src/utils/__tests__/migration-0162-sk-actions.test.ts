// 0162 — SK's audit, action-token and manifest tables (Final Plan §3, §5.2,
// §8.2, §9.2, §9.6). Same lint pattern as migration-0107-caps: read the SQL,
// strip comments, assert the DDL that the plan's security rules rest on.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const DIR = path.resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) =>
  readFileSync(path.join(DIR, f), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/--[^\n]*/g, "")
    .toLowerCase();

const up = read("0162_sk_actions_manifests_tokens.sql");
const down = read("0162_sk_actions_manifests_tokens_rollback.sql");

describe("0162_sk_actions_manifests_tokens.sql", () => {
  it("creates exactly the three tables the plan names (§3: one migration)", () => {
    for (const t of ["sk_actions", "sk_action_tokens", "sk_manifests"]) {
      expect(up).toMatch(new RegExp(`create table if not exists public\\.${t}\\s*\\(`));
    }
    const created = [...up.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
    expect(created.sort()).toEqual(["sk_action_tokens", "sk_actions", "sk_manifests"]);
  });

  it("is deny-by-default: RLS on and no grants to anon/authenticated, with NO policies (§8.1)", () => {
    expect(up).toMatch(/array\['sk_actions','sk_action_tokens','sk_manifests'\]/);
    expect(up).toMatch(/enable row level security/);
    expect(up).toMatch(/revoke all on public\.%i from anon, authenticated/);
    expect(up).not.toMatch(/create policy/);
    expect(up).not.toMatch(/grant .* to authenticated/);
  });

  it("audit rows carry tier and kind from the plan's closed sets (§2.5)", () => {
    expect(up).toMatch(/tier\s+text not null check \(tier in \('immediate','confirm','queued'\)\)/);
    expect(up).toMatch(/kind\s+text not null check \(kind in \('nav','board','read','act','job'\)\)/);
    // the audit outlives the user and the kit: no cascade on those columns
    expect(up).toMatch(/actor_id\s+uuid references public\.profiles\(id\) on delete set null/);
    expect(up).not.toMatch(/generation_id\s+uuid references/);
  });

  it("tokens: HMAC over stored params, expiry, single use, atomic consume (§8.2, §9.2)", () => {
    for (const col of ["params_canonical", "context_hash", "nonce", "hmac", "expires_at", "used_at"]) {
      expect(up).toMatch(new RegExp(`\\b${col}\\s`));
    }
    expect(up).toMatch(/create or replace function public\.sk_consume_action_token\(p_token uuid, p_context_hash text\)/);
    expect(up).toMatch(/for update/); // row lock: a concurrent second consume waits, then sees used_at
    for (const outcome of ["'not_found'", "'already_used'", "'expired'", "'context_mismatch'", "'done'"]) {
      expect(up).toContain(`return ${outcome}`);
    }
    expect(up).toMatch(/where id = p_token and used_at is null/);
    expect(up).toMatch(/revoke all on function public\.sk_consume_action_token\(uuid, text\) from public, anon, authenticated/);
    expect(up).toMatch(/grant execute on function public\.sk_consume_action_token\(uuid, text\) to service_role/);
  });

  it("manifests pin what §9.6 requires and go stale when the artifacts change", () => {
    for (const col of ["manifest_id", "script_id", "video_manifest_id", "format_version", "artifact_hash", "artifact_paths"]) {
      expect(up).toMatch(new RegExp(`\\b${col}\\s`));
    }
    expect(up).toMatch(/status\s+text not null default 'ready' check \(status in \('ready','stale','building','failed'\)\)/);
    expect(up).toMatch(/create trigger sk_manifest_invalidate_on_artifacts\s+after insert or update or delete on public\.artifacts/);
    expect(up).toMatch(/set status = 'stale'/);
    expect(up).toMatch(/generation_id\s+uuid primary key references public\.generations\(id\) on delete cascade/);
  });

  it("is one idempotent transaction", () => {
    expect(up.trim().startsWith("begin;")).toBe(true);
    expect(up.trim().endsWith("commit;")).toBe(true);
    expect(up).toMatch(/drop trigger if exists sk_manifest_invalidate_on_artifacts/);
    expect(up).not.toMatch(/create table public\./); // only "if not exists"
  });

  it("has a rollback that removes everything it created, in dependency order", () => {
    const order = [
      "drop trigger if exists sk_manifest_invalidate_on_artifacts",
      "drop function if exists public.sk_manifest_invalidate()",
      "drop function if exists public.sk_consume_action_token(uuid, text)",
      "drop constraint if exists sk_actions_token_fk",
      "drop table if exists public.sk_manifests",
      "drop table if exists public.sk_action_tokens",
      "drop table if exists public.sk_actions",
    ];
    let last = -1;
    for (const stmt of order) {
      const i = down.indexOf(stmt);
      expect(i, stmt).toBeGreaterThan(last);
      last = i;
    }
  });
});
