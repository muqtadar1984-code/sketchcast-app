-- 0157 rollback: drop the SK session / assessment tables. The B4 loop falls
-- back to its in-memory SessionStore (SK_STORE unset), so nothing else in the
-- app reads them; this restores the schema exactly. Sessions and attempts
-- recorded in between are lost (they are student activity, not content).
begin;
drop table if exists public.mastery_state;
drop table if exists public.item_attempts;
drop table if exists public.sk_events;
drop table if exists public.sk_sessions;
commit;
