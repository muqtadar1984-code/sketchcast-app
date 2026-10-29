-- 0174 rollback: remove SK S7 slice K1's knowledge blocks, import log, search
-- and writer functions, and the product → release link columns. The imported
-- passages are derived data (re-importable from releases, articles and
-- chapter_grounding); nothing they came from is touched.
begin;
drop function if exists public.sk_search_knowledge(text, text, jsonb, int, int);
drop function if exists public.sk_knowledge_prune();
drop function if exists public.sk_knowledge_versions(text);
drop function if exists public.sk_knowledge_replace(jsonb, jsonb);
drop table if exists public.sk_release_imports;
drop table if exists public.sk_knowledge_blocks;
drop index if exists public.sk_book_products_work_language_uq;
alter table public.sk_book_products drop column if exists cover_key;
alter table public.sk_book_products drop column if exists release_kind;
alter table public.sk_book_products drop column if exists edition_key;
alter table public.sk_book_products drop column if exists release_id;
alter table public.sk_book_products drop column if exists language;
alter table public.sk_book_products drop column if exists work_uid;
drop function if exists public.sk_ts_config(text);
commit;
