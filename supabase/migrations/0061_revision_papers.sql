-- 0061 — Revision papers: standalone / cumulative worksheets & exams.
--
-- Founder decision (2026-07-19): batch generation is a REVISION tool for
-- term/mid-term/exam time. A teacher picks a GROUP of chapters and generates
-- ONLY worksheets and/or exam papers (never the full kit), either as
--   · one cumulative paper spanning the selected chapters (a real term exam), or
--   · one paper per selected chapter (a revision pack).
-- These are marked params.revision = true (cumulative also carries
-- params.chapters = [nums]). Unlike a lesson's kit documents (which ride FREE
-- with their lesson, 0059), a revision paper is a STANDALONE assessment with no
-- lesson to reuse — so it draws ONE lesson credit, like a lesson.
--
-- Mechanics: the credit_ledger (0059) grows a `billable` flag. A row is
-- billable when it's a presentation OR a revision document; fair_use_used sums
-- billable units (was: presentation parts only). enforce_fair_use routes
-- presentations AND revision docs through the same credit check (allowed
-- standalone, no lesson required), while NON-revision documents keep the
-- free-with-their-lesson kit rule. Everything composes with the monthly caps
-- (0059) and the promo period-total (0060) unchanged.
--
-- Per-chapter revision papers on a chapter that ALREADY has a lesson stay free
-- (they omit params.revision and ride the lesson as a kit add-back). The UI
-- only sets params.revision when the paper would otherwise be refused.
--
-- Idempotent. Requires 0059 (credit_ledger) + 0060 (promo tier).

-- ── credit_ledger.billable (re-run-safe backfill) ────────────────────────────
alter table public.credit_ledger add column if not exists billable boolean;
update public.credit_ledger set billable = (kind = 'presentation') where billable is null;
alter table public.credit_ledger alter column billable set not null;
alter table public.credit_ledger alter column billable set default false;
create index if not exists credit_ledger_billable_idx on public.credit_ledger (owner_id, created_at) where billable;

-- ── Writer: mark presentations + revision docs billable; seed lesson parts ───
create or replace function credit_ledger_write() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare
  n int := 1;
  is_billable boolean;
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
    is_billable := new.kind = 'presentation'
      or (new.kind in ('worksheet', 'exam_paper', 'lesson_plan', 'activity', 'case_study')
          and (new.params->>'revision') = 'true');
    insert into credit_ledger (owner_id, generation_id, kind, units, book_id, chapter_ref, part, voided, billable)
    values (new.owner_id, new.id, new.kind, n, new.book_id, new.chapter_ref,
            coalesce(case when new.params->>'part' ~ '^[0-9]{1,9}$' then (new.params->>'part')::int end, 0),
            new.status = 'error', is_billable);
  end if;
  return null;
end $$;
drop trigger if exists credit_ledger_write on generations;
create trigger credit_ledger_write after insert on generations
  for each row execute function credit_ledger_write();

-- ── Credits used = billable units (lessons + revision papers), delete-proof ──
create or replace function public.fair_use_used(uid uuid, unit text, month_start timestamptz)
returns int
  language sql stable security definer set search_path = public as
$$
  select (
    coalesce((select sum(cl.units) from credit_ledger cl
              where cl.owner_id = uid and cl.billable and not cl.voided
                and cl.created_at >= month_start
                and cl.created_at < month_start + interval '1 month'), 0)
    +
    -- not-yet-ledgered same-statement billable rows: presentations (parts) +
    -- revision documents (1 each).
    coalesce((select sum(case when g.kind = 'presentation'
                              then greatest(coalesce((g.params->>'video_parts')::int, 1), 1)
                              else 1 end)
              from generations g
              where g.owner_id = uid and g.status <> 'error'
                and (g.kind = 'presentation'
                     or (g.kind in ('worksheet', 'exam_paper', 'lesson_plan', 'activity', 'case_study')
                         and (g.params->>'revision') = 'true'))
                and g.created_at >= month_start
                and g.created_at < month_start + interval '1 month'
                and not exists (select 1 from credit_ledger cl2 where cl2.generation_id = g.id)), 0)
  )::int;
$$;

-- ── Enforcement: lessons AND revision papers draw a credit; kit docs free ────
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
  is_revision boolean;
begin
  if exists (select 1 from profiles p where p.id = new.owner_id
             and (p.max_books is not null or p.max_chapters is not null)) then
    return new;
  end if;
  tier := plan_tier(new.owner_id);
  select * into caps from fair_use_caps(tier);

  is_revision := new.kind in ('worksheet', 'exam_paper', 'lesson_plan', 'activity', 'case_study')
    and (new.params->>'revision') = 'true';

  -- Billable = a video lesson OR a standalone revision paper: one credit each,
  -- allowed without a lesson (a revision paper is its own thing).
  if new.kind = 'presentation' or is_revision then
    if caps.parts_cap >= 2147483647 then
      return new; -- unlimited tiers
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
      raise exception 'Monthly limit reached: your plan includes % lessons/month (+% carried over) — each lesson brings its full document kit free, and revision papers draw one credit each. It resets on the 1st, or upgrade for more.',
        caps.parts_cap, a.carry;
    end if;
    return new;
  end if;

  -- Non-revision documents: FREE, but only WITH their lesson (the kit rule).
  if new.kind in ('worksheet', 'exam_paper', 'lesson_plan', 'activity', 'case_study') then
    if caps.parts_cap >= 2147483647 then
      return new;
    end if;
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
      raise exception 'Documents generate together with their lesson — generate the lesson for this chapter first (its kit is free), or use Revision papers to make a standalone worksheet or exam.';
    end if;
    select (
      (select count(*) from credit_ledger cl
        where cl.owner_id = new.owner_id and cl.kind = new.kind and not cl.voided and not cl.billable
          and cl.book_id is not distinct from new.book_id
          and cl.chapter_ref is not distinct from new.chapter_ref
          and cl.part = new_part
          and cl.created_at >= date_trunc('month', now()))
      +
      (select count(*) from generations d
        where d.owner_id = new.owner_id and d.kind = new.kind and d.status <> 'error'
          and coalesce((d.params->>'revision'), '') <> 'true'
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
