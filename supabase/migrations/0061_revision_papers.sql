-- 0061 — Revision papers: FREE worksheets & exams over generated lessons.
--
-- Founder decision (2026-07-19): batch generate is a REVISION tool for
-- term/mid-term/exam time. A teacher picks a GROUP of chapters and generates
-- ONLY worksheets and/or exam papers (never the full kit), either
--   · one cumulative paper spanning the selected chapters (a term paper), or
--   · one paper per selected chapter (a revision pack).
--
-- Revision papers are FREE — "revision is always on generated lessons," so the
-- analysis is already paid for by the lesson. The rule that makes this safe:
-- a revision paper is only allowed on chapters that ALREADY have a generated
-- lesson (the UI offers only those chapters; this trigger enforces it).
--
-- Mechanics: revision papers carry params.revision = true. A PER-CHAPTER one
-- (chapter_ref set) is just a document on a chapter that has a lesson — the
-- existing free-with-lesson kit rule (0059) already covers it. A CUMULATIVE
-- one (chapter_ref null, params.chapters = [nums]) is new: it's free too, but
-- EVERY selected chapter must have a live lesson, and it's bounded to a
-- generous monthly ceiling so it can't be farmed.
--
-- Nothing is billed: this migration adds NO credit machinery (an earlier draft
-- charged a credit and added credit_ledger.billable — reverted per the founder;
-- credit_ledger_write / fair_use_used are restored to their 0060 shape).
--
-- Idempotent. Requires 0059 (credit_ledger) + 0060 (promo tier).

-- ── credit_ledger_write: 0060 shape (part-map seed, NO billable) ─────────────
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

-- ── fair_use_used: 0060 shape (lessons/parts only; revision papers are free) ─
create or replace function public.fair_use_used(uid uuid, unit text, month_start timestamptz)
returns int
  language sql stable security definer set search_path = public as
$$
  select (
    coalesce((select sum(cl.units) from credit_ledger cl
              where cl.owner_id = uid and cl.kind = 'presentation' and not cl.voided
                and cl.created_at >= month_start
                and cl.created_at < month_start + interval '1 month'), 0)
    +
    coalesce((select sum(greatest(coalesce((g.params->>'video_parts')::int, 1), 1))
              from generations g
              where g.owner_id = uid and g.kind = 'presentation' and g.status <> 'error'
                and g.created_at >= month_start
                and g.created_at < month_start + interval '1 month'
                and not exists (select 1 from credit_ledger cl2 where cl2.generation_id = g.id)), 0)
  )::int;
$$;

-- ── Enforcement: revision papers FREE (on generated lessons); kit docs free ──
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
  cumulative_count int;
begin
  if exists (select 1 from profiles p where p.id = new.owner_id
             and (p.max_books is not null or p.max_chapters is not null)) then
    return new;
  end if;
  tier := plan_tier(new.owner_id);
  select * into caps from fair_use_caps(tier);

  -- Lessons draw a credit (promo period-total vs monthly). Unchanged (0060).
  if new.kind = 'presentation' then
    if caps.parts_cap >= 2147483647 then
      return new;
    end if;
    perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));
    if tier = 'promo' then
      if fair_use_used(new.owner_id, 'credits', promo_credit_from()) >= caps.parts_cap then
        raise exception 'Your free trial includes % lessons with every feature unlocked, and you''ve used them all. Subscribe to keep generating — the free plan then covers one lesson at a time.',
          caps.parts_cap;
      end if;
      return new;
    end if;
    select * into a from fair_use_avail(new.owner_id, 'credits', caps.parts_cap);
    if a.available < 1 then
      raise exception 'Monthly limit reached: your plan includes % lessons/month (+% carried over) — each lesson brings its full document kit free. It resets on the 1st, or upgrade for more.',
        caps.parts_cap, a.carry;
    end if;
    return new;
  end if;

  if new.kind in ('worksheet', 'exam_paper', 'lesson_plan', 'activity', 'case_study') then
    if caps.parts_cap >= 2147483647 then
      return new; -- unlimited tiers
    end if;
    perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));

    -- CUMULATIVE revision paper (spans chapters): FREE, but every selected
    -- chapter must already have a live lesson, and it's bounded per month.
    if (new.params->>'revision') = 'true'
       and new.chapter_ref is null
       and jsonb_typeof(new.params->'chapters') = 'array' then
      if exists (
        select 1 from jsonb_array_elements_text(new.params->'chapters') ch
        where not exists (
          select 1 from generations p
          where p.owner_id = new.owner_id and p.kind = 'presentation' and p.status <> 'error'
            and p.book_id is not distinct from new.book_id
            and p.chapter_ref = ch.value
        )
      ) then
        raise exception 'Revision papers are built from your generated lessons — generate the lesson for every chapter you selected first.';
      end if;
      select count(*) into cumulative_count from generations g
        where g.owner_id = new.owner_id and g.kind = new.kind and g.status <> 'error'
          and (g.params->>'revision') = 'true' and g.chapter_ref is null
          and g.created_at >= date_trunc('month', now());
      if cumulative_count >= 12 then
        raise exception 'You''ve reached this month''s revision papers of this type. It resets on the 1st.';
      end if;
      return new; -- FREE
    end if;

    -- PER-CHAPTER revision paper AND lesson kit documents: FREE, but only WITH
    -- their lesson (a revision paper is generated on a chapter you've taught).
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
      raise exception 'Documents generate together with their lesson — generate the lesson for this chapter first (its kit is free), or use Revision papers over chapters you''ve already taught.';
    end if;
    -- Free-regen bound: 3 per (unit, kind) per month — covers kit + per-chapter
    -- revision documents of the same chapter together.
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
