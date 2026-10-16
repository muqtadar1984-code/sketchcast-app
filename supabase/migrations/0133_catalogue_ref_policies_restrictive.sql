-- 0133: the two 0132 policies as RESTRICTIVE (they were created PERMISSIVE).
--
-- Found by the 0132 test's forge probe on production, minutes after 0132 was
-- applied: the insert carrying params.catalogue_ref went THROUGH. Postgres ORs
-- permissive policies and ANDs restrictive ones, so a permissive "refuse
-- catalogue_ref" policy refused nothing — the owner-insert policy admitted the
-- row. Worse, the permissive UPDATE policy with `using (true)` WIDENED update
-- rights for the minutes it stood (any authenticated user, any row, so long as
-- the row carried no catalogue_ref; the restrictive gen_no_catalogue_update and
-- gen_removed_frozen still applied). Nothing in that window wrote through it —
-- the window was under ten minutes, outside users' hours, and the app has no
-- code path that updates another owner's generation.
--
-- Same declaration as 0112's gen_no_catalogue_insert / gen_no_catalogue_update,
-- which are restrictive — the shape the 0132 comment claimed to copy.
--
-- Lesson for the next policy that REFUSES something: `as restrictive`, always,
-- and the test's forge probe is the thing that proves it (a permissive one
-- passes every other check).

drop policy if exists gen_no_catalogue_ref_insert on public.generations;
create policy gen_no_catalogue_ref_insert on public.generations
  as restrictive for insert to authenticated
  with check (not (coalesce(params, '{}'::jsonb) ? 'catalogue_ref'));

drop policy if exists gen_no_catalogue_ref_update on public.generations;
create policy gen_no_catalogue_ref_update on public.generations
  as restrictive for update to authenticated
  using (true)
  with check (not (coalesce(params, '{}'::jsonb) ? 'catalogue_ref'));
