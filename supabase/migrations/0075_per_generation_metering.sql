-- 0075 — Meter per GENERATION, not per lesson.
--
-- Until now one credit bought a lesson AND its five documents: fair_use_used()
-- counted only kind='presentation', and enforce_fair_use()'s document branch
-- never consulted the cap at all — documents were gated only by "a lesson for
-- this part must exist" plus a 3-per-month regeneration limit.
--
-- That is not what the plans are sold as. From now on EVERY billable artifact
-- costs one credit: a lesson, a worksheet, a plan, an activity, a test paper, a
-- case study. Measured cost is ~$0.32 per artifact and ~$1.90 for a full
-- six-piece kit, so the old shipped meter was roughly six times more generous
-- than the published caps — enough that Teacher Pro at 16 lessons cost more to
-- serve than it charged.
--
-- ── BETA USERS MUST NOT NOTICE ────────────────────────────────────────────────
-- Every account today is on 'promo' (25) or 'trial' (13); NOBODY is on pro,
-- pro_plus or family. Those three caps are therefore forward-looking only and
-- change nobody's experience today.
--
-- But the metering change would hit promo and trial hard — a promo user on 4
-- credits would go from 4 full kits to two-thirds of one. So their caps are
-- multiplied by SIX, which leaves their effective allowance exactly where it
-- was: promo still gets 4 kits, trial still gets 16.
--
--   tier      before            after      effective allowance
--   promo     4  lessons        24 gens    4 kits   (unchanged)
--   trial     16 lessons        96 gens    16 kits  (unchanged)
--   pro       16 lessons        24 gens    4 kits   (NEW — was 16 kits)
--   pro_plus  32 lessons        72 gens    12 kits  (NEW — was 32 kits)
--   family    6  lessons        12 gens    2 kits   (NEW — was 6 kits)
--   school    unmetered         unmetered  unchanged

-- ── Caps ──────────────────────────────────────────────────────────────────────
create or replace function public.fair_use_caps(tier text)
returns table(parts_cap integer, docs_cap integer, books_cap integer)
language sql
immutable
as $$
  select t.parts_cap, t.docs_cap, t.books_cap from (values
    -- parts_cap is now a count of GENERATIONS, not lessons.
    ('trial',    96, 0, 2147483647),  -- 16 kits — beta held harmless (was 16)
    ('promo',    24, 0, 2),           -- 4 kits  — beta held harmless (was 4)
    ('pro',      24, 0, 2),           -- 4 kits
    ('pro_plus', 72, 0, 4),           -- 12 kits
    ('family',   12, 0, 2),           -- 2 kits
    ('school',   2147483647, 2147483647, 2147483647)
  ) as t(k, parts_cap, docs_cap, books_cap)
  where t.k = coalesce(tier, 'trial');
$$;

-- ── What counts as used ───────────────────────────────────────────────────────
-- Every billable kind now, not just the lesson. credit_ledger_write already
-- records a row for all six kinds, so the ledger arm simply drops its filter;
-- the fallback arm (rows generated before a ledger row existed) has to name the
-- kinds explicitly, and keeps the video_parts multiplier that applies only to a
-- multi-part lesson.
create or replace function public.fair_use_used(uid uuid, unit text, month_start timestamptz)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $$
  select (
    coalesce((select sum(cl.units) from credit_ledger cl
              where cl.owner_id = uid and not cl.voided
                and cl.created_at >= month_start
                and cl.created_at < month_start + interval '1 month'), 0)
    +
    coalesce((select sum(case when g.kind = 'presentation'
                              then greatest(coalesce((g.params->>'video_parts')::int, 1), 1)
                              else 1 end)
              from generations g
              where g.owner_id = uid
                and g.kind in ('presentation','worksheet','exam_paper','lesson_plan','activity','case_study')
                and g.status <> 'error'
                and g.created_at >= month_start
                and g.created_at < month_start + interval '1 month'
                and not exists (select 1 from credit_ledger cl2 where cl2.generation_id = g.id)), 0)
  )::int;
$$;

-- ── Enforcement ───────────────────────────────────────────────────────────────
-- Same shape as before, with two changes: the document branch now consumes the
-- allowance like the lesson does, and the messages talk about generations
-- rather than promising a free document kit.
--
-- One ordering note that makes this safe: "Generate kit" inserts all six rows in
-- ONE statement, and rows inserted earlier in a statement are visible to the
-- later rows' triggers — so the sixth row sees the five before it. A statement
-- is atomic, so a kit that would breach the cap fails whole rather than leaving
-- a teacher with a lesson and no worksheet.
create or replace function public.enforce_fair_use()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
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

  if new.kind = 'presentation' then
    if caps.parts_cap >= 2147483647 then
      return new;
    end if;
    perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));
    if tier = 'promo' then
      if fair_use_used(new.owner_id, 'credits', promo_credit_from()) >= caps.parts_cap then
        raise exception 'Your free trial includes % generations with every feature unlocked, and you''ve used them all. Subscribe to keep generating.',
          caps.parts_cap;
      end if;
      return new;
    end if;
    select * into a from fair_use_avail(new.owner_id, 'credits', caps.parts_cap);
    if a.available < 1 then
      raise exception 'Monthly limit reached: your plan includes % generations/month (+% carried over) — a lesson, a worksheet, a plan, an activity, a test paper and a case study each count as one. It resets on the 1st, or upgrade for more.',
        caps.parts_cap, a.carry;
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

    -- NEW in 0075: a document costs a credit, exactly like the lesson does.
    if tier = 'promo' then
      if fair_use_used(new.owner_id, 'credits', promo_credit_from()) >= caps.parts_cap then
        raise exception 'Your free trial includes % generations with every feature unlocked, and you''ve used them all. Subscribe to keep generating.',
          caps.parts_cap;
      end if;
    else
      select * into a from fair_use_avail(new.owner_id, 'credits', caps.parts_cap);
      if a.available < 1 then
        raise exception 'Monthly limit reached: your plan includes % generations/month (+% carried over) — a lesson, a worksheet, a plan, an activity, a test paper and a case study each count as one. It resets on the 1st, or upgrade for more.',
          caps.parts_cap, a.carry;
      end if;
    end if;
  end if;
  return new;
end;
$$;
