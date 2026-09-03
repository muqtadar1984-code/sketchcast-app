-- 0100 — Deleting a book takes its kits with it.
--
-- WHAT WAS WRONG. generations.book_id is ON DELETE SET NULL, so deleting a
-- book left every kit generated from it behind as an orphan: rows with no
-- book, files in storage nobody could reach from a shelf, and a Library
-- section ("Other lessons") whose only real job was to display them. The
-- founder found this on 2026-09-03 by clearing a shelf: 17 orphans appeared,
-- six of them failed kits whose mere presence took the dashboard down (see
-- src/app/dashboard/labels.ts). The decision that day: a book's kits belong
-- to the book. Delete the book and they go too — rows AND files.
--
-- WHY NOT JUST `ON DELETE CASCADE`. Two reasons, both about what a cascade
-- cannot see.
--   1. Files. A cascade drops artifacts ROWS; the objects in storage stay
--      behind forever. Only a caller holding the paths can remove them, so the
--      delete has to hand the paths back — which is a function, not a
--      constraint.
--   2. Student work. generations cascades to submissions and student_progress.
--      A silent cascade would let ANY path that deletes a book — console, SQL,
--      a future script — wipe students' submitted work without anyone having
--      said so. This function counts that work first and the client puts the
--      number in front of the teacher before asking. The constraint stays
--      SET NULL on purpose: nothing outside this function can take student
--      work down by accident.
--
-- THE SAME SHAPE AS delete_my_generation (0073). SECURITY DEFINER, authorised
-- on auth.uid() = owner, and it returns only the artifact paths that are
-- GENUINELY unreferenced afterwards — a colleague who adopted one of these
-- kits (0073) has a row of their own pointing at the same object, and that
-- object must survive. Everything the caller should remove from storage comes
-- back in one object: artifacts (the orphans), the cover, the upload, and the
-- files students submitted.
--
-- WHAT IT REFUSES, each with a fixed token the client translates:
--   'shared_kits'   — other teachers made kits from this book. That is a
--                     school-shelf book, and retiring it is leadership's act
--                     (withdraw_school_book, 0074), which withdraws their kits
--                     properly instead of destroying them. This check comes
--                     FIRST and is deliberately stricter than the
--                     guard_shared_book_removal trigger on books: that trigger
--                     counts other teachers' kits at the moment the BOOK row is
--                     deleted, and this function deletes the kits before the
--                     book — so without its own check it would have removed the
--                     very rows the trigger exists to count.
--   'book_indexing' — the book is still being indexed.
--   'kit_building'  — a kit is still being built.
-- The last two leave a worker mid-write against rows that would vanish under
-- it — the chapter_grounding FK storm of 2026-09-02 (about 40 errors in four
-- minutes) was exactly a book deleted during indexing.
--
-- CREDITS are the ledger's business, not this function's. Its per-row BEFORE
-- DELETE trigger (0078/0095) fires for every generation deleted here: a kit
-- that never ran is voided and the credit comes back; a kit that delivered
-- keeps its charge. Deleting a book changes none of that arithmetic.
--
-- Idempotent: CREATE OR REPLACE throughout; safe to re-run.

-- ── What deleting this book would take with it ───────────────────────────────
-- Read-only, for the confirm dialog. Same authorisation as the delete itself,
-- so a teacher can only ever measure their own book.
create or replace function public.my_book_impact(p_book uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  me uuid := auth.uid();
  b record;
begin
  if me is null then
    raise exception 'not signed in';
  end if;

  select id, owner_id, status into b from books where id = p_book and removed_at is null;
  if b.id is null or b.owner_id <> me then
    raise exception 'not your book';
  end if;

  return jsonb_build_object(
    'kits',        (select count(*) from generations g where g.book_id = p_book),
    'others',      (select count(*) from generations g
                     where g.book_id = p_book and g.owner_id <> me and g.withdrawn_at is null),
    'processing',  (select count(*) from generations g where g.book_id = p_book and g.status = 'processing'),
    'indexing',    (b.status = 'processing'),
    'submissions', (select count(*) from submissions s
                      join generations g on g.id = s.generation_id
                     where g.book_id = p_book),
    'students',    (select count(distinct x.student_id) from generation_shares x
                      join generations g on g.id = x.generation_id
                     where g.book_id = p_book and x.student_id is not null),
    'classes',     (select count(distinct x.class_id) from generation_shares x
                      join generations g on g.id = x.generation_id
                     where g.book_id = p_book and x.class_id is not null)
  );
end;
$$;

-- ── Delete the book, its kits, and hand back every file to remove ────────────
create or replace function public.delete_my_book(p_book uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  me uuid := auth.uid();
  b record;
  paths text[];
  orphans text[];
  submitted text[];
  n_kits int := 0;
  n_subs int := 0;
begin
  if me is null then
    raise exception 'not signed in';
  end if;

  select id, owner_id, status, storage_path, cover_path
    into b
    from books
   where id = p_book and removed_at is null;
  if b.id is null or b.owner_id <> me then
    raise exception 'not your book';
  end if;

  -- Other teachers' kits are not ours to delete. Checked before anything is
  -- touched — see the header on why this cannot be left to the books trigger.
  if exists (select 1 from generations g
              where g.book_id = p_book and g.owner_id <> me and g.withdrawn_at is null) then
    raise exception 'shared_kits';
  end if;

  -- Never pull rows out from under a running worker.
  if b.status = 'processing' then
    raise exception 'book_indexing';
  end if;
  if exists (select 1 from generations g where g.book_id = p_book and g.status = 'processing') then
    raise exception 'kit_building';
  end if;

  -- Everything in storage this book's rows point at, gathered BEFORE the
  -- rows go: artifact files (possibly shared with an adopted copy — resolved
  -- below) and the files students submitted (never shared; always ours).
  select coalesce(array_agg(distinct a.storage_path), '{}')
    into paths
    from artifacts a
    join generations g on g.id = a.generation_id
   where g.book_id = p_book and a.storage_path is not null;

  select coalesce(array_agg(s.file_path), '{}')
    into submitted
    from submissions s
    join generations g on g.id = s.generation_id
   where g.book_id = p_book and s.file_path is not null;
  n_subs := coalesce(array_length(submitted, 1), 0);

  -- Kits first (cascades: artifacts, jobs, shares, progress, submissions,
  -- views, tutor rows; SET NULL: platform_issues, present_items). Then the
  -- book. The ledger's BEFORE DELETE trigger runs per kit as it goes.
  delete from generations where book_id = p_book;
  get diagnostics n_kits = row_count;

  delete from books where id = p_book;

  -- Only the paths nobody references any more may leave storage.
  select coalesce(array_agg(p), '{}')
    into orphans
    from unnest(paths) as p
   where not exists (select 1 from artifacts a2 where a2.storage_path = p);

  return jsonb_build_object(
    'kits',             n_kits,
    'submissions',      n_subs,
    'artifacts',        to_jsonb(orphans),
    'submission_files', to_jsonb(submitted),
    'cover',            b.cover_path,
    'upload',           b.storage_path
  );
end;
$$;

-- Callable by any signed-in user; both functions authorise on ownership
-- internally, exactly like delete_my_generation. Nothing for anon.
revoke all on function public.my_book_impact(uuid) from public, anon;
revoke all on function public.delete_my_book(uuid) from public, anon;
grant execute on function public.my_book_impact(uuid) to authenticated;
grant execute on function public.delete_my_book(uuid) to authenticated;
