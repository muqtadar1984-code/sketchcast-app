-- 0103: the slide deck becomes its OWN generation kind ('deck').
--
-- Until now the .pptx deck was a 'deck_pptx' artifact hanging off the
-- presentation generation, built inside the video job from the narration
-- script. The semantic video prompt (SEMANTIC_PLAN, live 2026-09-02) dropped the
-- per-slide bullets from that script, so decks shipped as heading-plus-glyph.
-- The deck now has its own authoring call and its own row: kind 'deck', job
-- type 'deck' (create_job_for_generation copies kind::text), one 'deck_pptx'
-- artifact at {base}/deck.pptx, with a status, a regenerate and a delete of its
-- own in the Library.
--
-- THE DECK IS FREE. It rides on its lesson's credit and a kit stays 6 credits
-- (0075). credit_ledger_write, fair_use_used and fair_use_used_since
-- deliberately name the six billable kinds and are NOT redefined here: a
-- 'deck' row never enters credit_ledger, never counts toward a cap, never
-- carries over. What an un-metered kind DOES need is the two guards the
-- documents have — a lesson must exist for the unit, and regeneration is
-- bounded per month — otherwise it is unlimited compute.
--
-- Idempotent. Requires 0101 (school trial states in enforce_fair_use).
--
-- ============================================================================
-- ⚠️  APPLY ORDER (the Supabase SQL editor wraps each run in one transaction):
--   STEP 1 — run the `alter type … add value` line below ON ITS OWN first, so
--            the new enum label COMMITS independently. If you run the whole
--            file at once and a later statement errors, the rollback also
--            discards the enum value (→ "invalid input value for enum" later).
--   STEP 2 — run the rest of the file. It is idempotent; the functions compare
--            new.kind::text = 'deck' (text, never the enum literal), so they are
--            safe to (re)create regardless of enum-commit timing.
--   Verify: select enum_range(null::generation_kind);
--           select pg_get_functiondef('public.enforce_fair_use'::regproc);
-- ============================================================================

-- STEP 1 (run alone): the new kit artifact kind -------------------------------
alter type generation_kind add value if not exists 'deck';

-- STEP 2: guards -----------------------------------------------------------------
-- Reproduces the prod body of enforce_fair_use (== 0101's definition,
-- re-verified against pg_get_functiondef on 2026-09-04) and inserts a 'deck'
-- branch right after the exam branch and BEFORE the presentation branch: the
-- deck returns without ever reaching a credit check.
create or replace function public.enforce_fair_use() returns trigger
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
  eff_cap int;
begin
  tier := plan_tier(new.owner_id);

  -- 0100: the locked school states are decided FIRST. Suspension is the console
  -- kill switch, so it sits above even the console cap override; expiry sits
  -- just below that override (a blessed account stays blessed). Both must come
  -- before the exam and revision-paper branches, which return without ever
  -- reaching a credit check — a 0 cap alone would not stop them.
  if tier = 'school_suspended' then
    raise exception 'Your school''s SketchCast access is suspended. Please contact support.';
  end if;

  if exists (select 1 from profiles p where p.id = new.owner_id
             and (p.max_books is not null or p.max_chapters is not null)) then
    return new;
  end if;

  if tier = 'school_expired' then
    raise exception 'Your school''s free trial has ended. Ask your SketchCast contact to activate the school to keep generating.';
  end if;

  select * into caps from fair_use_caps(tier);

  -- The effective cap: tier default + anything support has comped. Guarded so
  -- the school sentinel (2147483647) is never arithmetic'd into an overflow.
  if caps.parts_cap >= 2147483647 then
    eff_cap := caps.parts_cap;
  else
    eff_cap := caps.parts_cap + fair_use_granted(new.owner_id);
  end if;

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
        where p.owner_id = new.owner_id and p.kind = 'presentation' and p.status <> 'error'
          and p.book_id is not distinct from new.book_id
          and p.chapter_ref = (s.value->>'chapter')
          and coalesce(case when p.params->>'part' ~ '^[0-9]{1,9}$' then (p.params->>'part')::int end, 0)
              = coalesce(case when s.value->>'part' ~ '^[0-9]{1,9}$' then (s.value->>'part')::int end, 0)
      )
    ) then
      raise exception 'An exam can only cover chapters and parts you''ve already generated a lesson for.';
    end if;
    if caps.parts_cap < 2147483647
       and (select count(*) from generations g
              where g.owner_id = new.owner_id and g.kind::text = 'exam' and g.status <> 'error'
                and g.created_at >= date_trunc('month', now())) >= 12 then
      raise exception 'You''ve reached this month''s exams (12). It resets on the 1st.';
    end if;
    return new;
  end if;

  -- 0103: the slide deck is FREE with its lesson. Two guards and no credit
  -- check — the lesson for this exact unit must exist (rows inserted earlier
  -- in the same kit statement are visible here, 0075), and a unit's deck can
  -- be (re)generated at most 3 times a month. Unlimited tiers skip both, as
  -- the documents do.
  if new.kind::text = 'deck' then
    if caps.parts_cap >= 2147483647 then
      return new;
    end if;
    perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));
    new_part := coalesce(case when new.params->>'part' ~ '^[0-9]{1,9}$'
                              then (new.params->>'part')::int end, 0);
    select exists (
      select 1 from generations p
      where p.owner_id = new.owner_id and p.kind = 'presentation' and p.status <> 'error'
        and p.book_id is not distinct from new.book_id
        and p.chapter_ref is not distinct from new.chapter_ref
        and coalesce(case when p.params->>'part' ~ '^[0-9]{1,9}$'
                          then (p.params->>'part')::int end, 0) = new_part
    ) into has_lesson;
    if not has_lesson then
      raise exception 'The slide deck is part of a lesson kit — generate the lesson for this chapter first.';
    end if;
    select count(*) into kind_rows from generations d
      where d.owner_id = new.owner_id and d.kind::text = 'deck' and d.status <> 'error'
        and d.book_id is not distinct from new.book_id
        and d.chapter_ref is not distinct from new.chapter_ref
        and coalesce(case when d.params->>'part' ~ '^[0-9]{1,9}$'
                          then (d.params->>'part')::int end, 0) = new_part
        and d.created_at >= date_trunc('month', now());
    if kind_rows >= 3 then
      raise exception 'Regeneration limit: the slide deck was already generated % times this month for this lesson. It resets on the 1st.', kind_rows;
    end if;
    return new;
  end if;

  if new.kind = 'presentation' then
    if caps.parts_cap >= 2147483647 then
      return new;
    end if;
    perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));
    if tier = 'promo' then
      if fair_use_used(new.owner_id, 'credits', promo_credit_from()) >= eff_cap then
        raise exception 'Your free trial includes % generations with every feature unlocked, and you''ve used them all. Subscribe to keep generating.',
          eff_cap;
      end if;
      return new;
    end if;
    -- 0100: the school trial is a period total from its anchor, not a month.
    if tier = 'school_trial' then
      if fair_use_used_since(new.owner_id, school_trial_anchor(new.owner_id)) >= eff_cap then
        raise exception 'Your school''s free trial includes % generations, and you''ve used them all. Ask your SketchCast contact to activate the school to keep generating.',
          eff_cap;
      end if;
      return new;
    end if;
    select * into a from fair_use_avail(new.owner_id, 'credits', eff_cap);
    if a.available < 1
       and a.available + fair_use_purchased_remaining(new.owner_id) < 1 then
      raise exception 'Monthly limit reached: your plan includes % generations/month (+% carried over) — a lesson, a worksheet, a plan, an activity, a test paper and a case study each count as one. It resets on the 1st, or upgrade for more.',
        eff_cap, a.carry;
    end if;
    return new;
  end if;

  if new.kind in ('worksheet', 'exam_paper', 'lesson_plan', 'activity', 'case_study') then
    if caps.parts_cap >= 2147483647 then
      return new;
    end if;
    perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));

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
      return new;
    end if;

    new_part := coalesce(case when new.params->>'part' ~ '^[0-9]{1,9}$'
                              then (new.params->>'part')::int end, 0);
    select exists (
      select 1 from generations p
      where p.owner_id = new.owner_id and p.kind = 'presentation' and p.status <> 'error'
        and p.book_id is not distinct from new.book_id
        and p.chapter_ref is not distinct from new.chapter_ref
        and coalesce(case when p.params->>'part' ~ '^[0-9]{1,9}$'
                          then (p.params->>'part')::int end, 0) = new_part
    ) into has_lesson;
    if not has_lesson then
      raise exception 'Documents generate with their lesson — generate the lesson for this chapter first, or use Revision papers over chapters you''ve already taught.';
    end if;
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

    if tier = 'promo' then
      if fair_use_used(new.owner_id, 'credits', promo_credit_from()) >= eff_cap then
        raise exception 'Your free trial includes % generations with every feature unlocked, and you''ve used them all. Subscribe to keep generating.',
          eff_cap;
      end if;
    elsif tier = 'school_trial' then
      -- 0100: same period budget as the lesson path.
      if fair_use_used_since(new.owner_id, school_trial_anchor(new.owner_id)) >= eff_cap then
        raise exception 'Your school''s free trial includes % generations, and you''ve used them all. Ask your SketchCast contact to activate the school to keep generating.',
          eff_cap;
      end if;
    else
      select * into a from fair_use_avail(new.owner_id, 'credits', eff_cap);
      if a.available < 1
         and a.available + fair_use_purchased_remaining(new.owner_id) < 1 then
        raise exception 'Monthly limit reached: your plan includes % generations/month (+% carried over) — a lesson, a worksheet, a plan, an activity, a test paper and a case study each count as one. It resets on the 1st, or upgrade for more.',
          eff_cap, a.carry;
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- Double-submit guard (0076): prod body with 'deck' added to the kind list — a
-- double click on "+ Deck" must not queue two decks.
create or replace function public.reject_double_submit() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare
  new_part int;
begin
  if new.kind::text not in
     ('presentation','worksheet','lesson_plan','activity','exam_paper','case_study','deck')
     or coalesce(new.params->>'revision','') = 'true' then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));

  new_part := coalesce(
    case when new.params->>'part' ~ '^[0-9]{1,9}$' then (new.params->>'part')::int end, 0);

  if exists (
    select 1 from generations g
    where g.owner_id = new.owner_id
      and g.kind = new.kind
      and g.book_id is not distinct from new.book_id
      and g.chapter_ref is not distinct from new.chapter_ref
      and coalesce(
            case when g.params->>'part' ~ '^[0-9]{1,9}$' then (g.params->>'part')::int end, 0
          ) = new_part
      and coalesce(g.params->>'revision','') <> 'true'
      and g.status <> 'error'
      and g.created_at > now() - interval '10 seconds'
  ) then
    raise exception 'That kit is already being made — give it a moment to appear.'
      using errcode = 'unique_violation';
  end if;

  return new;
end;
$$;
