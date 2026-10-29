-- 0170 rollback: drop the product -> kit map, kit-objective mastery and the
-- attempts' objective_key. The kits themselves (generations) are untouched;
-- attempts stay, only their objective_key goes. ⚠️ Deletes every derived
-- kit-objective mastery row (re-derivable from item_attempts while the column
-- exists — derive before rolling back if they matter).
begin;
drop table if exists public.sk_objective_mastery;
drop index if exists public.item_attempts_student_objective_key_idx;
alter table public.item_attempts drop column if exists objective_key;
drop table if exists public.sk_product_kits;
commit;
