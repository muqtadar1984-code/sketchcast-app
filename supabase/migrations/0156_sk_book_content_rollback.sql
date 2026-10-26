-- 0156 rollback: drop the SK book-content tables and the item ↔ objective
-- column. Nothing else in the app reads them yet (SK is behind FEATURE_SK and
-- B3/B4 are not built), so this restores the schema exactly. Chapter exports
-- are reproducible from the manuscripts with tools/sk/export-chapter.ts.
begin;
alter table public.topic_questions drop column if exists teaching_objective_id;
drop table if exists public.sk_book_blocks;
drop table if exists public.objective_curriculum_map;
drop table if exists public.teaching_objectives;
drop table if exists public.sk_book_units;
drop table if exists public.sk_book_products;
commit;
