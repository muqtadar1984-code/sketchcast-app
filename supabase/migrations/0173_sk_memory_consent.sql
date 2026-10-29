-- 0173: SK S6 slice A — consent, the two SK fact stores, retention
-- (Final Plan 2026-10-28 §8.1, §9.5; SK S6 design 2026-10-29 decisions 1, 2,
-- 3, 4 and 7).
--
-- sk_workflow_facts  — SK's WORKFLOW memory for an adult (teacher, principal,
--                      parent-as-manager): recent classes and kits, pending
--                      tasks, preferences. Owned by the user; the owner reads,
--                      writes and deletes their own rows through the SESSION
--                      client (RLS below). 12 months rolling (§9.5): every
--                      write sets expires_at = now() + 12 months, and a client
--                      can never set it further out than that.
-- sk_learning_facts  — SK's conversational memory about a STUDENT:
--                      misconceptions SK noticed, what it explained, where the
--                      student struggled or is strong. 90 days (§9.5).
--                      The student reads and deletes their own rows; NOBODY
--                      inserts from a client — the server writes them with the
--                      service role, and only after a consent check
--                      (src/sk/consent.ts, src/sk/facts.ts noteLearning).
-- sk_set_consent()   — the ONLY writer of `consents` (0158): a VERIFIED linked
--                      parent grants or revokes a scope for their child.
--                      Revoking `transcripts` when no other live consent
--                      remains (no other verified guardian, no school switch)
--                      deletes the child's learning facts and clears their
--                      tutor history at once (§9.5 "on consent revocation;
--                      immediate").
-- sk_actions_clear_params_on_profile_delete — a deleted user's SK audit rows
--                      keep the row (actor_id goes NULL by 0163's FK) but lose
--                      their params (decision 1).
-- sk_memory_sweep()  — the daily retention sweep (service role only), called
--                      from the existing cron /api/lifecycle/reminders.
--
-- Educational records (item_attempts, mastery_state, sk_objective_mastery)
-- are NOT touched here: §9.5 keeps them on their existing rules.
-- Ask Coach (assistant_messages) is NOT touched (decision 4).
--
-- Run as ONE execution. Idempotent.
begin;

-- ── 1. Workflow facts (adult; owner-only) ────────────────────────────────────
create table if not exists public.sk_workflow_facts (
  id          uuid        primary key default gen_random_uuid(),
  owner_id    uuid        not null references public.profiles(id) on delete cascade,
  kind        text        not null check (kind ~ '^[a-z][a-z_]{1,39}$'),   -- recent_class | recent_kit | pending_task | preference | …
  key         text        not null check (length(key) between 1 and 200),
  value       jsonb       not null default '{}'::jsonb check (pg_column_size(value) <= 8192),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '12 months'),
  unique (owner_id, kind, key)
);
create index if not exists sk_workflow_facts_expires_idx on public.sk_workflow_facts (expires_at);
drop trigger if exists sk_workflow_facts_touch on public.sk_workflow_facts;
create trigger sk_workflow_facts_touch before update on public.sk_workflow_facts
  for each row execute function touch_updated_at();

alter table public.sk_workflow_facts enable row level security;
revoke all on public.sk_workflow_facts from anon, authenticated;
grant select, insert, update, delete on public.sk_workflow_facts to authenticated;

drop policy if exists sk_workflow_facts_select_own on public.sk_workflow_facts;
create policy sk_workflow_facts_select_own on public.sk_workflow_facts
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists sk_workflow_facts_insert_own on public.sk_workflow_facts;
create policy sk_workflow_facts_insert_own on public.sk_workflow_facts
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and expires_at <= now() + interval '366 days');

drop policy if exists sk_workflow_facts_update_own on public.sk_workflow_facts;
create policy sk_workflow_facts_update_own on public.sk_workflow_facts
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and expires_at <= now() + interval '366 days');

drop policy if exists sk_workflow_facts_delete_own on public.sk_workflow_facts;
create policy sk_workflow_facts_delete_own on public.sk_workflow_facts
  for delete to authenticated using (owner_id = (select auth.uid()));

-- ── 2. Learning facts (student; server-written after consent) ───────────────
create table if not exists public.sk_learning_facts (
  id             uuid        primary key default gen_random_uuid(),
  student_id     uuid        not null references public.profiles(id) on delete cascade,
  kind           text        not null check (kind in ('misconception', 'explained', 'struggled', 'strength')),
  objective_key  text,                                   -- "<article_id>:<objective_ref>" (src/sk/objective-key.ts); null = unmapped
  detail         jsonb       not null default '{}'::jsonb check (pg_column_size(detail) <= 8192),
  source         text        not null check (source ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default (now() + interval '90 days')
);
create index if not exists sk_learning_facts_student_idx on public.sk_learning_facts (student_id, created_at desc);
create index if not exists sk_learning_facts_expires_idx on public.sk_learning_facts (expires_at);

alter table public.sk_learning_facts enable row level security;
revoke all on public.sk_learning_facts from anon, authenticated;
-- Read and delete only: there is deliberately NO insert or update grant.
grant select, delete on public.sk_learning_facts to authenticated;

drop policy if exists sk_learning_facts_select_own on public.sk_learning_facts;
create policy sk_learning_facts_select_own on public.sk_learning_facts
  for select to authenticated using (student_id = (select auth.uid()));

drop policy if exists sk_learning_facts_delete_own on public.sk_learning_facts;
create policy sk_learning_facts_delete_own on public.sk_learning_facts
  for delete to authenticated using (student_id = (select auth.uid()));

-- ── 3. Consent: grant / revoke by a VERIFIED linked parent ──────────────────
create or replace function public.sk_set_consent(p_child uuid, p_scope text, p_grant boolean)
returns public.consents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me  uuid := auth.uid();
  v_row public.consents;
begin
  if v_me is null then
    raise exception 'sk_set_consent: not signed in' using errcode = '42501';
  end if;
  if p_scope is null or p_scope not in ('voice', 'transcripts', 'analytics') then
    raise exception 'sk_set_consent: unknown scope' using errcode = '22023';
  end if;
  if p_grant is null then
    raise exception 'sk_set_consent: grant must be true or false' using errcode = '22023';
  end if;
  if p_child is null or p_child = v_me or not exists (
    select 1 from public.parent_links pl
     where pl.parent_id = v_me and pl.child_id = p_child and pl.verified_at is not null
  ) then
    raise exception 'sk_set_consent: not a verified parent of this child' using errcode = '42501';
  end if;

  if p_grant then
    insert into public.consents (child_id, guardian_id, scope, granted_at, method, revoked_at)
    values (p_child, v_me, p_scope, now(), 'in_app', null)
    on conflict (child_id, scope, guardian_id)
      do update set granted_at = now(), method = 'in_app', revoked_at = null
    returning * into v_row;
  else
    update public.consents
       set revoked_at = now()
     where child_id = p_child and scope = p_scope and guardian_id = v_me and revoked_at is null
    returning * into v_row;
    if v_row.id is null then
      select * into v_row from public.consents
       where child_id = p_child and scope = p_scope and guardian_id = v_me;
    end if;

    -- §9.5: memory goes immediately on revocation — unless another live
    -- consent still covers the child (another verified guardian, or the
    -- school's learning-memory switch).
    if p_scope = 'transcripts'
       and not exists (
         select 1 from public.consents c
           join public.parent_links pl
             on pl.parent_id = c.guardian_id and pl.child_id = c.child_id and pl.verified_at is not null
          where c.child_id = p_child and c.scope = 'transcripts' and c.revoked_at is null
       )
       and not exists (
         select 1 from public.profiles p
           join public.schools s on s.id = p.school_id
          where p.id = p_child and s.config -> 'sk_learning_memory' = 'true'::jsonb
       )
    then
      delete from public.sk_learning_facts where student_id = p_child;
      update public.sk_sessions set history = '[]'::jsonb
       where student_id = p_child and history <> '[]'::jsonb;
    end if;
  end if;

  return v_row;
end;
$$;
revoke all on function public.sk_set_consent(uuid, text, boolean) from public, anon;
grant execute on function public.sk_set_consent(uuid, text, boolean) to authenticated;

-- ── 4. A deleted user's SK audit rows lose their params ──────────────────────
-- BEFORE DELETE on profiles: it runs while sk_actions.actor_id still holds the
-- id; 0163's ON DELETE SET NULL is an AFTER (referential) action, so it runs
-- later. The row itself (action, ok, at…) stays for 12 months, then the sweep.
create or replace function public.sk_actions_clear_params_on_profile_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.sk_actions set params = '{}'::jsonb
   where actor_id = old.id and params <> '{}'::jsonb;
  return old;
end;
$$;
revoke all on function public.sk_actions_clear_params_on_profile_delete() from public, anon, authenticated;

drop trigger if exists sk_actions_clear_params_on_profile_delete on public.profiles;
create trigger sk_actions_clear_params_on_profile_delete
  before delete on public.profiles
  for each row execute function public.sk_actions_clear_params_on_profile_delete();

-- ── 5. Retention sweep (service role only; the daily cron) ──────────────────
create or replace function public.sk_memory_sweep()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_workflow int;
  v_learning int;
  v_history  int;
  v_actions  int;
begin
  delete from public.sk_workflow_facts where expires_at <= now();
  get diagnostics v_workflow = row_count;
  delete from public.sk_learning_facts where expires_at <= now();
  get diagnostics v_learning = row_count;
  -- Tutor history is SK conversational memory too (§9.5, 90 days).
  update public.sk_sessions set history = '[]'::jsonb
   where history <> '[]'::jsonb and updated_at < now() - interval '90 days';
  get diagnostics v_history = row_count;
  -- Audit rows: 12 months (decision 1).
  delete from public.sk_actions where at < now() - interval '12 months';
  get diagnostics v_actions = row_count;
  return jsonb_build_object('workflow_facts', v_workflow, 'learning_facts', v_learning, 'history_cleared', v_history, 'sk_actions', v_actions);
end;
$$;
revoke all on function public.sk_memory_sweep() from public, anon, authenticated;
grant execute on function public.sk_memory_sweep() to service_role;

comment on table public.sk_workflow_facts is 'SK S6: workflow memory for an adult (recent class/kit, pending task, preference). Owner-only RLS; 12 months rolling (Final Plan §9.5).';
comment on table public.sk_learning_facts is 'SK S6: conversational memory about a student. Server-written after a consent check; the student reads/deletes their own. 90 days (Final Plan §9.5).';
comment on function public.sk_set_consent(uuid, text, boolean) is 'SK S6: a verified linked parent grants or revokes a consents scope for their child. Revoking transcripts with no other live consent deletes learning facts and tutor history.';
comment on function public.sk_memory_sweep() is 'SK S6: daily retention sweep (expired facts, 90-day tutor history, 12-month sk_actions). Service role only.';

commit;
