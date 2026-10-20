-- SketchCast AI — verification for 0148 (YouTube status columns)
-- ============================================================================
-- Run AFTER applying 0148. Proves:
--   1. the three columns exist with their types and are nullable;
--   2. every existing publication still reads, with the new columns null;
--   3. the worker's writes land (a schedule, a rejection, a missing mark)
--      and clear again;
--   4. RLS is still on and anon / authenticated read nothing.
-- Every check RAISEs on failure; a clean run prints PASS lines and
-- "ALL 0148 CHECKS PASSED", then ROLLS BACK (nothing persists).
-- ============================================================================
begin;

do $$
declare
  p uuid;
  n bigint;
begin
  -- 1. the columns
  perform 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'topic_publications'
     and column_name = 'youtube_publish_at' and data_type = 'timestamp with time zone' and is_nullable = 'YES';
  if not found then raise exception 'FAIL: youtube_publish_at timestamptz null'; end if;
  perform 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'topic_publications'
     and column_name = 'youtube_upload_status' and data_type = 'text' and is_nullable = 'YES';
  if not found then raise exception 'FAIL: youtube_upload_status text null'; end if;
  perform 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'topic_publications'
     and column_name = 'youtube_missing_since' and data_type = 'timestamp with time zone' and is_nullable = 'YES';
  if not found then raise exception 'FAIL: youtube_missing_since timestamptz null'; end if;
  raise notice 'PASS: three nullable columns with their types';

  -- 2. existing rows read, new columns null until the next poll
  select count(*) into n from topic_publications
   where youtube_publish_at is not null or youtube_upload_status is not null or youtube_missing_since is not null;
  if n <> 0 then raise exception 'FAIL: % rows already carry status values', n; end if;
  raise notice 'PASS: existing rows unchanged (new columns null)';

  -- 3. the worker's writes, on one real row (rolled back)
  select id into p from topic_publications where youtube_video_id is not null limit 1;
  if p is null then
    raise notice 'SKIP: no published row to write on';
  else
    update topic_publications set youtube_publish_at = '2026-10-21 09:00+00', youtube_upload_status = 'rejected:duplicate',
                                  youtube_missing_since = now() where id = p;
    perform 1 from topic_publications where id = p and youtube_upload_status = 'rejected:duplicate'
       and youtube_publish_at = '2026-10-21 09:00+00' and youtube_missing_since is not null;
    if not found then raise exception 'FAIL: a status write did not land'; end if;
    update topic_publications set youtube_missing_since = null where id = p;
    perform 1 from topic_publications where id = p and youtube_missing_since is null;
    if not found then raise exception 'FAIL: missing_since did not clear'; end if;
    raise notice 'PASS: schedule, rejection and missing mark write and clear';
  end if;

  -- 4. RLS unchanged
  perform 1 from pg_class where relname = 'topic_publications' and relrowsecurity;
  if not found then raise exception 'FAIL: RLS is off on topic_publications'; end if;
  raise notice 'PASS: RLS still on';
end $$;

set local role anon;
do $$ begin
  if (select count(*) from topic_publications) <> 0 then raise exception 'FAIL: anon reads publications'; end if;
  raise notice 'PASS: anon reads nothing (RLS)';
exception when insufficient_privilege then
  raise notice 'PASS: anon has no grant on topic_publications';
end $$;
reset role;

set local role authenticated;
do $$ begin
  if (select count(*) from topic_publications) <> 0 then raise exception 'FAIL: authenticated reads publications'; end if;
  raise notice 'PASS: authenticated reads nothing (RLS)';
exception when insufficient_privilege then
  raise notice 'PASS: authenticated has no grant on topic_publications';
end $$;
reset role;

do $$ begin raise notice 'ALL 0148 CHECKS PASSED'; end $$;
rollback;
