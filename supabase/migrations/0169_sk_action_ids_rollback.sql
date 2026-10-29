-- 0169 rollback: drop the SK action-id indexes and columns. Notes and
-- generations already written by SK stay (they are ordinary diary / library
-- rows); only the link back to the action token goes.
begin;
drop index if exists public.diary_notes_sk_action_target_uidx;
drop index if exists public.generations_sk_action_kind_part_uidx;
alter table public.diary_notes drop column if exists sk_action_id;
alter table public.generations drop column if exists sk_action_id;
commit;
