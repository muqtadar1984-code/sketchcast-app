-- 0058 — Parents join the trial part pin, exactly like teachers.
--
-- Founder decision (2026-07-19): "lets be fair and pin them exactly like a
-- teacher." 0057 exempted role='parent' from the trial pin on the old
-- assumption that parents were exam-paper-only (0018) — but 0035 made
-- parents full authors, and the parent hat now opens the Library directly,
-- so an unpinned trial parent would out-generate a pinned trial teacher.
--
-- This replaces the two 0057 functions IN PLACE with the parent carve-out
-- removed. Everything else — the trial_pin ledger, succeeded semantics,
-- status-forgery guard, repin escape, multi-part and chapter_ref-NULL
-- rules, console/school exemptions — is byte-identical to 0057 rev 3.
-- Scope after this: plan_tier='trial' AND school_id IS NULL AND no
-- max_books/max_chapters override — role no longer matters.
--
-- Grandfathering: a trial parent who already generated keeps everything;
-- their pin backfills from their EARLIEST surviving non-error unit on the
-- next insert, same as teachers in 0057.
--
-- Idempotent. Requires 0057 (trial_pin table + trigger + RPCs).

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
  -- Worker fast-path: service-role UPDATEs skip every guard — but a
  -- done-transition marks the pinned unit succeeded (disarms the repin
  -- escape permanently; deleting the successful rows can't re-open it).
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

  -- ── Trial part pin (0058: parents included — same rules as teachers) ──────
  if auth.uid() is null or auth.uid() is distinct from new.owner_id then
    return new;
  end if;
  -- Console-blessed: ANY override lifts the pin (0047 pattern).
  if exists (select 1 from profiles p where p.id = new.owner_id
             and (p.max_books is not null or p.max_chapters is not null)) then
    return new;
  end if;
  -- School members are out of scope (staff-provisioned, school billing).
  if exists (select 1 from profiles p where p.id = new.owner_id
             and p.school_id is not null) then
    return new;
  end if;
  if plan_tier(new.owner_id) <> 'trial' then
    return new;
  end if;

  new_part := coalesce(case when new.params->>'part' ~ '^[0-9]{1,9}$'
                            then (new.params->>'part')::int end, 0);

  if tg_op = 'UPDATE' then
    if new.book_id is distinct from old.book_id
       or new.chapter_ref is distinct from old.chapter_ref
       or (new.params->>'part') is distinct from (old.params->>'part') then
      raise exception 'Trial lessons can''t be moved to another chapter or part.';
    end if;
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('beta_gen:' || new.owner_id::text));

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

  if new.book_id is not null and new.chapter_ref is null
     and not (have_pin and p_book = new.book_id and p_ref is null) then
    raise exception 'Your free trial generates chapter by chapter — pick a chapter (or one part of it).';
  end if;

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
    insert into trial_pin (owner_id, book_id, chapter_ref, part)
    values (new.owner_id, new.book_id, new.chapter_ref, new_part)
    on conflict (owner_id) do nothing;
    return new;
  end if;

  if p_book is distinct from new.book_id
     or p_ref is distinct from new.chapter_ref
     or p_part is distinct from new_part then
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

-- The UI mirror: scope drops the parent carve-out too.
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
  return query select true, coalesce(have_pin, false), p_book, p_ref, p_part, coalesce(can_repin, false);
end $$;
