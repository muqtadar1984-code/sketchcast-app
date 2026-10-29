-- 0171 rollback: drop the SK action-id index and column on school_events.
-- Notices SK already posted stay (they are ordinary notices); only the link
-- back to the action token goes.
begin;
drop index if exists public.school_events_sk_action_uidx;
alter table public.school_events drop column if exists sk_action_id;
commit;
