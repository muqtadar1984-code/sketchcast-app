-- 0175 rollback: SketchCast books stop being Library books.
--
-- Removes the buyers' read policy, the forged-ref refusals, adopt_product_kit,
-- has_book_grant, the product link columns and the on_book_created WHEN
-- clause (the trigger is recreated exactly as 0002 declared it).
--
-- NOT removed, on purpose:
--   * the system-owned product books themselves. Their master kits reference
--     them (generations.book_id is ON DELETE SET NULL, so deleting a book would
--     strand every master kit book-less). Without the columns they are
--     ordinary books of the catalogue system account, invisible to buyers.
--   * teachers' adopted copies (params.product_ref). They are the teachers'
--     own rows, may already be assigned, and keep working as book-less kits.
-- ⚠️ Run the rollback only when no further product book will be imported: the
-- importer skips the book (42703) once the columns are gone, but a product
-- book inserted while the WHEN clause is absent would queue an index_book job.
begin;

drop policy if exists books_sk_product_read on public.books;
drop policy if exists gen_no_product_ref_insert on public.generations;
drop policy if exists gen_no_product_ref_update on public.generations;

drop function if exists public.adopt_product_kit(uuid);
drop function if exists public.has_book_grant(uuid);

drop trigger if exists on_book_created on public.books;
create trigger on_book_created
  after insert on public.books
  for each row execute function public.create_index_job_for_book();

drop index if exists public.books_sk_product_uq;
alter table public.books drop column if exists sk_release_id;
alter table public.books drop column if exists sk_product_id;

commit;
