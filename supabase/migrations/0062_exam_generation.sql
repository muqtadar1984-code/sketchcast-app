-- 0062 — Exam generation: a cumulative EXAM over covered chapters/parts.
--
-- Founder decision (2026-07-19): alongside per-part kits (whose "exam" doc is
-- now called a TEST PAPER) and revision papers, teachers need to build a real
-- EXAM — a mid-term / term / final assessment that spans everything covered so
-- far. It produces TWO documents from one generation: the exam paper, and a
-- SEPARATE answer key. The teacher chooses difficulty and the number of
-- questions per type (MCQ, fill-in-the-blanks, true/false, match, short/long
-- answer), and ticks exactly which chapters and parts to test (unticking any
-- topic they want to skip this time).
--
-- Free, like revision papers: an exam is built entirely on lessons already
-- generated (no new lesson analysis is paid for). The safety rule that makes
-- that sound: an exam may only cover units that ALREADY have a live lesson.
-- The UI offers only covered units; this trigger enforces it server-side.
--
-- Mechanics: kind = 'exam', chapter_ref NULL, params.scope = a JSON array of
-- {chapter:"<num>", part:<int>} entries (part 0 = a chapter-level unit; part N
-- = a specific part). The worker grounds the exam on exactly those units and
-- emits two artifacts: kind 'docx' (the paper) and kind 'answer_key_docx' (the
-- key — never surfaced to students). No credit is drawn (kind 'exam' is absent
-- from credit_ledger_write's kind list), so nothing here touches the meter; a
-- generous monthly ceiling keeps the free tool from being farmed.
--
-- Idempotent. Requires 0059 (credit_ledger) + 0061 (revision enforce_fair_use).
--
-- ============================================================================
-- ⚠️  APPLY ORDER (the Supabase SQL editor wraps each run in one transaction):
--   STEP 1 — run the two `alter type … add value` lines below ON THEIR OWN
--            first, so the new enum labels COMMIT independently. If you run the
--            whole file at once and a later statement errors, the rollback also
--            discards the enum values (→ "invalid input value for enum" later).
--   STEP 2 — run the rest of the file. It's idempotent; the function compares
--            new.kind::text = 'exam' (text, never the enum literal), so it is
--            safe to (re)create regardless of enum-commit timing.
-- ============================================================================

-- 1. New enum labels — RUN THESE TWO LINES BY THEMSELVES FIRST -----------------
alter type generation_kind add value if not exists 'exam';
alter type artifact_kind   add value if not exists 'answer_key_docx';

-- 2. Enforcement: exam is FREE (on covered lessons), bounded per month ---------
-- Reproduces 0061's enforce_fair_use verbatim and inserts an 'exam' branch
-- right after the tier/caps are resolved (before the presentation/doc branches).
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
  -- Spans a chosen set of already-taught units (params.scope = [{chapter,part}]).
  -- Free (built on generated lessons), but EVERY unit in scope must already have
  -- a live lesson, and it's bounded per month so the free tool can't be farmed.
  if new.kind::text = 'exam' then
    perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));
    -- coalesce: a MISSING scope key makes jsonb_typeof NULL, and `NULL <> 'array'`
    -- is NULL (not TRUE) — without the coalesce a scope-less exam slips through.
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
    -- Farm bound (free but not unlimited): 12 exams/month. Unlimited tiers
    -- (school / console-blessed already returned above) skip it.
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
