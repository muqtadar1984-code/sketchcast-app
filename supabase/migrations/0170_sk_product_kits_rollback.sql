-- 0170 rollback: drop the product -> kit map and the objective_key columns.
-- The kits themselves (generations) are untouched; attempts and mastery rows
-- stay, only their objective_key goes.
begin;
drop index if exists public.mastery_state_student_objective_key_idx;
drop index if exists public.item_attempts_student_objective_key_idx;
alter table public.mastery_state drop column if exists objective_key;
alter table public.item_attempts drop column if exists objective_key;
drop table if exists public.sk_product_kits;
commit;
