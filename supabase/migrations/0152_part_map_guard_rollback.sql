-- 0152 rollback: drop the part-map insert guard and the orphan sweep. A worker
-- that still calls sweep_orphaned_parts logs a warning and carries on.
begin;
drop trigger if exists generations_part_map_guard on public.generations;
drop function if exists public.enforce_part_map();
drop function if exists public.sweep_orphaned_parts(uuid);
drop function if exists public.chapter_part_count(uuid, text);
commit;
