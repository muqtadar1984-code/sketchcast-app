-- 0155 rollback: back to ONE translation in flight (the 0142 claim and the
-- 0147 enqueue, restored verbatim from production's pg_get_functiondef on
-- 2026-10-25), then the two helpers go. The worker reads
-- auto_translate.parallel itself; clear that too so both sides agree:
--   update platform_settings set value = value - 'parallel' where key = 'auto_translate';
begin;

CREATE OR REPLACE FUNCTION public.claim_catalogue_observer_job(p_types text[], p_max_jobs integer)
 RETURNS SETOF jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_n       integer;
  v_job     public.jobs%rowtype;
  v_types   text[] := p_types;
  v_only    uuid[] := null;
begin
  perform pg_advisory_xact_lock(hashtext('catalogue_claim'));
  if 'kit_translate' = any (v_types) then
    if exists (select 1 from public.jobs j where j.type = 'kit_translate' and j.status = 'processing')
       or exists (select 1 from public.topic_kits k
                   where k.status = 'generating' and coalesce(k.language, 'en') <> 'en'
                     and not exists (select 1 from public.jobs q
                                      where q.type = 'kit_translate' and q.status = 'queued'
                                        and q.params->>'source_kit_id' = k.source_kit_id::text
                                        and q.params->>'language' = k.language)) then
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
end $function$;

CREATE OR REPLACE FUNCTION public.auto_translate_enqueue(p_source_kit_id uuid, p_language text, p_dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_c   record;
  v_job uuid;
begin
  perform pg_advisory_xact_lock(hashtext('auto_translate'));
  if exists (select 1 from jobs j where j.type = 'kit_translate' and j.status in ('queued', 'processing')) then
    return jsonb_build_object('queued', false, 'why', 'translation_in_flight');
  end if;
  if exists (select 1 from topic_kits k where k.status = 'generating' and coalesce(k.language, 'en') <> 'en') then
    return jsonb_build_object('queued', false, 'why', 'translated_kit_rendering');
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
end $function$;

drop function if exists public.translations_in_flight();
drop function if exists public.translate_slots();

commit;
