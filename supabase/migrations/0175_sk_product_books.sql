-- 0175: SketchCast books as Library books (founder 2026-10-30: "why dont we
-- list down all the chapters the same way we do for the books uploaded by
-- users? for sketchcast books we wont have parts, we would rather have 1
-- chapter and 1 kit of artifacts per chapter.").
--
-- A bought SketchCast book becomes ONE system-owned `books` row per product
-- (owned by the catalogue system account, CATALOGUE_OWNER_ID), written by the
-- release importer (src/sk/knowledge/release.ts) from the product's live FINAL
-- release: its chapters in the uploaded-book shape ([{num (0-based), title}])
-- and one chapter_grounding row per chapter (section text + exercise STEMS,
-- never answers). Its master kits are ordinary generations of that book, owned
-- by the same system account, queued by the founder-only
-- scripts/sk-product-kits.ts. A buyer reads the BOOK through RLS; the kits are
-- read and signed by the server after the same grant check (the catalogue's
-- pattern: /api/catalogue/file — no generations policy, see §4); a buyer who
-- wants to ASSIGN or put a chapter on the Board gets their own copy through
-- adopt_product_kit() (the 0132 pattern: no job, no credit, same files).
--
-- What it adds:
--   books.sk_product_id / sk_release_id   which product the system book IS, and
--                                         the release its chapters came from
--   on_book_created WHEN clause           a product book never queues an
--                                         index_book job (it has no PDF)
--   has_book_grant(product)               skAccess's book rule, in SQL
--   books_sk_product_read                 buyers SELECT their product books
--   adopt_product_kit(source)             the caller's own copy of one master
--                                         piece (book_id/chapter_ref null)
--   gen_no_product_ref_insert / _update   clients cannot forge params.product_ref
--
-- ACCESS RULE (src/sk/access.ts skAccess, founder 2026-10-30 "books are
-- bought"): book access comes ONLY from a live book_access_grants row — not
-- revoked, activated_at <= now, expires_at null or in the future. A school
-- licence or SK subscription opens tutoring, never a book; has_book_grant is
-- exactly that rule and nothing else.
--
-- NOT CHANGED: books_read (owner / same school), books_write (owner only), the
-- generations policies, storage policies, chapter_grounding (service role
-- only — nothing client-side reads it), and every uploaded book.
--
-- Run as ONE execution. Idempotent. Rollback = 0175_sk_product_books_rollback.sql.
begin;

-- ── 1. the product link on books ────────────────────────────────────────────
alter table public.books add column if not exists sk_product_id uuid
  references public.sk_book_products(id) on delete restrict;
alter table public.books add column if not exists sk_release_id bigint;   -- pub_releases.id (no FK: 0172 is the book app's)
create unique index if not exists books_sk_product_uq
  on public.books (sk_product_id) where sk_product_id is not null;

comment on column public.books.sk_product_id is
  'Set only on the SYSTEM-owned book that IS a SketchCast book product (owner = the catalogue system account). Written by the release importer; buyers read it through books_sk_product_read. Null for every uploaded book.';
comment on column public.books.sk_release_id is
  'The pub_releases.id (a FINAL) whose chapters this product book carries. A newer final updates the row in place.';

-- ── 2. a product book never queues indexing ─────────────────────────────────
-- on_book_created (0001/0002) inserts an index_book job for EVERY book insert.
-- A product book has no uploaded PDF — its chapters come from the release —
-- so indexing would fail and, worse, re-detect chapters over the importer's
-- map. Recreated with a WHEN clause rather than by editing the function, so
-- whatever the live function body is, it is left exactly as it is. The DO
-- block refuses to guess if the live trigger is not the one the repo names.
do $trg$
declare
  n int;
begin
  select count(*) into n
    from pg_trigger t
   where t.tgrelid = 'public.books'::regclass
     and not t.tgisinternal
     and t.tgfoid = 'public.create_index_job_for_book'::regproc;
  if n = 0 then
    raise exception '0175: no trigger on public.books calls create_index_job_for_book; re-check before applying';
  end if;
  if exists (select 1 from pg_trigger t
              where t.tgrelid = 'public.books'::regclass and not t.tgisinternal
                and t.tgfoid = 'public.create_index_job_for_book'::regproc
                and t.tgname <> 'on_book_created') then
    raise exception '0175: create_index_job_for_book is fired by a trigger other than on_book_created; re-check before applying';
  end if;
end
$trg$;

drop trigger if exists on_book_created on public.books;
create trigger on_book_created
  after insert on public.books
  for each row
  when (new.sk_product_id is null)
  execute function public.create_index_job_for_book();

-- ── 3. the grant rule ───────────────────────────────────────────────────────
create or replace function public.has_book_grant(p_product uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and p_product is not null
     and exists (
       select 1 from book_access_grants g
        where g.user_id = auth.uid()
          and g.product_id = p_product
          and g.revoked_at is null
          and g.activated_at <= now()
          and (g.expires_at is null or g.expires_at > now()))
$$;

comment on function public.has_book_grant(uuid) is
  'Does the CALLER hold a live book grant for this product? Exactly skAccess''s book rule (src/sk/access.ts): not revoked, activated_at <= now, expires_at null or later. Licences and subscriptions never open a book.';

-- ── 4. buyers read their product books ──────────────────────────────────────
-- An ADDITIONAL permissive SELECT policy: Postgres ORs it with books_read, and
-- the restrictive books_not_removed (0015) still applies. No write policy is
-- added — books_write stays owner-only, so a buyer can never edit the book.
--
-- Master kits are NOT made readable by a generations policy. A permissive
-- policy there would also surface them in every query that relies on RLS
-- alone (the student dashboard lists "whatever generations I can read"), and
-- the master files sit under the system account's storage prefix that no
-- session may sign anyway. The catalogue's answer is the one used here: the
-- server reads and signs master files with the service role AFTER the grant
-- check (src/utils/my-books/product-book.ts), and a buyer who needs a row of
-- their own (Assign, the Board) adopts one (§5).
drop policy if exists books_sk_product_read on public.books;
create policy books_sk_product_read on public.books
  for select to authenticated
  using (sk_product_id is not null and removed_at is null and public.has_book_grant(sk_product_id));

-- ── 5. adopt_product_kit — the caller's own copy of one master piece ───────
create or replace function public.adopt_product_kit(p_source uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  me        uuid := auth.uid();
  src       record;
  bk        record;
  v_release bigint;
  my_school uuid;
  existing  uuid;
  new_id    uuid;
  ch_title  text;
  ch_label  text;
  prefix    text;
  suffix    text;
begin
  if me is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from profiles p where p.id = me and (p.role = 'student' or p.suspended_at is not null)) then
    raise exception 'this account cannot copy kits' using errcode = 'insufficient_privilege';
  end if;

  select g.* into src
  from generations g
  where g.id = p_source and g.status = 'done' and g.removed_at is null and g.withdrawn_at is null;
  if src.id is null then
    raise exception 'that kit is not available' using errcode = 'no_data_found';
  end if;

  -- The source must be a MASTER: a generation of a product book, owned by the
  -- book's own (system) owner. A buyer's own row pointing at the product book
  -- is not a master and is refused.
  select b.id, b.title, b.owner_id, b.sk_product_id, b.chapters into bk
  from books b
  where b.id = src.book_id and b.sk_product_id is not null and b.removed_at is null;
  if bk.id is null or src.owner_id is distinct from bk.owner_id then
    raise exception 'that kit is not part of a SketchCast book' using errcode = 'no_data_found';
  end if;

  if not has_book_grant(bk.sk_product_id) then
    raise exception 'this book is not in your library' using errcode = 'insufficient_privilege';
  end if;

  -- Idempotent: one copy per (owner, source piece).
  select g.id into existing
  from generations g
  where g.owner_id = me
    and g.removed_at is null
    and g.params -> 'product_ref' ->> 'source' = p_source::text
  limit 1;
  if existing is not null then
    return existing;
  end if;

  select p.release_id into v_release from sk_book_products p where p.id = bk.sk_product_id;
  select p.school_id into my_school from profiles p where p.id = me;

  -- "<book> — Chapter N: <chapter title> · <piece>". The part before the first
  -- " · " is the kit's name everywhere ready-made kits are grouped (the
  -- Board's kitPrefix, the Library's titleStem), so every piece of one
  -- chapter shares it; " · " is kept out of the prefix itself.
  select nullif(btrim(c ->> 'title'), '') into ch_title
  from jsonb_array_elements(case when jsonb_typeof(bk.chapters) = 'array' then bk.chapters else '[]'::jsonb end) c
  where c ->> 'num' = src.chapter_ref
  limit 1;
  ch_label := case when src.chapter_ref ~ '^[0-9]{1,6}$' then (src.chapter_ref::int + 1)::text else coalesce(src.chapter_ref, '?') end;
  prefix := replace(btrim(bk.title) || ' — Chapter ' || ch_label || coalesce(': ' || ch_title, ''), ' · ', ' - ');
  suffix := case when strpos(coalesce(src.title, ''), ' · ') > 0
                 then nullif(btrim(substr(src.title, strpos(src.title, ' · ') + 3)), '') end;

  -- 0129: this insert is a COPY — no job, no metering.
  perform set_config('sketchcast.generation_copy', 'on', true);

  insert into generations (kind, book_id, chapter_ref, title, owner_id, school_id, status, params)
  values (src.kind, null, null,
          prefix || ' · ' || coalesce(suffix, src.kind::text),
          me, my_school, 'done',
          jsonb_build_object('product_ref', jsonb_build_object(
            'product_id', bk.sk_product_id,
            'release_id', v_release,
            'book_id', bk.id,
            'chapter_ref', src.chapter_ref,
            'source', p_source,
            'adopted_at', now())))
  returning id into new_id;

  insert into artifacts (generation_id, kind, storage_path)
  select new_id, a.kind, a.storage_path
  from artifacts a
  where a.generation_id = p_source;

  perform set_config('sketchcast.generation_copy', '', true);

  return new_id;
end
$$;

comment on function public.adopt_product_kit(uuid) is
  'The caller''s own library copy of one MASTER piece of a SketchCast book (a generation of a books row with sk_product_id, owned by that book''s owner): same storage paths, status done, book_id and chapter_ref null (so Assign and the Board accept it), params.product_ref lineage {product_id, release_id, book_id, chapter_ref, source, adopted_at}. Requires a live book grant (has_book_grant). Idempotent per (owner, source). Never queues a job or spends a credit (0129 copy flag).';

-- ── 6. only adopt_product_kit may write params.product_ref ─────────────────
-- RESTRICTIVE, always (0133's lesson: a permissive "refuse" policy refuses
-- nothing). Same declaration as gen_no_catalogue_ref_insert / _update.
drop policy if exists gen_no_product_ref_insert on public.generations;
create policy gen_no_product_ref_insert on public.generations
  as restrictive for insert to authenticated
  with check (not (coalesce(params, '{}'::jsonb) ? 'product_ref'));

drop policy if exists gen_no_product_ref_update on public.generations;
create policy gen_no_product_ref_update on public.generations
  as restrictive for update to authenticated
  using (true)
  with check (not (coalesce(params, '{}'::jsonb) ? 'product_ref'));

-- ── 7. grants ───────────────────────────────────────────────────────────────
revoke all on function public.has_book_grant(uuid)    from public, anon;
revoke all on function public.adopt_product_kit(uuid) from public, anon;
grant execute on function public.has_book_grant(uuid)    to authenticated, service_role;
grant execute on function public.adopt_product_kit(uuid) to authenticated;

commit;
