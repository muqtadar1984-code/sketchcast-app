-- 0073 — Reusing a colleague's kit.
--
-- Book dedup (0070) saves an indexing run. This saves the whole generation,
-- which is far larger: a full kit is six artifacts and roughly 56 minutes of
-- worker time, and five teachers of one form generating the same chapter pays
-- that five times for near-identical output. The shared shelf is what made the
-- duplication possible in the first place — before it, two teachers could not
-- reach the same book — so this is the other half of that change.
--
-- THE MODEL (founder, 2026-08-05): the teacher gets a COPY OF THEIR OWN.
-- A new generations row they own outright, pointing at the SAME artifact files.
-- That choice settles three questions at once:
--   · they can assign it — `shares_owner_class_all` already requires ownership,
--     so no share policy has to be widened;
--   · they can regenerate or delete it without touching the original;
--   · when the original's owner regenerates, this copy simply keeps the files
--     it has. No forking logic, no blocking rules, no cross-teacher surprises.
--
-- What it does NOT do is copy the files. That is the point — the bytes are
-- identical and the worker never runs. It does mean two rows can reference one
-- storage object, which the delete path did not previously allow for; see
-- delete_my_generation below.

-- ── Take a copy of a school kit ───────────────────────────────────────────────
-- SECURITY DEFINER because `gen_read` does not let a teacher see a colleague's
-- generation at all (only its owner, someone it was shared with, or the school
-- admin). Rather than widening that policy — which would expose every kit in
-- the school to every teacher, including drafts and mistakes — the ONE
-- permitted act gets one function, and the function decides what may be read
-- and what may be created.
create or replace function public.adopt_school_kit(p_source uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  src record;
  me uuid := auth.uid();
  my_school uuid;
  new_id uuid;
begin
  if me is null then
    raise exception 'not signed in';
  end if;

  select p.school_id into my_school from profiles p where p.id = me and p.role <> 'student';
  if my_school is null then
    raise exception 'not a school member';
  end if;

  select g.* into src
  from generations g
  where g.id = p_source
    and g.school_id = my_school     -- same school ONLY; never across tenants
    and g.removed_at is null
    and g.withdrawn_at is null      -- a kit from a retired book is not on offer
    and g.status = 'done';          -- half-built work helps nobody
  if src.id is null then
    raise exception 'that kit is not available';
  end if;

  -- Already taken a copy? Hand back the existing one rather than accumulating
  -- duplicates every time the button is pressed.
  select g.id into new_id
  from generations g
  where g.owner_id = me
    and g.book_id is not distinct from src.book_id
    and g.chapter_ref is not distinct from src.chapter_ref
    and g.kind = src.kind
    and g.params is not distinct from src.params
    and g.removed_at is null
    and g.withdrawn_at is null
  limit 1;
  if new_id is not null then
    return new_id;
  end if;

  insert into generations (kind, book_id, chapter_ref, title, owner_id, school_id, status, params)
  values (src.kind, src.book_id, src.chapter_ref, src.title, me, src.school_id, 'done', src.params)
  returning id into new_id;

  -- Same files. Nothing is copied in storage: the bytes are identical and the
  -- whole saving is not producing them a second time.
  insert into artifacts (generation_id, kind, storage_path)
  select new_id, a.kind, a.storage_path
  from artifacts a
  where a.generation_id = src.id;

  return new_id;
end;
$$;

-- ── Deleting a kit without breaking someone else's ────────────────────────────
-- delete-lesson.tsx removed every artifact path from storage and then deleted
-- the row. That was safe while one row owned its files. It is not safe now: a
-- colleague's copy can reference the same object, and removing it would leave
-- their kit pointing at nothing.
--
-- So deletion moves into the database, which is the only place that can see
-- whether anyone else still needs the file. It returns the paths that are now
-- genuinely unreferenced, and the caller removes exactly those.
create or replace function public.delete_my_generation(p_gen uuid)
returns text[]
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  me uuid := auth.uid();
  mine boolean;
  paths text[];
  orphans text[];
begin
  if me is null then
    raise exception 'not signed in';
  end if;

  select (g.owner_id = me) into mine from generations g where g.id = p_gen and g.removed_at is null;
  if mine is not true then
    raise exception 'not your kit';
  end if;

  select coalesce(array_agg(distinct a.storage_path), '{}')
    into paths
  from artifacts a where a.generation_id = p_gen and a.storage_path is not null;

  delete from generations where id = p_gen; -- artifacts cascade

  -- Whatever no surviving artifact row still points at is now safe to remove.
  select coalesce(array_agg(p), '{}') into orphans
  from unnest(paths) as p
  where not exists (select 1 from artifacts a2 where a2.storage_path = p);

  return orphans;
end;
$$;

-- ── EXECUTE lockdown (0044 doctrine) ──────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array['adopt_school_kit(uuid)', 'delete_my_generation(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
