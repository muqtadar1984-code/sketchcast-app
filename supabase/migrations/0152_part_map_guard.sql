-- 0152_part_map_guard — never queue a chapter part the book does not have
-- (2026-10-22)
--
-- Live incident, Sara Junaidi's "Sci 7" (book c3654e41, 2026-10-22 06:48 UTC):
-- a re-index started at 06:48:24; 32 s later she pressed Generate all. The
-- button counts parts from the page it rendered (dashboard/page.tsx:
-- partCount = chapters[].parts.length), so it queued parts 1–4 of
-- "Properties of materials" and 1–8 of "Forces and energy". The re-index then
-- wrote 3 and 6. Every part-4 / part-7 / part-8 job failed with "part 4 does
-- not exist", and her Retry clicks queued more of the same. 7 generations
-- failed and 17 more were hand-cancelled (credits voided).
--
-- The map can shrink under a queued job two ways: a re-index (index_book
-- rewrites books.chapters wholesale) and a generation measuring a scanned
-- chapter's real OCR (worker set_chapter_parts). Neither the browser nor the
-- worker can close this alone, so:
--
--   1. generations_part_map_guard — BEFORE INSERT on generations. One choke
--      point for every queuing path (Generate all, the per-part kit button,
--      Retry, all of which insert from the browser):
--        a. a USER insert while an index_book job for the book is queued or
--           running (touched in the last 30 min, so a dead job cannot lock a
--           book forever) is refused — the map is about to change;
--        b. params.part above the chapter's stored part count is refused for
--           every writer — a part that does not exist can only fail.
--      Generate all already stops on an insert error and shows the message.
--   2. sweep_orphaned_parts(book) — called by the worker after it writes a
--      book's part map. Deletes the book's QUEUED, never-started generations
--      whose part is now out of range; credit_ledger_void_unconsumed refunds
--      them exactly as the teacher's own ✕ would. Jobs are locked first
--      (skip locked), so a job the worker is claiming is left alone.
--
-- Exempt from the guard: catalogue rows (book_id NULL), finished copies
-- (status 'done', 0129), rows with no part, chapters with no stored part map
-- (old books — the app queues part NULL for those), and non-numeric refs.
--
-- A worker running before this is applied logs one warning per index and
-- sweeps nothing (sweep is best-effort). Rollback: 0152_part_map_guard_rollback.sql.

create or replace function public.chapter_part_count(p_book uuid, p_chapter_ref text)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $$
  -- NULL = no map to check against (unknown chapter, or no parts stored).
  select nullif(jsonb_array_length(coalesce(c->'parts', '[]'::jsonb)), 0)
  from books b, jsonb_array_elements(b.chapters) c
  where b.id = p_book
    and jsonb_typeof(b.chapters) = 'array'
    and c->>'num' = p_chapter_ref
  limit 1
$$;

create or replace function public.enforce_part_map()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_part  int;
  v_total int;
begin
  if new.book_id is null or new.status = 'done' then
    return new;
  end if;

  -- (a) the book is being re-read: its part map is about to be replaced.
  if auth.uid() is not null and exists (
    select 1 from jobs j
    where j.book_id = new.book_id
      and j.type = 'index_book'
      and j.status in ('queued', 'processing')
      and j.updated_at > now() - interval '30 minutes'
  ) then
    raise exception 'This book is being re-read right now — try again in a few minutes, once its chapters reappear.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if coalesce(new.params->>'part', '') !~ '^[0-9]{1,9}$'
     or coalesce(new.chapter_ref, '') !~ '^[0-9]{1,9}$' then
    return new;
  end if;
  v_part := (new.params->>'part')::int;
  v_total := public.chapter_part_count(new.book_id, new.chapter_ref);

  -- (b) a part the chapter does not have.
  if v_total is not null and (v_part < 1 or v_part > v_total) then
    raise exception 'Part % no longer exists — this chapter now has % part(s). Refresh the page to see its current parts.',
      v_part, v_total
      using errcode = 'invalid_parameter_value';
  end if;

  return new;
end;
$$;

drop trigger if exists generations_part_map_guard on public.generations;
create trigger generations_part_map_guard
  before insert on public.generations
  for each row execute function public.enforce_part_map();

-- Service-role only: the worker calls it after writing a part map.
create or replace function public.sweep_orphaned_parts(p_book uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_ids uuid[];
begin
  -- Lock the jobs before touching their generations: a job the worker is
  -- claiming right now is skipped, never deleted from under it.
  select array_agg(j.generation_id) into v_ids
  from (
    select j.generation_id
    from jobs j
    join generations g on g.id = j.generation_id
    where g.book_id = p_book
      and g.status = 'queued'
      and j.status = 'queued'
      and j.progress = 0
      and g.params->>'part' ~ '^[0-9]{1,9}$'
      and g.chapter_ref ~ '^[0-9]{1,9}$'
      and (g.params->>'part')::int > public.chapter_part_count(p_book, g.chapter_ref)
    for update of j skip locked
  ) j;

  if v_ids is null then
    return 0;
  end if;

  insert into platform_audit_log (action, target_kind, target_id, detail)
  select 'part_map:orphan_swept', 'generation', g.id,
         jsonb_build_object('book_id', g.book_id, 'owner_id', g.owner_id, 'kind', g.kind,
                            'chapter_ref', g.chapter_ref, 'part', g.params->>'part',
                            'parts_now', public.chapter_part_count(p_book, g.chapter_ref))
  from generations g where g.id = any(v_ids);

  -- credit_ledger_void_unconsumed (BEFORE DELETE) refunds each one; the job
  -- goes with it (jobs.generation_id ON DELETE CASCADE).
  delete from generations where id = any(v_ids);
  return cardinality(v_ids);
end;
$$;

revoke all on function public.sweep_orphaned_parts(uuid) from public, anon, authenticated;
revoke all on function public.chapter_part_count(uuid, text) from public, anon, authenticated;
