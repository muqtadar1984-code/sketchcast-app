-- 0071 — Name the book in the withdrawal notice.
--
-- A teacher whose kits vanish mid-term needs to be told which book was retired,
-- or the Library just develops unexplained gaps. But they CANNOT be told from
-- the book row: `books_not_removed` is a RESTRICTIVE SELECT policy
-- (removed_at IS NULL), so the moment a book is retired it becomes invisible to
-- everyone except through a definer function. Verified against production — a
-- school teacher selecting a just-retired book gets exactly 0 rows.
--
-- So the title is SNAPSHOT onto the kit at the moment it is withdrawn. That
-- also outlives the book row itself, which a takedown (0015) or a future hard
-- delete could remove entirely.

alter table public.generations add column if not exists withdrawn_book_title text;

-- Same function as 0070 with the snapshot added. Everything else is unchanged
-- and the header there still applies: THIS NEVER DELETES A GENERATION, because
-- deleting one cascades to submissions and student_progress and would erase a
-- term of marked work across the school.
create or replace function public.withdraw_school_book(p_book_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  sid uuid;
  btitle text;
  n_kits int := 0;
  owners uuid[] := '{}';
  n_shares int := 0;
begin
  select school_id, title into sid, btitle from books where id = p_book_id and removed_at is null;
  if sid is null or not leader_of_school(sid) then
    raise exception 'not authorised for this book';
  end if;

  select coalesce(array_agg(distinct owner_id), '{}') into owners
  from generations where book_id = p_book_id and withdrawn_at is null;

  -- 1. Unassign: the kit leaves every student's dashboard and every class.
  with doomed as (
    select id from generations where book_id = p_book_id and withdrawn_at is null
  ), gone as (
    delete from generation_shares where generation_id in (select id from doomed) returning 1
  )
  select count(*) into n_shares from gone;

  -- 2. Mark withdrawn, carrying the book's name with it so the owner can be
  --    told what happened once the book itself is unreadable.
  update generations
     set withdrawn_at = now(),
         withdrawn_by = auth.uid(),
         withdrawn_book_title = btitle
   where book_id = p_book_id and withdrawn_at is null;
  get diagnostics n_kits = row_count;

  -- 3. Retire the book. Soft (0015), so the row survives for audit.
  update books
     set removed_at = now(), removed_by = auth.uid()
   where id = p_book_id and removed_at is null;

  return jsonb_build_object(
    'kits', n_kits,
    'shares_removed', n_shares,
    'teachers', owners,
    'book', btitle
  );
end;
$$;

-- CREATE OR REPLACE keeps the existing ACL, but re-assert it so this file is
-- correct on a database built from scratch (0044 doctrine).
revoke execute on function public.withdraw_school_book(uuid) from public, anon, authenticated;
grant execute on function public.withdraw_school_book(uuid) to authenticated;
