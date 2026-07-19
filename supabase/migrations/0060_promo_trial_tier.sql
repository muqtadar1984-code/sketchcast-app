-- 0060 — The launch "free trial period": all features, capped at 4 lessons.
--
-- Founder decision (2026-07-19): the public pricing page bypasses Lemon
-- Squeezy checkout until 7 Aug 2026 and sends everyone into the app for a
-- free trial. Two distinct things must be true:
--   · FREE tier (permanent, beyond the promo) = the 1-part pin shape
--     (1 book, the full kit for ONE part) — plan_tier 'trial', UNCHANGED.
--   · TRIAL PERIOD (now → 7 Aug) = every feature unlocked (NO 1-part pin,
--     all nine languages, the AI tutor), but hard-capped at 4 LESSONS for
--     the WHOLE period — not 4/month — so a teacher can't extract a term's
--     worth of material free and skip paying. Books capped at 2 for the
--     period (bounds indexing spend; enough to try on real material).
--   · After 7 Aug the promo tier evaporates on its own — plan_tier stops
--     returning 'promo', accounts fall back to 'trial' (the 1-part free
--     tier), and paid plans take over. No cron, no cleanup: it is purely a
--     function of now() vs the promo end.
--
-- Mechanics: a new plan_tier value 'promo' for any non-school account with
-- no active paid entitlement, while now() < promo_ends_at(). Because the
-- one-part pin (0057/0058) only fires for plan_tier = 'trial', a 'promo'
-- account SKIPS the pin automatically — this migration only adds its cap.
-- The 4-lesson cap is a period TOTAL, counted on the delete-proof
-- credit_ledger (0059) from promo_credit_from() via fair_use_used's window
-- (anchor + 1 month spans the whole promo), so it never resets mid-promo
-- and delete/regenerate can't refund it.
--
-- After-promo downgrade: a promo teacher who generated 4 lessons keeps ALL
-- of them (nothing is deleted); on 8 Aug they become 'trial' and the pin
-- backfills to their earliest unit — the natural "your trial ended, you're
-- on Free now" transition.
--
-- To EXTEND or END the promo early: change promo_ends_at() (and the landing
-- pricing.config.js trial.endsAt). To reset the 4-lesson counter's start:
-- promo_credit_from().
--
-- Idempotent. Requires 0047 (plan_tier, caps, book cap), 0059 (credit_ledger,
-- fair_use_used/enforce_fair_use/my_fair_use).

-- ── Promo window (one place to change the dates) ─────────────────────────────
create or replace function public.promo_ends_at() returns timestamptz
  language sql immutable as $$ select timestamptz '2026-08-07 23:59:59+08' $$;
-- Lessons are counted from here (rule go-live): a clean slate of 4 for every
-- account, so existing beta testers aren't retroactively capped by pre-promo
-- generations already in the ledger.
create or replace function public.promo_credit_from() returns timestamptz
  language sql immutable as $$ select timestamptz '2026-07-19 00:00:00+00' $$;
revoke execute on function public.promo_ends_at() from public, anon, authenticated;
revoke execute on function public.promo_credit_from() from public, anon, authenticated;

-- ── plan_tier: add 'promo' between paid and 'trial' ──────────────────────────
create or replace function public.plan_tier(uid uuid) returns text
  language sql stable security definer set search_path = public as
$$
  select coalesce(
    -- School plan (one entitlement held by the admin; every member is 'school').
    (select 'school'
     from profiles p
     join entitlements e on e.school_id = p.school_id
     where p.id = uid and p.school_id is not null
       and e.active and e.plan_key like 'school%'
       and (e.current_period_end is null or e.current_period_end > now())
     limit 1),
    -- Personal paid entitlement (the buyer's own plan).
    (select case
       when e.plan_key like 'teacher_pro_plus%' then 'pro_plus'
       when e.plan_key like 'teacher_pro%'      then 'pro'
       when e.plan_key like 'family%'           then 'family'
       when e.plan_key like 'school%'           then 'school'
     end
     from entitlements e
     where e.user_id = uid and e.active
       and (e.current_period_end is null or e.current_period_end > now())
     order by case
       when e.plan_key like 'school%'           then 1
       when e.plan_key like 'teacher_pro_plus%' then 2
       when e.plan_key like 'teacher_pro%'      then 3
       when e.plan_key like 'family%'           then 4
       else 5 end
     limit 1),
    -- Launch free-trial period: any non-school account with no paid plan, while
    -- the promo runs. School members are out (staff-provisioned/sales-led).
    (select 'promo'
     from profiles p
     where p.id = uid and p.school_id is null and now() < promo_ends_at()),
    'trial');
$$;
revoke execute on function public.plan_tier(uuid) from public, anon, authenticated;

-- ── Caps: promo = 4 lessons, 2 books (docs free with each lesson) ────────────
create or replace function public.fair_use_caps(tier text)
returns table (parts_cap int, docs_cap int, books_cap int)
  language sql immutable as
$$
  select t.parts_cap, t.docs_cap, t.books_cap from (values
    ('trial',    16, 0, 2147483647),  -- the permanent FREE tier (books via 0046 ledger + 1-part pin)
    ('promo',     4, 0, 2),           -- the launch trial period: 4 lessons / 2 books, all features
    ('pro',      16, 0, 2),
    ('pro_plus', 32, 0, 4),
    ('family',    6, 0, 2),
    ('school',   2147483647, 2147483647, 2147483647)
  ) as t(k, parts_cap, docs_cap, books_cap)
  where t.k = coalesce(tier, 'trial');
$$;

-- ── Credit ledger: seed a chapter-level lesson's units from its part map ─────
-- 0059 recorded units=1 at insert and let the worker sync the real part count
-- after render. Under a PERIOD-total promo cap that let a fast batch enqueue
-- several multi-part chapters past the 4 before any render synced (each read
-- as 1). Seeding the known part count at insert closes that — and makes the
-- monthly meters accurate immediately too. The worker's sync still corrects
-- any book whose real render differs from its stored map. A part-level lesson
-- (params.part set) is always 1 part.
create or replace function credit_ledger_write() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare
  n int := 1;
begin
  if new.kind in ('presentation', 'worksheet', 'exam_paper', 'lesson_plan', 'activity', 'case_study') then
    if new.kind = 'presentation' and not (new.params->>'part' ~ '^[0-9]{1,9}$') then
      select coalesce((
        select greatest(jsonb_array_length(c.value->'parts'), 1)
        from books b, jsonb_array_elements(coalesce(b.chapters, '[]'::jsonb)) c
        where b.id = new.book_id and c.value->>'num' = new.chapter_ref
          and jsonb_typeof(c.value->'parts') = 'array'
        limit 1), 1) into n;
    end if;
    insert into credit_ledger (owner_id, generation_id, kind, units, book_id, chapter_ref, part, voided)
    values (new.owner_id, new.id, new.kind, n, new.book_id, new.chapter_ref,
            coalesce(case when new.params->>'part' ~ '^[0-9]{1,9}$' then (new.params->>'part')::int end, 0),
            new.status = 'error');
  end if;
  return null;
end $$;
drop trigger if exists credit_ledger_write on generations;
create trigger credit_ledger_write after insert on generations
  for each row execute function credit_ledger_write();

-- ── Lesson enforcement: promo is a PERIOD-TOTAL cap, not monthly ─────────────
create or replace function enforce_fair_use() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare
  tier text;
  caps record;
  a record;
  new_part int;
  has_lesson boolean;
  kind_rows int;
begin
  if exists (select 1 from profiles p where p.id = new.owner_id
             and (p.max_books is not null or p.max_chapters is not null)) then
    return new;
  end if;
  tier := plan_tier(new.owner_id);
  select * into caps from fair_use_caps(tier);

  if new.kind = 'presentation' then
    if tier = 'promo' then
      -- Period total: fair_use_used's window is [anchor, anchor+1 month),
      -- and the anchor (19 Jul) + 1 month spans the whole promo (ends 7 Aug),
      -- so this is one non-resetting 4-lesson budget over the trial period.
      perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));
      if fair_use_used(new.owner_id, 'credits', promo_credit_from()) >= caps.parts_cap then
        raise exception 'Your free trial includes % lessons with every feature unlocked, and you''ve used them all. Subscribe to keep generating — the free plan then covers one lesson at a time.',
          caps.parts_cap;
      end if;
      return new;
    end if;
    if caps.parts_cap < 2147483647 then
      perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));
      select * into a from fair_use_avail(new.owner_id, 'credits', caps.parts_cap);
      if a.available < 1 then
        raise exception 'Monthly limit reached: your plan includes % lessons/month (+% carried over) — each lesson brings its full document kit free. It resets on the 1st, or upgrade for more.',
          caps.parts_cap, a.carry;
      end if;
    end if;
    return new;
  end if;

  if new.kind in ('worksheet', 'exam_paper', 'lesson_plan', 'activity', 'case_study') then
    if caps.parts_cap >= 2147483647 then
      return new; -- unlimited tiers: no kit rule
    end if;
    -- The kit rule is identical for promo and the paid/free tiers: documents
    -- ride free with their lesson, bounded to 3 per (unit, kind) per month.
    perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));
    new_part := coalesce(case when new.params->>'part' ~ '^[0-9]{1,9}$'
                              then (new.params->>'part')::int end, 0);
    select exists (
      select 1 from generations p
      where p.owner_id = new.owner_id
        and p.kind = 'presentation'
        and p.status <> 'error'
        and p.book_id is not distinct from new.book_id
        and p.chapter_ref is not distinct from new.chapter_ref
        and coalesce(case when p.params->>'part' ~ '^[0-9]{1,9}$'
                          then (p.params->>'part')::int end, 0) = new_part
    ) into has_lesson;
    if not has_lesson then
      raise exception 'Documents generate together with their lesson — generate the lesson for this chapter (or part) first; its full document kit is free.';
    end if;
    select (
      (select count(*) from credit_ledger cl
        where cl.owner_id = new.owner_id and cl.kind = new.kind and not cl.voided
          and cl.book_id is not distinct from new.book_id
          and cl.chapter_ref is not distinct from new.chapter_ref
          and cl.part = new_part
          and cl.created_at >= date_trunc('month', now()))
      +
      (select count(*) from generations d
        where d.owner_id = new.owner_id and d.kind = new.kind and d.status <> 'error'
          and d.book_id is not distinct from new.book_id
          and d.chapter_ref is not distinct from new.chapter_ref
          and coalesce(case when d.params->>'part' ~ '^[0-9]{1,9}$'
                            then (d.params->>'part')::int end, 0) = new_part
          and d.created_at >= date_trunc('month', now())
          and not exists (select 1 from credit_ledger cl2 where cl2.generation_id = d.id))
    ) into kind_rows;
    if kind_rows >= 3 then
      raise exception 'Regeneration limit: this document type was already generated % times this month for this lesson. It resets on the 1st.', kind_rows;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists fair_use_cap on generations;
create trigger fair_use_cap before insert on generations
  for each row execute function enforce_fair_use();

-- ── Books: promo = 2 for the period (delete-proof ledger, from the anchor) ───
create or replace function enforce_beta_book_cap() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare
  cap int;
  tier text;
  caps record;
  m0 timestamptz := date_trunc('month', now());
begin
  tier := plan_tier(new.owner_id);

  -- Promo (launch trial): a PERIOD total from the promo anchor, so it doesn't
  -- reset at the month boundary the promo crosses. Console-blessed accounts
  -- (a max_books override — founder/demo) fall THROUGH to their override
  -- branch below, which honours the override number; without this gate the
  -- promo cap would pin them to 2 books while my_fair_use shows "unlimited".
  if tier = 'promo'
     and (select max_books from profiles where id = new.owner_id) is null then
    select * into caps from fair_use_caps('promo');
    cap := caps.books_cap;
    perform pg_advisory_xact_lock(hashtext('beta_book:' || new.owner_id::text));
    if tg_op = 'UPDATE' then
      if auth.uid() = new.owner_id
         and (new.storage_path is distinct from old.storage_path
              or new.chapters is distinct from old.chapters
              or new.owner_id is distinct from old.owner_id)
         and (select count(*) from book_upload_ledger
              where owner_id = new.owner_id and created_at >= promo_credit_from()) >= cap then
        raise exception 'Your free trial includes % books. Subscribe to add more.', cap;
      end if;
      return new;
    end if;
    if (select count(*) from book_upload_ledger
        where owner_id = new.owner_id and created_at >= promo_credit_from()) >= cap then
      raise exception 'Your free trial includes % books. Subscribe to add more.', cap;
    end if;
    return new;
  end if;

  if tier = 'trial' then
    cap := effective_cap(new.owner_id, 'books');
    if cap >= 2147483647 then
      return new;
    end if;
    perform pg_advisory_xact_lock(hashtext('beta_book:' || new.owner_id::text));
    if tg_op = 'UPDATE' then
      if auth.uid() = new.owner_id
         and (new.storage_path is distinct from old.storage_path
              or new.chapters is distinct from old.chapters
              or new.owner_id is distinct from old.owner_id)
         and (select count(*) from book_upload_ledger where owner_id = new.owner_id) >= cap then
        raise exception 'Your plan includes % book. Generate every content type for the book you already have, or upgrade for more.', cap;
      end if;
      return new;
    end if;
    if (select count(*) from book_upload_ledger where owner_id = new.owner_id) >= cap then
      raise exception 'Your plan includes % book (deleting a book you generated from does not free the slot). Upgrade for more.', cap;
    end if;
    return new;
  end if;

  -- Paid tiers: monthly uploads with rollover; a console override wins.
  if (select max_books from profiles where id = new.owner_id) is not null then
    if tg_op = 'UPDATE'
       and (auth.uid() is distinct from new.owner_id
            or not (new.storage_path is distinct from old.storage_path
                    or new.chapters is distinct from old.chapters
                    or new.owner_id is distinct from old.owner_id)) then
      return new;
    end if;
    cap := effective_cap(new.owner_id, 'books');
    if (select count(*) from book_upload_ledger where owner_id = new.owner_id) >= cap
       and tg_op = 'INSERT' then
      raise exception 'Your plan includes % books.', cap;
    end if;
    return new;
  end if;
  select * into caps from fair_use_caps(tier);
  if caps.books_cap >= 2147483647 then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if auth.uid() is distinct from new.owner_id
       or not (new.storage_path is distinct from old.storage_path
               or new.chapters is distinct from old.chapters
               or new.owner_id is distinct from old.owner_id) then
      return new;
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtext('beta_book:' || new.owner_id::text));
  declare
    used_now int;
    used_prev int;
    carry_v int := 0;
  begin
    select count(*) into used_now from book_upload_ledger
      where owner_id = new.owner_id and created_at >= m0;
    if exists (select 1 from profiles p where p.id = new.owner_id and p.created_at < m0) then
      select count(*) into used_prev from book_upload_ledger
        where owner_id = new.owner_id and created_at >= m0 - interval '1 month' and created_at < m0;
      carry_v := least(caps.books_cap, greatest(0, caps.books_cap - used_prev));
    end if;
    if used_now >= caps.books_cap + carry_v then
      raise exception 'Monthly fair-use limit reached: your plan includes % new books/month (+% carried over). It resets on the 1st.',
        caps.books_cap, carry_v;
    end if;
  end;
  return new;
end $$;

-- ── The meter's read: promo shows the period budget + trial end ──────────────
create or replace function public.my_fair_use() returns jsonb
  language plpgsql stable security definer set search_path = public as
$$
declare
  uid uuid := auth.uid();
  tier text;
  caps record;
  c record;
  promo_used int;
begin
  if uid is null then
    return null;
  end if;
  if exists (select 1 from profiles p where p.id = uid
             and (p.max_books is not null or p.max_chapters is not null)) then
    return jsonb_build_object('tier', 'unlimited', 'unlimited', true);
  end if;
  tier := plan_tier(uid);
  select * into caps from fair_use_caps(tier);

  if tier = 'promo' then
    promo_used := fair_use_used(uid, 'credits', promo_credit_from());
    return jsonb_build_object(
      'tier', 'promo',
      'unlimited', false,
      'promo', true,
      'credits', jsonb_build_object('cap', caps.parts_cap, 'carry', 0, 'used', promo_used,
                                    'available', greatest(0, caps.parts_cap - promo_used)),
      'resets_on', to_char(promo_ends_at() at time zone 'UTC', 'YYYY-MM-DD'),
      'trial_ends', to_char(promo_ends_at() at time zone 'UTC', 'YYYY-MM-DD')
    );
  end if;

  select * into c from fair_use_avail(uid, 'credits', caps.parts_cap);
  return jsonb_build_object(
    'tier', tier,
    'unlimited', caps.parts_cap >= 2147483647,
    'credits', jsonb_build_object('cap', caps.parts_cap, 'carry', c.carry, 'used', c.used,
                                  'available', greatest(0, c.available)),
    'resets_on', to_char(date_trunc('month', now()) + interval '1 month', 'YYYY-MM-DD')
  );
end;
$$;
revoke execute on function public.my_fair_use() from public, anon;
grant execute on function public.my_fair_use() to authenticated;
