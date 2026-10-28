-- 0162: SK's own three tables (Final Plan 2026-10-28 §3 "one migration",
-- §5.2 Kit Manifest, §8.2 action tokens, §9.6 pinning/invalidation).
--
-- sk_actions        — the audit trail of everything SK did or was asked to do:
--                     immediate moves (navigate, Board moves — kind nav/board),
--                     reads, confirm-tier actions and queued jobs. Written by
--                     the server with the service role; one row per call, kept
--                     even when the call failed (ok=false + error).
-- sk_action_tokens  — server-issued, single-use tokens for confirm-tier
--                     actions (§8.2). The HMAC is re-derived at execution time
--                     from the STORED parameters, so a client can never alter
--                     what it confirmed. consume is atomic (§9.2).
-- sk_manifests      — the cached Kit Manifest per generation (§5.2), pinned
--                     to the artifact rows it was derived from. Any change to
--                     that generation's artifacts flips it to 'stale' by
--                     trigger, so a stale manifest is never served (§9.6).
--
-- Same doctrine as platform_admins (0014) and pub_* (0161): deny-by-default
-- RLS with NO policies and no grants to anon/authenticated. Only the service
-- role (the /api/sk/* routes, after their own permission checks against the
-- Context) reads or writes these tables (§8.1).
--
-- Run as ONE execution. Idempotent.
begin;

-- ── Audit ────────────────────────────────────────────────────────────────────
create table if not exists public.sk_actions (
  id              uuid primary key default gen_random_uuid(),
  actor_id        uuid references public.profiles(id) on delete set null,
  school_id       uuid,                      -- snapshot of the Context, not a fk
  role            text,
  hat             text,
  action          text not null,             -- registry name, e.g. "navigate", "board.seek"
  tier            text not null check (tier in ('immediate','confirm','queued')),
  kind            text not null check (kind in ('nav','board','read','act','job')),
  params          jsonb not null default '{}'::jsonb,
  ok              boolean not null,
  result          jsonb,
  error           text,
  session_id      text,                      -- present session / assistant session, whichever applies
  generation_id   uuid,                      -- not a fk: audit outlives the kit
  token_id        uuid,                      -- set below, after the tokens table exists
  turn_id         text,                      -- the transcript turn that caused it
  at              timestamptz not null default now(),
  ms              integer
);
create index if not exists sk_actions_actor_at_idx on public.sk_actions (actor_id, at desc);
create index if not exists sk_actions_session_idx  on public.sk_actions (session_id) where session_id is not null;
create index if not exists sk_actions_at_idx       on public.sk_actions (at desc);

-- ── Action tokens ────────────────────────────────────────────────────────────
create table if not exists public.sk_action_tokens (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  action           text not null,
  params           jsonb not null default '{}'::jsonb,
  params_canonical text not null,            -- canonical(params): what the HMAC covers
  context_hash     text not null,            -- hash of {role, school, hat, plan} at issue time
  nonce            text not null,
  hmac             text not null,            -- HMAC(secret, user_id ∥ action ∥ canonical ∥ context_hash ∥ nonce ∥ exp)
  expires_at       timestamptz not null,
  used_at          timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists sk_action_tokens_user_idx on public.sk_action_tokens (user_id, expires_at desc);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sk_actions_token_fk') then
    alter table public.sk_actions
      add constraint sk_actions_token_fk foreign key (token_id)
      references public.sk_action_tokens(id) on delete set null;
  end if;
end $$;

-- Atomic consume (§9.2). Marks the token used ONLY if it is unused, unexpired
-- and the live context hash matches; returns the outcome. Per-action RPCs in
-- S2 call this inside their own transaction so consume + write are one unit.
create or replace function public.sk_consume_action_token(p_token uuid, p_context_hash text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.sk_action_tokens%rowtype;
  n int;
begin
  select * into r from public.sk_action_tokens where id = p_token for update;
  if not found then
    return 'not_found';
  end if;
  if r.used_at is not null then
    return 'already_used';
  end if;
  if r.expires_at <= now() then
    return 'expired';
  end if;
  if r.context_hash is distinct from p_context_hash then
    return 'context_mismatch';
  end if;
  update public.sk_action_tokens
     set used_at = now()
   where id = p_token and used_at is null;
  get diagnostics n = row_count;
  if n = 1 then
    return 'done';
  end if;
  return 'already_used';
end $$;
revoke all on function public.sk_consume_action_token(uuid, text) from public, anon, authenticated;
grant execute on function public.sk_consume_action_token(uuid, text) to service_role;

-- ── Kit Manifests ────────────────────────────────────────────────────────────
create table if not exists public.sk_manifests (
  generation_id     uuid primary key references public.generations(id) on delete cascade,
  manifest_id       text not null,
  script_id         text,
  video_manifest_id text,
  format_version    text,
  artifact_hash     text not null,            -- hash of the artifacts rows (id, kind, storage_path) at derivation
  artifact_paths    text[] not null default '{}',
  manifest          jsonb not null,           -- the KitManifest document (§5.2 + §9.1)
  completeness      jsonb,
  derived_by        jsonb,                    -- {model, prompt_version, at}
  status            text not null default 'ready' check (status in ('ready','stale','building','failed')),
  stale_reason      text,
  built_at          timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists sk_manifests_status_idx on public.sk_manifests (status) where status <> 'ready';

-- §9.6: any change to a generation's artifacts rows invalidates its manifest.
-- A stale manifest is never served; the rebuild is queued by the app (S1).
create or replace function public.sk_manifest_invalidate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  g uuid := coalesce(new.generation_id, old.generation_id);
begin
  update public.sk_manifests
     set status = 'stale',
         stale_reason = 'artifacts ' || lower(tg_op) || ' at ' || now()::text,
         updated_at = now()
   where generation_id = g and status <> 'stale';
  return null;
end $$;
revoke all on function public.sk_manifest_invalidate() from public, anon, authenticated;

drop trigger if exists sk_manifest_invalidate_on_artifacts on public.artifacts;
create trigger sk_manifest_invalidate_on_artifacts
  after insert or update or delete on public.artifacts
  for each row execute function public.sk_manifest_invalidate();

-- ── Deny by default ──────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['sk_actions','sk_action_tokens','sk_manifests'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

commit;
