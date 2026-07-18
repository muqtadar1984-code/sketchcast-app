-- 0057 — Trial shape: 1 book + ONE FULL KIT for ONE PART of one chapter.
--
-- Founder decision (2026-07-18): the free teacher trial pins to a single
-- (book, chapter, part) unit. The first accepted generation fixes the pin;
-- every later insert must match it exactly (all six content kinds, retries
-- and regenerations of that same unit stay allowed). Whole-chapter
-- generation is blocked on chapters whose part map has more than one part —
-- the trial kit is per-part, never "the entire chapter including all parts".
--
-- Why now: the 0011 one-chapter pin has been DORMANT since 0024 raised the
-- default chapters cap to unlimited, and per-part lesson units made one
-- chapter worth N full kits. Only monthly fair-use (0047) braked volume.
--
-- rev 3 (two adversarial review rounds):
--   · the pin lives in a LEDGER (trial_pin) — live-row pins were resettable
--     by deleting or status-flipping rows (the 0046 lesson, again);
--   · trial_pin.succeeded records that the pinned unit ever finished (the
--     worker's done-transition marks it), so the failed-first-attempt repin
--     escape can't be unlocked by deleting the successful rows afterwards;
--   · owner-authenticated status writes are rejected outright (the app never
--     updates generations client-side; only the worker, via service role,
--     does) — closes status-forgery repin + fair-use meter resets;
--   · SELECT INTO leaves NULL on zero rows — every have_pin test rides
--     FOUND, never `not have_pin` (rev 2 rejected EVERY first insert);
--   · the multi-part guard skips inserts that exactly match the existing
--     pin — a re-index that grows a grandfathered chapter's part map must
--     not brick regens of the account's own unit (no coverage expands);
--   · the legacy "full book" shape (chapter_ref NULL) is out of the trial
--     contract unless it IS the account's grandfathered pin;
--   · console exemption covers max_books OR max_chapters (matches 0047);
--   · params.part digit match is bounded (no 22003 from inside the trigger);
--   · my_trial_pin() (incl. `repinnable`) / my_trial_book_used() give the
--     app the EXACT pin, escape and book-slot state so the UI mirrors the
--     DB instead of guessing.
--
-- Scope: exactly plan_tier = 'trial' TEACHER accounts. Out of scope:
--   · console-blessed accounts (max_books or max_chapters set);
--   · school members (any school_id) — staff-provisioned, school billing;
--   · parents — already shaped by the exam_paper-only kind trigger (0018)
--     plus monthly fair-use;
--   · paid tiers — governed by monthly fair-use (0047/0049), not the pin.
--
-- Existing rows are never deleted. A trial account that already generated
-- more than one unit keeps everything it has; its pin becomes its EARLIEST
-- surviving non-error unit (ledger-backfilled on first touch) and new
-- inserts outside that unit are blocked. A pin that NEVER succeeded and
-- whose every remaining generation errored (worker-authored errors only)
-- may move once to a fresh unit — a failed first attempt never bricks a
-- trial.
--
-- Idempotent. Requires 0011 (trigger), 0016 (effective_cap), 0046 (book
-- ledger), 0047 (plan_tier).

-- ── The pin ledger ───────────────────────────────────────────────────────────
create table if not exists public.trial_pin (
  owner_id    uuid primary key references auth.users(id) on delete cascade,
  book_id     uuid not null,
  chapter_ref text,                       -- null only for grandfathered whole-book units
  part        int  not null default 0,   -- 0 = chapter-level unit
  succeeded   boolean not null default false, -- the unit finished at least once
  created_at  timestamptz not null default now()
);
alter table public.trial_pin add column if not exists succeeded boolean not null default false;
alter table public.trial_pin enable row level security;
-- No client access: the trigger (security definer) writes it, my_trial_pin()
-- (security definer) reads it. Nothing else.
revoke all on public.trial_pin from anon, authenticated;

-- ── The guard ────────────────────────────────────────────────────────────────
create or replace function enforce_beta_generation_cap() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare
  cap int;
  have_pin boolean := false;
  p_book uuid; p_ref text; p_part int; p_succ boolean;
  n_parts int;
  new_part int;
begin
  -- Worker fast-path: service-role UPDATEs (status transitions, progress,
  -- params.video_parts) skip every guard — but a done-transition marks the
  -- pinned unit as succeeded, which permanently disarms the repin escape
  -- (review: deleting the successful rows must not re-open it).
  if tg_op = 'UPDATE' and auth.uid() is null then
    if new.status = 'done' and new.status is distinct from old.status then
      update trial_pin t
         set succeeded = true
       where t.owner_id = new.owner_id
         and not t.succeeded
         and t.book_id is not distinct from new.book_id
         and t.chapter_ref is not distinct from new.chapter_ref
         and t.part = coalesce(case when new.params->>'part' ~ '^[0-9]{1,9}$'
                                    then (new.params->>'part')::int end, 0);
    end if;
    return new;
  end if;

  -- Status is platform-managed for EVERY tier: the app never updates
  -- generations client-side, so an owner-authenticated status write is
  -- always forgery (pin-escape or fair-use meter reset).
  if tg_op = 'UPDATE'
     and auth.uid() = new.owner_id
     and new.status is distinct from old.status then
    raise exception 'Lesson status is managed by the platform.';
  end if;

  -- ── Console per-user chapter override: 0016 semantics, unchanged ──────────
  cap := effective_cap(new.owner_id, 'chapters');
  if cap < 2147483647 then
    perform pg_advisory_xact_lock(hashtext('beta_gen:' || new.owner_id::text));
    if tg_op = 'UPDATE' then
      if auth.uid() = new.owner_id
         and (new.book_id is distinct from old.book_id
              or new.chapter_ref is distinct from old.chapter_ref)
         and not exists (
               select 1 from generations g
               where g.owner_id = new.owner_id and g.id <> new.id
                 and g.book_id is not distinct from new.book_id
                 and g.chapter_ref is not distinct from new.chapter_ref)
         and (select count(distinct (g.book_id, g.chapter_ref)) from generations g
              where g.owner_id = new.owner_id and g.id <> new.id) >= cap then
        raise exception 'Your plan is limited to % chapter(s). You can generate every content type for the chapter(s) you already picked.', cap;
      end if;
      return new;
    end if;
    if not exists (
         select 1 from generations g
         where g.owner_id = new.owner_id
           and g.book_id is not distinct from new.book_id
           and g.chapter_ref is not distinct from new.chapter_ref)
       and (select count(distinct (g.book_id, g.chapter_ref)) from generations g
            where g.owner_id = new.owner_id) >= cap then
      raise exception 'Your plan is limited to % chapter(s). You can generate every content type for the chapter(s) you already picked.', cap;
    end if;
    return new;
  end if;

  -- ── Trial part pin ────────────────────────────────────────────────────────
  -- Service-role inserts (seed scripts) and rows not owned by the caller pass.
  if auth.uid() is null or auth.uid() is distinct from new.owner_id then
    return new;
  end if;
  -- Console-blessed: ANY override lifts the pin — same definition as
  -- fair-use (0047). (A finite max_chapters already returned above; this
  -- also covers max_books and the explicit-unlimited sentinel.)
  if exists (select 1 from profiles p where p.id = new.owner_id
             and (p.max_books is not null or p.max_chapters is not null)) then
    return new;
  end if;
  -- School members and parents are out of scope (see header).
  if exists (select 1 from profiles p where p.id = new.owner_id
             and (p.school_id is not null or p.role = 'parent')) then
    return new;
  end if;
  if plan_tier(new.owner_id) <> 'trial' then
    return new;
  end if;

  -- params.part is client-written jsonb: only a plain integer of sane length
  -- counts; anything else (junk, oversized digit strings) is part 0.
  new_part := coalesce(case when new.params->>'part' ~ '^[0-9]{1,9}$'
                            then (new.params->>'part')::int end, 0);

  if tg_op = 'UPDATE' then
    -- Owners must not re-point an existing row at another unit.
    if new.book_id is distinct from old.book_id
       or new.chapter_ref is distinct from old.chapter_ref
       or (new.params->>'part') is distinct from (old.params->>'part') then
      raise exception 'Trial lessons can''t be moved to another chapter or part.';
    end if;
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('beta_gen:' || new.owner_id::text));

  -- The pin: ledger first; else backfill a legacy account's earliest
  -- surviving non-error unit. NOTE: SELECT INTO leaves NULLs on zero rows —
  -- every have_pin assignment rides FOUND (review: `not have_pin` with a
  -- NULL rejected every first insert).
  select t.book_id, t.chapter_ref, t.part, t.succeeded
    into p_book, p_ref, p_part, p_succ
    from trial_pin t where t.owner_id = new.owner_id;
  have_pin := found;
  if not have_pin then
    select g.book_id, g.chapter_ref,
           coalesce(case when g.params->>'part' ~ '^[0-9]{1,9}$'
                         then (g.params->>'part')::int end, 0)
      into p_book, p_ref, p_part
      from generations g
     where g.owner_id = new.owner_id and g.status <> 'error'
       and g.book_id is not null
     order by g.created_at asc, g.id asc
     limit 1;
    have_pin := found;
    if have_pin then
      -- A legacy unit that already has a done row starts life "succeeded".
      p_succ := exists (select 1 from generations g
                        where g.owner_id = new.owner_id
                          and g.book_id is not distinct from p_book
                          and g.chapter_ref is not distinct from p_ref
                          and coalesce(case when g.params->>'part' ~ '^[0-9]{1,9}$'
                                            then (g.params->>'part')::int end, 0) = p_part
                          and g.status = 'done');
      insert into trial_pin (owner_id, book_id, chapter_ref, part, succeeded)
      values (new.owner_id, p_book, p_ref, p_part, p_succ)
      on conflict (owner_id) do nothing;
    end if;
  end if;

  -- The legacy "full book" shape (chapter_ref NULL) is not part of the trial
  -- contract — except as a retry of a grandfathered whole-book pin.
  if new.book_id is not null and new.chapter_ref is null
     and not (have_pin and p_book = new.book_id and p_ref is null) then
    raise exception 'Your free trial generates chapter by chapter — pick a chapter (or one part of it).';
  end if;

  -- Whole-chapter generation is off wherever the chapter has a multi-part
  -- map — but NEVER against the account's own pinned unit: a re-index that
  -- grows a grandfathered chapter's part map must not brick regens of a kit
  -- the account already holds (no coverage expands). Books indexed before
  -- part maps existed have no parts arrays and keep working as single units.
  if new_part = 0 and new.book_id is not null and new.chapter_ref is not null
     and not (have_pin
              and p_book = new.book_id
              and p_ref is not distinct from new.chapter_ref
              and p_part = new_part) then
    select case when jsonb_typeof(c.value->'parts') = 'array'
                then jsonb_array_length(c.value->'parts') end
      into n_parts
      from books b, jsonb_array_elements(coalesce(b.chapters, '[]'::jsonb)) c
     where b.id = new.book_id and c.value->>'num' = new.chapter_ref
     limit 1;
    if coalesce(n_parts, 0) > 1 then
      raise exception 'This chapter has % parts. Your free trial includes the full kit for one part — use a part row to generate.', n_parts;
    end if;
  end if;

  if not have_pin then
    -- First accepted unit becomes the pin.
    insert into trial_pin (owner_id, book_id, chapter_ref, part)
    values (new.owner_id, new.book_id, new.chapter_ref, new_part)
    on conflict (owner_id) do nothing;
    return new;
  end if;

  if p_book is distinct from new.book_id
     or p_ref is distinct from new.chapter_ref
     or p_part is distinct from new_part then
    -- One escape: a pin that NEVER succeeded, whose remaining generations
    -- all errored (worker-authored — owners can't forge status), may move
    -- to this fresh unit. Deleting rows does NOT qualify: an absent unit
    -- keeps its pin, and `succeeded` survives deletion of the done rows.
    if not coalesce(p_succ, false)
       and exists (select 1 from generations g
                   where g.owner_id = new.owner_id
                     and g.book_id is not distinct from p_book
                     and g.chapter_ref is not distinct from p_ref
                     and coalesce(case when g.params->>'part' ~ '^[0-9]{1,9}$'
                                       then (g.params->>'part')::int end, 0) = p_part)
       and not exists (select 1 from generations g
                   where g.owner_id = new.owner_id
                     and g.book_id is not distinct from p_book
                     and g.chapter_ref is not distinct from p_ref
                     and coalesce(case when g.params->>'part' ~ '^[0-9]{1,9}$'
                                       then (g.params->>'part')::int end, 0) = p_part
                     and g.status <> 'error') then
      update trial_pin
         set book_id = new.book_id, chapter_ref = new.chapter_ref,
             part = new_part, succeeded = false, created_at = now()
       where owner_id = new.owner_id;
      return new;
    end if;
    raise exception 'Your free trial includes the full kit (all six content types) for one part of one chapter, and yours is already started. Upgrade to unlock the rest of the book.';
  end if;
  return new;
end $$;

-- Recreate to watch params (owner re-pointing guard) and status (forgery
-- guard + the worker's succeeded-mark) on UPDATE too.
drop trigger if exists beta_generation_cap on generations;
create trigger beta_generation_cap
  before insert or update of book_id, chapter_ref, params, status on generations
  for each row execute function enforce_beta_generation_cap();

-- ── The UI's mirror ──────────────────────────────────────────────────────────
-- Exactly the trigger's scope + pin + escape, so the dashboard locks can
-- never diverge from what the DB will actually accept. `repinnable` = the
-- trigger's escape predicate — the UI must unlock other units when the DB
-- would (review: a dead first chapter otherwise dead-ends the trial UI-side).
create or replace function public.my_trial_pin()
  returns table (in_scope boolean, pinned boolean, book_id uuid, chapter_ref text, part int, repinnable boolean)
  language plpgsql stable security definer set search_path = public as
$$
declare
  uid uuid := auth.uid();
  scope boolean := false;
  have_pin boolean := false;
  p_book uuid; p_ref text; p_part int; p_succ boolean := false;
  can_repin boolean := false;
begin
  if uid is null then
    return query select false, false, null::uuid, null::text, null::int, false; return;
  end if;
  select (p.school_id is null
          and coalesce(p.role, '') <> 'parent'
          and p.max_books is null and p.max_chapters is null)
    into scope
    from profiles p where p.id = uid;
  scope := coalesce(scope, false) and plan_tier(uid) = 'trial';
  if not scope then
    return query select false, false, null::uuid, null::text, null::int, false; return;
  end if;
  select t.book_id, t.chapter_ref, t.part, t.succeeded
    into p_book, p_ref, p_part, p_succ
    from trial_pin t where t.owner_id = uid;
  have_pin := found;
  if not have_pin then
    -- Same legacy backfill the trigger uses (read-only here).
    select g.book_id, g.chapter_ref,
           coalesce(case when g.params->>'part' ~ '^[0-9]{1,9}$'
                         then (g.params->>'part')::int end, 0)
      into p_book, p_ref, p_part
      from generations g
     where g.owner_id = uid and g.status <> 'error' and g.book_id is not null
     order by g.created_at asc, g.id asc
     limit 1;
    have_pin := found;
    if have_pin then
      p_succ := exists (select 1 from generations g
                        where g.owner_id = uid
                          and g.book_id is not distinct from p_book
                          and g.chapter_ref is not distinct from p_ref
                          and coalesce(case when g.params->>'part' ~ '^[0-9]{1,9}$'
                                            then (g.params->>'part')::int end, 0) = p_part
                          and g.status = 'done');
    end if;
  end if;
  if have_pin then
    can_repin := not coalesce(p_succ, false)
      and exists (select 1 from generations g
                  where g.owner_id = uid
                    and g.book_id is not distinct from p_book
                    and g.chapter_ref is not distinct from p_ref
                    and coalesce(case when g.params->>'part' ~ '^[0-9]{1,9}$'
                                      then (g.params->>'part')::int end, 0) = p_part)
      and not exists (select 1 from generations g
                  where g.owner_id = uid
                    and g.book_id is not distinct from p_book
                    and g.chapter_ref is not distinct from p_ref
                    and coalesce(case when g.params->>'part' ~ '^[0-9]{1,9}$'
                                      then (g.params->>'part')::int end, 0) = p_part
                    and g.status <> 'error');
  end if;
  return query select true, have_pin, p_book, p_ref, p_part, coalesce(can_repin, false);
end $$;
revoke execute on function public.my_trial_pin() from public, anon;
grant execute on function public.my_trial_pin() to authenticated;

-- The trial's book slot from the 0046 ledger (books rows lie: a deleted
-- generated-from book keeps its slot consumed — the UI must not offer a
-- doomed multi-minute upload).
create or replace function public.my_trial_book_used() returns int
  language sql stable security definer set search_path = public as
$$
  select count(*)::int from book_upload_ledger where owner_id = auth.uid()
$$;
revoke execute on function public.my_trial_book_used() from public, anon;
grant execute on function public.my_trial_book_used() to authenticated;
