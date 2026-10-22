-- 0153 rollback. Turn FAIR_CLAIM off on the worker FIRST (it falls back to its
-- Python claim on any RPC error anyway). credit_ledger_sync goes back to the
-- 0088 body; ledger rows already voided 'staff_cancel' keep that reason.
begin;
drop function if exists public.pause_my_book(uuid, boolean);
drop function if exists public.cancel_my_queued(uuid);
drop function if exists public.staff_cancel_generations(uuid[], uuid, text, boolean);
drop function if exists public._cancel_generations(uuid[], uuid, text, boolean);
drop function if exists public.claim_fair_job(text[], text[], boolean, integer, integer);
drop function if exists public.queue_held(uuid, uuid);
drop table if exists public.queue_holds;
alter table public.jobs drop column if exists cancel_requested_at;

create or replace function public.credit_ledger_sync()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.kind = 'presentation'
     and (new.params->>'video_parts') is distinct from (old.params->>'video_parts') then
    update credit_ledger
       set units = greatest(coalesce((new.params->>'video_parts')::int, 1), 1)
     where generation_id = new.id and not voided;
  end if;
  if new.status = 'error' and new.status is distinct from old.status then
    update credit_ledger set voided = true, void_reason = 'worker_error'
     where generation_id = new.id;
  end if;
  if new.status = 'done' and new.status is distinct from old.status then
    update credit_ledger
       set voided = false,
           void_reason = null,
           units = case when new.kind = 'presentation' and new.params ? 'video_parts'
                        then greatest(coalesce((new.params->>'video_parts')::int, 1), 1)
                        else units end
     where generation_id = new.id
       and voided
       and void_reason is distinct from 'unconsumed_on_delete';
  end if;
  return null;
end $function$;
commit;
