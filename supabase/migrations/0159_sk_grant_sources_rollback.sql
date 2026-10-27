-- 0159 rollback: remove the purchase / edition-code objects and put
-- book_access_grants back to its 0158 shape.
--
-- ⚠️ Rows that only 0159 could have created ('purchase' / 'edition_code'
-- grants) are DELETED, and the back-fill is reversed by copying
-- tutor_expires_at back into expires_at — a grant that has neither (none are
-- written that way) is given a 30-day expiry so the NOT NULL can be restored.
begin;
drop function if exists public.refund_book_purchase(text, uuid, text);
drop function if exists public.claim_book_purchases(uuid, text, integer, jsonb);
drop function if exists public.record_book_purchase(text, uuid, uuid, text, integer, text, text, boolean, integer, jsonb);
drop function if exists public.redeem_edition_code(text, text, uuid, uuid, integer, text);

drop table if exists public.book_purchases;
drop table if exists public.order_claims;
alter table public.book_access_grants drop constraint if exists book_access_grants_edition_code_id_fkey;
drop table if exists public.edition_codes;
alter table public.sk_book_products drop column if exists ls_product_id;

delete from public.book_access_grants where source in ('purchase', 'edition_code');
alter table public.book_access_grants drop constraint if exists book_access_grants_source_check;
alter table public.book_access_grants add constraint book_access_grants_source_check
  check (source in ('code', 'promo', 'staff', 'renewal'));
update public.book_access_grants
   set expires_at = coalesce(expires_at, tutor_expires_at, activated_at + interval '30 days');
alter table public.book_access_grants alter column expires_at set not null;
alter table public.book_access_grants drop column if exists edition_code_id;
alter table public.book_access_grants drop column if exists tutor_expires_at;

alter table public.book_code_attempts drop constraint if exists book_code_attempts_outcome_check;
delete from public.book_code_attempts where outcome in ('order_used', 'daily_cap');
alter table public.book_code_attempts add constraint book_code_attempts_outcome_check
  check (outcome in ('redeemed', 'invalid', 'used', 'revoked', 'rate_limited', 'not_your_child'));
commit;
