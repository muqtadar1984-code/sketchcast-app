-- 0129: adopting a colleague's kit is a COPY, not a generation.
--
-- 0073 (school kit reuse) promised "the bytes are identical and the worker
-- never runs": adopt_school_kit inserts a teacher-owned generations row with
-- status 'done' and copies the artifacts rows (same storage paths, no file
-- copy). But every generations insert fires the insert triggers, and four of
-- them treat that copy as a brand-new generation (audited 2026-10-15 against
-- the LIVE definitions):
--
--   on_generation_created  create_job_for_generation  enqueues a QUEUED job
--                          for every row whatever its status. The worker's
--                          claim_next_job takes any queued job, relabels the
--                          generation 'processing' and rebuilds the whole kit
--                          from scratch (model, images, render, new uploads).
--   credit_ledger_write    writes a ledger row: on a school TRIAL that spends
--                          the trial's generation budget on a kit that cost
--                          nothing to make.
--   fair_use_cap           on a school trial whose budget is spent, REFUSES
--                          the copy, so reuse fails exactly when it would help.
--   duplicate_guard        can refuse a second same-kind copy inside 10 s.
--
-- Nobody has adopted a kit in production yet (0 adopted rows), so this is
-- latent, not live. The button is live (generate-kit-button.tsx offers a
-- colleague's kit before generating).
--
-- THE FIX: a transaction-local flag, `sketchcast.generation_copy`, that only
-- SECURITY DEFINER copy functions set, around their own inserts. The four
-- triggers return early for a row inserted with status 'done' while it is set.
-- Why a flag and not a params key: adopt_school_kit's idempotency check and the
-- app's kit signature both compare `params` EXACTLY, so tagging the copy's
-- params would break both. A client cannot set the flag: PostgREST exposes only
-- functions in the `public` schema (set_config is pg_catalog) and only
-- `request.*` settings; every request is its own transaction, and the flag is
-- set with is_local = true and cleared before the function returns.
--
-- What is NOT changed:
--   · a suspended or expired school is still refused (the fair-use early return
--     sits AFTER those two checks);
--   · lesson-tools and the console chapter cap (beta_generation_cap) still apply;
--   · every other insert behaves exactly as before: the guard needs BOTH the
--     flag AND status 'done', and nothing but a copy function sets the flag.
--
-- The three large trigger functions are patched IN PLACE from their live
-- definitions (pg_get_functiondef → insert the guard at a unique anchor →
-- execute), so this migration cannot revert any drift between the repo's
-- copies and production. Each patch asserts its anchor occurs exactly once and
-- is skipped if the guard is already there (re-runnable).
--
-- Catalogue Phase C (adopt_catalogue_piece) reuses the same flag.
-- Rollback: supabase/rollback/0129_adopt_copy_is_not_a_generation_down.sql

create or replace function public.generation_copy_in_progress()
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(current_setting('sketchcast.generation_copy', true), '') = 'on'
$$;
revoke all on function public.generation_copy_in_progress() from public, anon, authenticated;

comment on function public.generation_copy_in_progress() is
  'True only inside a SECURITY DEFINER copy function (adopt_school_kit, later adopt_catalogue_piece) while it inserts a finished copy. Triggers use it to skip job creation and metering for that copy.';

-- ── 1. The job trigger (small: written out in full, from the live body) ─────
create or replace function public.create_job_for_generation()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  -- 0129: a finished COPY (adopt_school_kit) needs no worker.
  if new.status = 'done' and public.generation_copy_in_progress() then
    return new;
  end if;
  if coalesce(new.params->>'catalogue', '') = 'true' then
    insert into jobs (generation_id, type, status, params)
    values (new.id, new.kind::text, 'queued',
            jsonb_strip_nulls(jsonb_build_object(
              'catalogue', true,
              'topic_id', new.params->'topic_id',
              'kit_id', new.params->'kit_id',
              'question_set_id', new.params->'question_set_id')));
    return new;
  end if;
  insert into jobs (generation_id, type, status) values (new.id, new.kind::text, 'queued');
  return new;
end
$function$;

-- ── 2. The three metering triggers, patched in place ──────────────────────
do $patch$
declare
  guard constant text :=
    '-- 0129: a finished COPY (adopt_school_kit) is not a generation: not metered.' || chr(10) ||
    '  if new.status = ''done'' and public.generation_copy_in_progress() then' || chr(10) ||
    '    return new;' || chr(10) ||
    '  end if;' || chr(10) || '  ';
  p record;
  d text;
  n int;
begin
  for p in
    select * from (values
      -- function,               anchor (the guard goes immediately BEFORE it)
      ('reject_double_submit',  'if new.kind::text not in'),
      ('enforce_fair_use',      'select * into caps from fair_use_caps(tier);'),   -- after the suspended/expired refusals
      ('credit_ledger_write',   'if new.kind in (''presentation'', ''worksheet'', ''exam_paper'', ''lesson_plan'', ''activity'', ''case_study'') then')
    ) as t(fn, anchor)
  loop
    d := pg_get_functiondef(format('public.%I', p.fn)::regproc);
    if position('generation_copy_in_progress()' in d) > 0 then
      raise notice '0129: % already guarded, skipped', p.fn;
      continue;
    end if;
    n := (length(d) - length(replace(d, p.anchor, ''))) / length(p.anchor);
    if n <> 1 then
      raise exception '0129: anchor for % occurs % times (expected 1); the live function changed, re-check before applying', p.fn, n;
    end if;
    execute replace(d, p.anchor, guard || p.anchor);
    raise notice '0129: % guarded', p.fn;
  end loop;

  -- The suspended/expired refusals must still come BEFORE the fair-use guard.
  d := pg_get_functiondef('public.enforce_fair_use'::regproc);
  if not (position('if tier = ''school_suspended'' then' in d) < position('generation_copy_in_progress()' in d)
          and position('if tier = ''school_expired'' then' in d) < position('generation_copy_in_progress()' in d)) then
    raise exception '0129: fair-use guard landed before the suspended/expired refusals';
  end if;
end
$patch$;

-- ── 3. adopt_school_kit sets the flag around its own inserts ─────────────
-- Body = the live definition (0073) plus the two set_config lines.
create or replace function public.adopt_school_kit(p_source uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  src record;
  me uuid := auth.uid();
  my_school uuid;
  new_id uuid;
begin
  if me is null then
    raise exception 'not signed in';
  end if;

  select p.school_id into my_school from profiles p where p.id = me and p.role <> 'student';
  if my_school is null then
    raise exception 'not a school member';
  end if;

  select g.* into src
  from generations g
  where g.id = p_source
    and g.school_id = my_school
    and g.removed_at is null
    and g.withdrawn_at is null
    and g.status = 'done';
  if src.id is null then
    raise exception 'that kit is not available';
  end if;

  select g.id into new_id
  from generations g
  where g.owner_id = me
    and g.book_id is not distinct from src.book_id
    and g.chapter_ref is not distinct from src.chapter_ref
    and g.kind = src.kind
    and g.params is not distinct from src.params
    and g.removed_at is null
    and g.withdrawn_at is null
  limit 1;
  if new_id is not null then
    return new_id;
  end if;

  -- 0129: this insert is a copy — no job, no metering (see the header).
  perform set_config('sketchcast.generation_copy', 'on', true);

  insert into generations (kind, book_id, chapter_ref, title, owner_id, school_id, status, params)
  values (src.kind, src.book_id, src.chapter_ref, src.title, me, src.school_id, 'done', src.params)
  returning id into new_id;

  insert into artifacts (generation_id, kind, storage_path)
  select new_id, a.kind, a.storage_path
  from artifacts a
  where a.generation_id = src.id;

  perform set_config('sketchcast.generation_copy', '', true);

  return new_id;
end;
$function$;
