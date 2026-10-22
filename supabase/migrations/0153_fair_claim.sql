-- 0153_fair_claim — fair-share claiming, queue holds, and cancel/stop with
-- refunds (generation-surge plan Phase 2, approved 2026-10-22)
--
-- Sara's Sci 7 (2026-10-22): one Generate all queued ~250 jobs; the worker
-- claimed strictly oldest-first, so every job behind them — any other
-- teacher's included — waited a median 68 min, up to 143. Staff could neither
-- pause the batch nor stop a doomed render without hand-written SQL.
--
-- WHAT IT ADDS
--   claim_fair_job(...)        the worker's user-lane claim, in SQL (service
--                              role). Same filters as worker/client.py
--                              claim_next_job (status, types, catalogue flag,
--                              params.deferred_until) PLUS:
--                                · held owners/books are skipped;
--                                · a job with a stop request is skipped;
--                                · ORDER: owners over their in-flight cap
--                                  (default 3, of which 1 video) LAST — so the
--                                  cap only bites when someone else is waiting
--                                  (work-conserving: a lone user still gets
--                                  every slot); then the owner with FEWEST jobs
--                                  in flight; then that owner's oldest wait;
--                                  then oldest job. Round-robin by teacher
--                                  (founder decision D1: per teacher, not per
--                                  school). Jobs with no generation (index_book,
--                                  observers) share one 'system' bucket that is
--                                  never capped.
--                              Claimed with a guarded UPDATE (status='queued'),
--                              trying candidates in order, so two workers never
--                              take the same row. The worker uses it only with
--                              FAIR_CLAIM=1 and falls back to its Python claim
--                              when the call fails.
--   queue_holds                pause a teacher, a book, or one teacher's book.
--                              Auto-expires (default 24 h) so a forgotten hold
--                              cannot strand anyone. Service-role table; the
--                              teacher reaches it through pause_my_book().
--   jobs.cancel_requested_at   "stop this running job". The worker reads it on
--                              every progress write (set_progress already
--                              returns the row) and aborts at that stage
--                              boundary; the generation goes to 'error' and
--                              credit_ledger_sync voids it as 'staff_cancel'.
--   staff_cancel_generations   console: cancel queued (delete → refund through
--                              credit_ledger_void_unconsumed, exactly the
--                              teacher's ✕) and request a stop for processing.
--                              Never deletes a processing row (the render keeps
--                              going and dies on the FK, wasting the slot).
--   cancel_my_queued / pause_my_book   the teacher's own rows only (D3).
--
-- Deliberately NOT a new job_status value: an enum value cannot be used in the
-- transaction that adds it, and every reader already understands 'error'. A
-- stopped job is status 'error' with error 'Cancelled …' and a non-null
-- cancel_requested_at.
--
-- Rollback: 0153_fair_claim_rollback.sql.

-- ── holds ────────────────────────────────────────────────────────────────
create table if not exists public.queue_holds (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid references auth.users(id) on delete cascade,
  book_id     uuid references public.books(id) on delete cascade,
  reason      text,
  until       timestamptz not null default now() + interval '24 hours',
  created_by  uuid,
  created_at  timestamptz not null default now(),
  released_at timestamptz,
  constraint queue_holds_has_target check (owner_id is not null or book_id is not null)
);
create index if not exists queue_holds_live on public.queue_holds (owner_id, book_id) where released_at is null;
alter table public.queue_holds enable row level security;
revoke all on public.queue_holds from anon, authenticated;

create or replace function public.queue_held(p_owner uuid, p_book uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from queue_holds h
    where h.released_at is null and h.until > now()
      and (h.owner_id is null or h.owner_id = p_owner)
      and (h.book_id  is null or h.book_id  = p_book)
  )
$$;

-- ── stop requests ────────────────────────────────────────────────────────
alter table public.jobs add column if not exists cancel_requested_at timestamptz;

-- ── the fair claim ───────────────────────────────────────────────────────
create or replace function public.claim_fair_job(
  p_types         text[]  default null,
  p_exclude_types text[]  default null,
  p_user_only     boolean default false,
  p_owner_cap     integer default 3,
  p_video_cap     integer default 1
)
returns setof public.jobs
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id   uuid;
  v_now  text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"');
  v_row  public.jobs;
begin
  for v_id in
    with running as (
      select coalesce(g.owner_id::text, 'system') as owner_key,
             count(*) as n,
             count(*) filter (where j.type = 'presentation') as nv
      from jobs j left join generations g on g.id = j.generation_id
      where j.status = 'processing'
      group by 1
    ),
    cand as (
      select j.id, j.created_at, j.type,
             coalesce(g.owner_id::text, 'system') as owner_key
      from jobs j left join generations g on g.id = j.generation_id
      where j.status = 'queued'
        and j.cancel_requested_at is null
        and (p_types is null or j.type = any(p_types))
        and (p_exclude_types is null or not (j.type = any(p_exclude_types)))
        and (not p_user_only or coalesce(j.params->>'catalogue', '') <> 'true')
        -- same fixed-width text comparison as worker/client.py _stamp()
        and (j.params->>'deferred_until' is null or j.params->>'deferred_until' < v_now)
        and not public.queue_held(g.owner_id, coalesce(g.book_id, j.book_id))
    )
    select c.id
    from cand c left join running r using (owner_key)
    order by
      (c.owner_key <> 'system'
        and (coalesce(r.n, 0) >= p_owner_cap
             or (c.type = 'presentation' and coalesce(r.nv, 0) >= p_video_cap))) asc,
      case when c.owner_key = 'system' then 0 else coalesce(r.n, 0) end asc,
      min(c.created_at) over (partition by c.owner_key) asc,
      c.created_at asc
    limit 25
  loop
    update jobs
       set status = 'processing', progress = 1, claimed_at = now()
     where id = v_id and status = 'queued'
    returning * into v_row;
    if found then
      return next v_row;
      return;
    end if;
  end loop;
  return;
end;
$$;
revoke all on function public.claim_fair_job(text[], text[], boolean, integer, integer) from public, anon, authenticated;

-- ── a stop is refunded as a stop, not a worker fault ─────────────────────
create or replace function public.credit_ledger_sync()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.kind = 'presentation'
     and (new.params->>'video_parts') is distinct from (old.params->>'video_parts') then
    update credit_ledger
       set units = greatest(coalesce((new.params->>'video_parts')::int, 1), 1)
     where generation_id = new.id and not voided;
  end if;
  if new.status = 'error' and new.status is distinct from old.status then
    -- 0153: a job staff (or the teacher) asked to stop is voided as such, so
    -- the ledger says why the credit came back.
    update credit_ledger set voided = true,
           void_reason = case when exists (select 1 from jobs j
                                           where j.generation_id = new.id and j.cancel_requested_at is not null)
                              then 'staff_cancel' else 'worker_error' end
     where generation_id = new.id;
  end if;
  -- 0088: requeued to success — charge on delivery. Un-void the error-path
  -- refund and resync units (the clause above skipped this row while voided).
  if new.status = 'done' and new.status is distinct from old.status then
    update credit_ledger
       set voided = false,
           void_reason = null,
           units = case when new.kind = 'presentation' and new.params ? 'video_parts'
                        then greatest(coalesce((new.params->>'video_parts')::int, 1), 1)
                        else units end
     where generation_id = new.id
       and voided
       and void_reason is distinct from 'unconsumed_on_delete'
       and void_reason is distinct from 'staff_cancel';
  end if;
  return null;
end $function$;

-- ── cancel / stop ────────────────────────────────────────────────────────
-- Shared body: queued → delete (refund via credit_ledger_void_unconsumed);
-- processing → stop request. Jobs are locked skip-locked so a row the worker
-- is claiming this instant is left for the next call.
create or replace function public._cancel_generations(p_ids uuid[], p_actor uuid, p_reason text, p_allow_stop boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_queued   uuid[];
  v_running  uuid[];
  v_refunded int;
begin
  select array_agg(j.generation_id) filter (where j.status = 'queued' and j.progress = 0
                                              and not exists (select 1 from artifacts a where a.generation_id = j.generation_id)),
         array_agg(j.id)            filter (where j.status = 'processing')
    into v_queued, v_running
  from (
    select j.id, j.generation_id, j.status, j.progress
    from jobs j join generations g on g.id = j.generation_id
    where j.generation_id = any(p_ids)
      and j.type = g.kind::text            -- the BUILDER job, never a support_diagnose observer
      and j.status in ('queued', 'processing')
    for update of j skip locked
  ) j;

  select count(*) into v_refunded from credit_ledger
   where generation_id = any(coalesce(v_queued, '{}')) and not voided;

  if v_queued is not null then
    insert into platform_audit_log (actor_id, action, target_kind, target_id, detail)
    select p_actor, 'queue:cancelled', 'generation', g.id,
           jsonb_build_object('reason', p_reason, 'owner_id', g.owner_id, 'book_id', g.book_id,
                              'kind', g.kind, 'chapter_ref', g.chapter_ref, 'part', g.params->>'part')
    from generations g where g.id = any(v_queued);
    delete from generations g where g.id = any(v_queued);
  end if;

  if p_allow_stop and v_running is not null then
    update jobs set cancel_requested_at = now() where id = any(v_running) and cancel_requested_at is null;
    insert into platform_audit_log (actor_id, action, target_kind, target_id, detail)
    select p_actor, 'queue:stop_requested', 'job', j.id,
           jsonb_build_object('reason', p_reason, 'generation_id', j.generation_id)
    from jobs j where j.id = any(v_running);
  end if;

  return jsonb_build_object(
    'cancelled', coalesce(cardinality(v_queued), 0),
    'refunded',  v_refunded,
    'stopping',  case when p_allow_stop then coalesce(cardinality(v_running), 0) else 0 end,
    'running_left', case when p_allow_stop then 0 else coalesce(cardinality(v_running), 0) end
  );
end;
$$;
revoke all on function public._cancel_generations(uuid[], uuid, text, boolean) from public, anon, authenticated;

-- Console (service role, staff-gated in /api/console/ops).
create or replace function public.staff_cancel_generations(p_ids uuid[], p_actor uuid, p_reason text, p_stop_running boolean default false)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$ select public._cancel_generations(p_ids, p_actor, p_reason, p_stop_running) $$;
revoke all on function public.staff_cancel_generations(uuid[], uuid, text, boolean) from public, anon, authenticated;

-- Teacher: cancel what is still QUEUED on one of their books (founder D3).
-- Running builds finish — stopping a render is staff-only for now.
create or replace function public.cancel_my_queued(p_book uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_ids uuid[];
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;
  select array_agg(g.id) into v_ids from generations g
   where g.owner_id = auth.uid() and g.book_id = p_book and g.status = 'queued';
  if v_ids is null then
    return jsonb_build_object('cancelled', 0, 'refunded', 0, 'stopping', 0, 'running_left', 0);
  end if;
  return public._cancel_generations(v_ids, auth.uid(), 'teacher: cancel remaining', false);
end;
$$;
revoke all on function public.cancel_my_queued(uuid) from public, anon;
grant execute on function public.cancel_my_queued(uuid) to authenticated;

-- Teacher: pause / resume their own queue on one book. A hold on (owner, book)
-- never touches another teacher's kits on a shared school book.
create or replace function public.pause_my_book(p_book uuid, p_paused boolean)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;
  if p_paused then
    if not public.queue_held(auth.uid(), p_book) then
      insert into queue_holds (owner_id, book_id, reason, created_by, until)
      values (auth.uid(), p_book, 'teacher paused', auth.uid(), now() + interval '7 days');
    end if;
  else
    update queue_holds set released_at = now()
     where released_at is null and owner_id = auth.uid() and book_id = p_book;
  end if;
  return p_paused;
end;
$$;
revoke all on function public.pause_my_book(uuid, boolean) from public, anon;
grant execute on function public.pause_my_book(uuid, boolean) to authenticated;
