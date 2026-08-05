-- 0074 — Finding a colleague's kit without seeing everything they own.
--
-- The offer in 0073 needs to know whether the school already has this chapter.
-- `gen_read` deliberately does not let a teacher read a colleague's
-- generations — only their own, ones shared with them, and the school admin's
-- school-wide arm — and widening it would expose every kit in the school,
-- including half-finished ones and mistakes.
--
-- So discovery gets its own narrow function: given a book and chapter THIS
-- teacher can already use, it returns the finished kits their school holds for
-- it. Nothing else about a colleague's library is reachable through it.
--
-- The rows come back raw (kind + params) and the caller decides which are
-- interchangeable — that judgement lives in utils/kit-match.ts, where it is
-- tested, rather than being written a second time in SQL and drifting.
create or replace function public.school_kits_for(p_book uuid, p_chapter text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  me uuid := auth.uid();
  my_school uuid;
  result jsonb;
begin
  if me is null then
    return '[]'::jsonb;
  end if;

  -- Staff only, and only their own school.
  select p.school_id into my_school from profiles p where p.id = me and p.role <> 'student';
  if my_school is null then
    return '[]'::jsonb;
  end if;

  -- The book must be one this teacher can genuinely reach, or the function
  -- becomes a way to probe books they were never shown.
  if not exists (
    select 1 from books b
    where b.id = p_book and b.removed_at is null
      and (b.owner_id = me or b.school_id = my_school)
  ) then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', g.id, 'kind', g.kind, 'params', g.params, 'created_at', g.created_at
         ) order by g.created_at), '[]'::jsonb)
    into result
  from generations g
  where g.book_id = p_book
    and g.chapter_ref is not distinct from p_chapter
    and g.school_id = my_school
    and g.owner_id <> me          -- their own kits are already in their Library
    and g.status = 'done'         -- a queued kit is not an offer
    and g.removed_at is null
    and g.withdrawn_at is null;   -- nothing from a retired book

  return result;
end;
$$;

revoke execute on function public.school_kits_for(uuid, text) from public, anon, authenticated;
grant execute on function public.school_kits_for(uuid, text) to authenticated;
