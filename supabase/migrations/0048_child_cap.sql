-- 0048 — Family plan shape: a parent links at most 2 children (default).
--
-- Product decision (2026-07-17): the family unit is sized for the target
-- student environment (grades 5–12), where two enrolled children covers the
-- large majority of households. The children default drops from unlimited to
-- 2 — same mechanism as every other cap: effective_cap() default, enforced by
-- the existing beta_child_cap trigger (0018), with the per-user
-- profiles.max_children console override for the exceptions (a 3-child family
-- is a support touch, not a plan).
--
-- Lowering a cap never deletes anything: parents already holding more links
-- keep them; only NEW links beyond 2 are blocked.
--
-- Idempotent (function replace). Requires 0018/0024.

create or replace function public.effective_cap(uid uuid, which text) returns int
  language sql stable security definer set search_path = public as
$$
  select coalesce(
    -- 1) explicit per-user override from the console
    (select case which when 'books'    then max_books
                       when 'chapters' then max_chapters
                       when 'students' then max_students
                       when 'children' then max_children end
     from profiles where id = uid),
    -- 2) plan defaults: 1 book (trial lifetime, see 0046/0047), 2 children;
    --    chapters/students stay open (fair-use metering covers volume, 0047).
    case which when 'books'    then 1
               when 'children' then 2
               else 2147483647 end)
$$;

-- Reword the child-cap message: it's the plan shape now, not a beta artifact.
create or replace function enforce_beta_child_cap() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare cap int;
begin
  cap := effective_cap(new.parent_id, 'children');
  if cap >= 2147483647 then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('beta_child:' || new.parent_id::text));
  if (select count(*) from parent_links
      where parent_id = new.parent_id and child_id <> new.child_id) >= cap then
    raise exception 'Your plan includes % linked children. Contact support if your family needs more.', cap;
  end if;
  return new;
end $$;
