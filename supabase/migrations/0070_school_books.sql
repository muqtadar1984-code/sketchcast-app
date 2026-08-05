-- 0070 — The school book shelf.
--
-- A school uploads its textbooks once and every teacher works from them: nobody
-- re-uploads the same book, and we stop paying to index it N times. Most of
-- this already existed and was never used — `books.school_id` has been on the
-- table since 0001 and `books_read` has always been
--   (owner_id = auth.uid()) OR (school_id = current_school_id())
-- so school-wide READ needs no change here. What was missing is (a) a way to
-- spot a duplicate before paying to index it, (b) a way for leadership to
-- retire a book they do not own, and (c) somewhere to record that a kit was
-- retired with it.
--
-- THE ONE RULE THIS MIGRATION EXISTS TO ENFORCE: retiring a book WITHDRAWS the
-- teaching material and NEVER destroys the student record. Deleting a
-- generation cascades to submissions and student_progress — a principal
-- tidying the shelf would erase a term of marked work across the whole school.
-- So nothing here deletes a generation. It marks them withdrawn and unassigns
-- them; scores, completions and every analytic built on them survive intact.

-- ── Duplicate detection ───────────────────────────────────────────────────────
-- The shelf alone does not save the indexing bill: a teacher holding a PDF will
-- upload it unless something says "your school already has this". The hash
-- catches the publisher soft copy circulated among staff; title/author/pages
-- (matched in the app) catches two teachers SCANNING the same book, where the
-- bytes never match and the indexing cost is real. Advisory only — editions
-- differ, and a false "you already have this" is worse than a duplicate row.
alter table public.books add column if not exists content_hash text;

-- Lookup is always "does THIS school already hold this file", never global:
-- School A's licensed copy must never be offered to School B.
create index if not exists books_school_hash_idx
  on public.books (school_id, content_hash)
  where school_id is not null and content_hash is not null and removed_at is null;

-- ── Withdrawal ────────────────────────────────────────────────────────────────
-- Set when the book a kit came from is retired. The generation ROW deliberately
-- survives: past scores on the diary and My Children render the kit's title, so
-- deleting it would blank a parent's history of what their child actually did.
alter table public.generations add column if not exists withdrawn_at timestamptz;
alter table public.generations add column if not exists withdrawn_by uuid references public.profiles(id);

create index if not exists generations_withdrawn_idx
  on public.generations (owner_id, withdrawn_at)
  where withdrawn_at is not null;

-- The bell's THIRD feed needs its own watermark, for the same reason notices
-- needed one in 0068: folding another column into an existing select would, on
-- a database where this migration has not run, fail that select and mark every
-- unrelated notification unread.
alter table public.profiles add column if not exists books_seen_at timestamptz;
grant update (books_seen_at) on public.profiles to authenticated;

-- ── What a removal would cost, before it happens ──────────────────────────────
-- Feeds the confirmation dialog. Read-only, so leadership can look without
-- committing; the same authorisation as the act itself, so it cannot be used to
-- probe another school's shelf.
create or replace function public.school_book_impact(p_book_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  sid uuid;
  result jsonb;
begin
  select school_id into sid from books where id = p_book_id;
  if sid is null or not leader_of_school(sid) then
    raise exception 'not authorised for this book';
  end if;

  select jsonb_build_object(
    'kits',     count(distinct g.id),
    'teachers', count(distinct g.owner_id),
    'students', (
      select count(distinct s.student_id)
      from generation_shares s
      where s.generation_id in (select id from generations where book_id = p_book_id and withdrawn_at is null)
        and s.student_id is not null
    ),
    'classes', (
      select count(distinct s.class_id)
      from generation_shares s
      where s.generation_id in (select id from generations where book_id = p_book_id and withdrawn_at is null)
        and s.class_id is not null
    ),
    'teacher_names', coalesce(
      (select jsonb_agg(x.name order by x.kits desc)
       from (
         select coalesce(p.full_name, p.username, 'Teacher') as name, count(*) as kits
         from generations g2
         join profiles p on p.id = g2.owner_id
         where g2.book_id = p_book_id and g2.withdrawn_at is null
         group by 1
         limit 10
       ) x), '[]'::jsonb)
  )
  into result
  from generations g
  where g.book_id = p_book_id and g.withdrawn_at is null;

  return result;
end;
$$;

-- ── Retire a book from the school shelf ───────────────────────────────────────
-- SECURITY DEFINER on purpose: `books_write` is (owner_id = auth.uid()), so a
-- principal genuinely cannot touch a book a teacher uploaded. Rather than widen
-- that policy — which would also hand leadership arbitrary UPDATE over other
-- people's books — the ONE permitted act gets one function, and the function
-- decides what it may change.
--
-- Returns the affected owner ids so the caller can tell those teachers why
-- their kits vanished; a teacher opening the Library to unexplained gaps
-- mid-term is its own support ticket.
create or replace function public.withdraw_school_book(p_book_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  sid uuid;
  n_kits int := 0;
  owners uuid[] := '{}';
  n_shares int := 0;
begin
  select school_id into sid from books where id = p_book_id and removed_at is null;
  if sid is null or not leader_of_school(sid) then
    raise exception 'not authorised for this book';
  end if;

  -- Who loses what, captured before the update so the caller can notify them.
  select coalesce(array_agg(distinct owner_id), '{}') into owners
  from generations where book_id = p_book_id and withdrawn_at is null;

  -- 1. Unassign. This is what actually stops the material being taught: the
  --    kit leaves every student's dashboard and every class it was shared to.
  with doomed as (
    select id from generations where book_id = p_book_id and withdrawn_at is null
  ), gone as (
    delete from generation_shares where generation_id in (select id from doomed) returning 1
  )
  select count(*) into n_shares from gone;

  -- 2. Mark the kits withdrawn. NOT deleted — see the header. submissions and
  --    student_progress are untouched by design and keep pointing at these rows.
  update generations
     set withdrawn_at = now(), withdrawn_by = auth.uid()
   where book_id = p_book_id and withdrawn_at is null;
  get diagnostics n_kits = row_count;

  -- 3. Retire the book itself. Soft — 0015's removed_at, so the row stays for
  --    audit and the storage object is not orphaned mid-flight.
  update books
     set removed_at = now(), removed_by = auth.uid()
   where id = p_book_id and removed_at is null;

  return jsonb_build_object(
    'kits', n_kits,
    'shares_removed', n_shares,
    'teachers', owners
  );
end;
$$;

-- ── EXECUTE lockdown (0044 doctrine) ──────────────────────────────────────────
-- Postgres grants EXECUTE on every new function to PUBLIC implicitly and anon
-- INHERITS it, so without this both functions would be callable through
-- PostgREST by anyone holding the public anon key. withdraw_school_book is
-- SECURITY DEFINER and mutating — it authorises internally, but an unauthorised
-- caller should not even reach that check. service_role is not re-granted: it
-- bypasses RLS and never needs these.
do $$
declare f text;
begin
  foreach f in array array[
    'school_book_impact(uuid)',
    'withdraw_school_book(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
