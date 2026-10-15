-- Rollback for 0129_adopt_copy_is_not_a_generation.sql.
-- Removes the copy guard from the four triggers and the flag from
-- adopt_school_kit, restoring their pre-0129 behaviour exactly. No data change.
-- Run inside a transaction.

do $unpatch$
declare
  guard constant text :=
    '-- 0129: a finished COPY (adopt_school_kit) is not a generation: not metered.' || chr(10) ||
    '  if new.status = ''done'' and public.generation_copy_in_progress() then' || chr(10) ||
    '    return new;' || chr(10) ||
    '  end if;' || chr(10) || '  ';
  fn text;
  d text;
begin
  foreach fn in array array['reject_double_submit', 'enforce_fair_use', 'credit_ledger_write'] loop
    d := pg_get_functiondef(format('public.%I', fn)::regproc);
    if position(guard in d) = 0 then
      raise notice '0129 down: % has no guard, skipped', fn;
      continue;
    end if;
    execute replace(d, guard, '');
  end loop;
end
$unpatch$;

create or replace function public.create_job_for_generation()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
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

  insert into generations (kind, book_id, chapter_ref, title, owner_id, school_id, status, params)
  values (src.kind, src.book_id, src.chapter_ref, src.title, me, src.school_id, 'done', src.params)
  returning id into new_id;

  insert into artifacts (generation_id, kind, storage_path)
  select new_id, a.kind, a.storage_path
  from artifacts a
  where a.generation_id = src.id;

  return new_id;
end;
$function$;

drop function if exists public.generation_copy_in_progress();
