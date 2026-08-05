-- 0076 — Reject a kit that is submitted twice in a few seconds.
--
-- Observed twice in production on a system with barely a dozen real kits:
--
--   Soils And Crop Growth Chapter3   all 6 kinds duplicated,  3.77 s apart
--   Price elasticity of supply       all 6 kinds duplicated, 18.37 s apart
--
-- Both were the same accident. generate-kit-button.tsx cleared its busy flag the
-- moment the INSERT returned, but the insert is fast (the real work happens later
-- in the worker) and nothing on screen changes until router.refresh() completes.
-- In that gap the button is live and the page looks untouched, so the teacher
-- clicks again. Eighteen seconds apart is not a stray double-tap; that is someone
-- waiting, seeing nothing, and trying again.
--
-- The client is fixed to stay disabled until the refreshed UI replaces it, but a
-- client guard cannot cover a second tab, a retried request, or a flaky
-- connection — and since 0075 the cost of a double is no longer academic: a kit
-- is 6 credits against a Teacher Pro allowance of 24, so one stray click spends a
-- quarter of the month on a chapter the teacher already has.
--
-- DELIBERATELY NARROW. This rejects only an identical (owner, book, chapter,
-- part, kind) within seconds. It is not a uniqueness rule:
--   * regenerating later is untouched — "New version" is minutes or hours away,
--     and its own 3-per-month limit already lives in enforce_fair_use;
--   * a kit's own six rows differ by KIND, so the one-statement kit insert that
--     0075 relies on still succeeds whole;
--   * exams and revision papers are exempt. They legitimately repeat the same
--     (book, chapter, part) tuple with different scope in params, and rejecting
--     the second one would break a real workflow to prevent a hypothetical.
--
-- The advisory lock is the same key enforce_fair_use takes, so two tabs racing
-- serialise instead of both passing the exists() check. Advisory locks are
-- re-entrant within a transaction, so taking it here costs the later trigger
-- nothing.
--
-- Named to sort before `fair_use_cap`: triggers fire in alphabetical order, and a
-- duplicate should say it is a duplicate rather than report a monthly limit.

create or replace function public.reject_double_submit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  new_part int;
begin
  -- Only the six kit kinds. Exams and revision papers repeat this tuple by design.
  if new.kind::text not in
     ('presentation','worksheet','lesson_plan','activity','exam_paper','case_study')
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

drop trigger if exists duplicate_guard on public.generations;
create trigger duplicate_guard
  before insert on public.generations
  for each row execute function public.reject_double_submit();
