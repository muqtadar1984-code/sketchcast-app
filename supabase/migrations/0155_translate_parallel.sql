-- 0155: translations use the catalogue's kit slots (founder, 2026-10-25:
-- "ensure it uses all 4 queues"). Until now ONE translation was in flight at a
-- time (0141, 0142, 0147). A translation makes no image calls — its renders
-- reuse the English kit's pictures — so several can run side by side without
-- starving the image pool; each translated kit still takes one of the worker's
-- MAX_CATALOGUE_KITS slots.
--
-- The number is a setting, platform_settings.auto_translate.parallel (1..8),
-- read here and by the worker (catalogue/translate.py translate_slots). Unset
-- = 1 = the old rule exactly, so this migration changes nothing until the
-- setting is written.
--
-- One translation in flight = one (source kit, language): its kit_translate
-- job processing and the topic_kits row that job creates are the SAME
-- translation and count once. A generating kit its own queued job will resume
-- (0142, the orphan rule) does not count, and that job is still claimed first.

begin;

create or replace function public.translate_slots()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select greatest(1, least(8, (s.value ->> 'parallel')::integer))
      from public.platform_settings s
     where s.key = 'auto_translate'
       and coalesce(s.value ->> 'parallel', '') ~ '^[0-9]+$'), 1)
$$;

create or replace function public.translations_in_flight()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer from (
    select coalesce(j.params ->> 'source_kit_id', j.id::text) || '|' || lower(coalesce(j.params ->> 'language', '')) as k
      from public.jobs j
     where j.type = 'kit_translate' and j.status = 'processing'
    union
    select k.source_kit_id::text || '|' || lower(k.language)
      from public.topic_kits k
     where k.status = 'generating' and coalesce(k.language, 'en') <> 'en'
       and not exists (select 1 from public.jobs q
                        where q.type = 'kit_translate' and q.status = 'queued'
                          and q.params ->> 'source_kit_id' = k.source_kit_id::text
                          and q.params ->> 'language' = k.language)
  ) s
$$;

create or replace function public.claim_catalogue_observer_job(p_types text[], p_max_jobs integer)
returns setof public.jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n       integer;
  v_job     public.jobs%rowtype;
  v_types   text[] := p_types;
  v_only    uuid[] := null;
begin
  perform pg_advisory_xact_lock(hashtext('catalogue_claim'));
  if 'kit_translate' = any (v_types) then
    if public.translations_in_flight() >= public.translate_slots() then
      v_types := array_remove(v_types, 'kit_translate');
    else
      select array_agg(q.id) into v_only
        from public.jobs q
        join public.topic_kits k
          on k.status = 'generating' and coalesce(k.language, 'en') <> 'en'
         and q.params->>'source_kit_id' = k.source_kit_id::text
         and q.params->>'language' = k.language
       where q.type = 'kit_translate' and q.status = 'queued';
    end if;
  end if;
  if coalesce(array_length(v_types, 1), 0) = 0 then
    return;
  end if;
  select count(*) into v_n from public.jobs j
   where j.status = 'processing' and j.type = any (p_types);
  if v_n >= greatest(1, p_max_jobs) then
    return;
  end if;
  select j.* into v_job
    from public.jobs j
   where j.status = 'queued'
     and j.type = any (v_types)
     and (v_only is null or j.type <> 'kit_translate' or j.id = any (v_only))
     and (j.params->>'deferred_until' is null
          or (j.params->>'deferred_until')::timestamptz < now())
   order by j.created_at
   limit 1
   for update skip locked;
  if not found then
    return;
  end if;
  update public.jobs set status = 'processing', progress = 1, claimed_at = now()
   where id = v_job.id and status = 'queued'
  returning * into v_job;
  if found then
    return next v_job;
  end if;
end
$$;

create or replace function public.auto_translate_enqueue(p_source_kit_id uuid, p_language text, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c   record;
  v_job uuid;
begin
  perform pg_advisory_xact_lock(hashtext('auto_translate'));
  -- anything already queued (a person's own batch, a Fix Agent retry) goes first
  if exists (select 1 from jobs j where j.type = 'kit_translate' and j.status = 'queued') then
    return jsonb_build_object('queued', false, 'why', 'translation_in_flight');
  end if;
  if public.translations_in_flight() >= public.translate_slots() then
    return jsonb_build_object('queued', false, 'why', 'translation_in_flight');
  end if;
  select * into v_c
    from auto_translate_candidates(array[p_language]) c
   where c.source_kit_id = p_source_kit_id
   limit 1;
  if not found then
    return jsonb_build_object('queued', false, 'why', 'not_a_candidate');
  end if;
  if v_c.hold is not null and v_c.hold <> 'job_failed' then
    return jsonb_build_object('queued', false, 'why', v_c.hold);
  end if;
  if p_dry_run then
    return jsonb_build_object('queued', false, 'dry_run', true, 'source_kit_id', p_source_kit_id,
                              'language', p_language, 'topic_id', v_c.topic_id, 'reason', v_c.reason);
  end if;
  insert into jobs (type, status, book_id, generation_id, params)
  values ('kit_translate', 'queued', null, null,
          jsonb_build_object('source_kit_id', p_source_kit_id, 'topic_id', v_c.topic_id,
                             'language', p_language, 'auto', true))
  returning id into v_job;
  insert into platform_audit_log (actor_id, action, target_kind, target_id, detail)
  values (null, 'auto_translate_enqueue', 'topic', v_c.topic_id,
          jsonb_build_object('source_kit_id', p_source_kit_id, 'language', p_language, 'job_id', v_job,
                             'reason', v_c.reason, 'retry', v_c.hold = 'job_failed'));
  return jsonb_build_object('queued', true, 'job_id', v_job, 'source_kit_id', p_source_kit_id,
                            'language', p_language, 'topic_id', v_c.topic_id, 'reason', v_c.reason);
end
$$;

revoke all on function public.translate_slots() from public, anon, authenticated;
revoke all on function public.translations_in_flight() from public, anon, authenticated;
revoke all on function public.claim_catalogue_observer_job(text[], integer) from public, anon, authenticated;
revoke all on function public.auto_translate_enqueue(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.translate_slots() to service_role;
grant execute on function public.translations_in_flight() to service_role;
grant execute on function public.claim_catalogue_observer_job(text[], integer) to service_role;
grant execute on function public.auto_translate_enqueue(uuid, text, boolean) to service_role;

commit;
