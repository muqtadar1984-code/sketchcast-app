-- 0072 — A shared book is not one teacher's to destroy.
--
-- 0070/0071 built a careful leadership retirement: preview the cost, type the
-- title, unassign the kits, snapshot the book's name so the teachers who lose
-- work are told why. None of that guards the path that already existed.
--
-- `books_write` is `for all using (owner_id = auth.uid())` (0001) and
-- `books_removed_nodelete` only blocks deleting a book that is ALREADY retired
-- (0015), so the uploader can still hard-delete their own book — from the ✕ in
-- their Library or straight through PostgREST. That was harmless while a book
-- was one teacher's own. The shared shelf changed the blast radius: the same
-- click now destroys the source PDF for the whole school, orphans colleagues'
-- kits (generations.book_id is ON DELETE SET NULL, so they survive but lose
-- their book), leaves those kits ASSIGNED to students, and fires no withdrawal
-- notice — because withdrawn_at is never set.
--
-- So: while other people's kits depend on a book that sits on the school shelf,
-- its uploader can no longer remove it unilaterally. They are told to ask
-- leadership, whose path does the job properly. A book nobody else has built on
-- stays entirely theirs, and a personal book (school_id null) is untouched by
-- any of this.

create or replace function public.guard_shared_book_removal()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  others int;
begin
  -- Not on the school shelf: still the uploader's own business.
  if old.school_id is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- Server-side work (service role, seeds, console tooling) has no auth.uid()
  -- and is trusted; it must not be blocked by a rule written for the UI.
  if auth.uid() is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- Leadership's own path. withdraw_school_book() is SECURITY DEFINER and runs
  -- as the caller for auth.uid() purposes, so this is what lets it through.
  if leader_of_school(old.school_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- On UPDATE only the transition INTO retired matters; ordinary edits (a
  -- re-index writing chapters, a health score, a cover) must stay free.
  if tg_op = 'UPDATE' and (new.removed_at is null or old.removed_at is not null) then
    return new;
  end if;

  select count(*) into others
  from generations g
  where g.book_id = old.id
    and g.owner_id <> auth.uid()
    and g.withdrawn_at is null;

  if others > 0 then
    raise exception
      'This book is on your school''s shelf and % lesson kit(s) by other teachers were made from it. Ask a coordinator or the principal to retire it, so their work is withdrawn properly instead of broken.',
      others;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists books_guard_shared_removal on public.books;
create trigger books_guard_shared_removal
  before delete or update on public.books
  for each row execute function public.guard_shared_book_removal();

-- EXECUTE lockdown (0044 doctrine). A trigger function is invoked by the
-- executor, never by a client, so no session role needs EXECUTE at all.
revoke execute on function public.guard_shared_book_removal() from public, anon, authenticated;
