-- 0158 rollback: remove the SK book-access objects. Nothing else referenced
-- them (additive migration), so the drops cascade only within this set.
begin;
drop function if exists public.redeem_book_code(text, uuid, uuid, integer);
drop function if exists public.sk_retention_sweep();
drop table if exists public.consents;
drop table if exists public.book_code_attempts;
drop table if exists public.sk_usage;
drop table if exists public.book_access_grants;
drop table if exists public.book_codes;
drop table if exists public.print_batches;
drop table if exists public.publishers;
commit;
