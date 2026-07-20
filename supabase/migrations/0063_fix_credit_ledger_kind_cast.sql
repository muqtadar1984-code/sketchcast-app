-- 0063 — FIX: "operator does not exist: text = generation_kind" on document gen.
--
-- Bug (present since 0059, carried through 0060/0061/0062): enforce_fair_use's
-- free-document bound compares credit_ledger.kind (a TEXT column) to new.kind
-- (the generation_kind ENUM) WITHOUT a cast:
--     where cl.owner_id = new.owner_id and cl.kind = new.kind ...
-- Postgres has no `text = generation_kind` operator, so the moment this branch
-- is reached the whole INSERT throws. It's only reached for a document kind
-- (worksheet / exam_paper / lesson_plan / activity / case_study) on a FINITE
-- tier that ISN'T console-exempt — which is exactly a real teacher/parent, but
-- NOT the founder/demo accounts (they return early via the max_books/max_chapters
-- override at the top). So it stayed invisible until a real parent generated a
-- test paper ("Generate lesson + paper" → presentation + exam_paper; the paper
-- insert hits this line).
--
-- Fix: compare on the text NAME — cl.kind = new.kind::text. credit_ledger.kind
-- already stores the enum's text form (the writer assigns new.kind into the text
-- column), so matching by text is exactly right. This is the ONLY text-vs-enum
-- comparison in the function; d.kind/g.kind are generations.kind (enum = enum).
--
-- Recreates enforce_fair_use byte-for-byte from 0062 with that single change.
-- Idempotent. Run it as soon as possible — it unblocks ALL document generation
-- for real (non-console) accounts.

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

  -- ── Cumulative EXAM (0062): FREE, like revision papers ──────────────────────
  if new.kind::text = 'exam' then
    perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));
    if coalesce(jsonb_typeof(new.params->'scope'), '') <> 'array'
       or jsonb_array_length(new.params->'scope') = 0 then
      raise exception 'Pick at least one covered chapter or part to build the exam from.';
    end if;
    if exists (
      select 1 from jsonb_array_elements(new.params->'scope') s
      where not exists (
        select 1 from generations p
        where p.owner_id = new.owner_id
          and p.kind = 'presentation'
          and p.status <> 'error'
          and p.book_id is not distinct from new.book_id
          and p.chapter_ref = (s.value->>'chapter')
          and coalesce(case when p.params->>'part' ~ '^[0-9]{1,9}$'
                            then (p.params->>'part')::int end, 0)
              = coalesce(case when s.value->>'part' ~ '^[0-9]{1,9}$'
                              then (s.value->>'part')::int end, 0)
      )
    ) then
      raise exception 'An exam can only cover chapters and parts you''ve already generated a lesson for.';
    end if;
    if caps.parts_cap < 2147483647
       and (select count(*) from generations g
              where g.owner_id = new.owner_id and g.kind::text = 'exam'
                and g.status <> 'error'
                and g.created_at >= date_trunc('month', now())) >= 12 then
      raise exception 'You''ve reached this month''s exams (12). It resets on the 1st.';
    end if;
    return new;
  end if;

  -- Lessons draw a credit (promo period-total vs monthly). Unchanged (0060/0061).
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
    -- FIX (0063): cl.kind is TEXT, new.kind is the enum → compare on the text name.
    select (
      (select count(*) from credit_ledger cl
        where cl.owner_id = new.owner_id and cl.kind = new.kind::text and not cl.voided
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
