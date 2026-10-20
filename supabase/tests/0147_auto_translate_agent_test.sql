-- SketchCast AI — verification for 0147 (Auto Translate Agent)
-- ============================================================================
-- Run AFTER applying 0147. Proves, against production data:
--   1. the settings are seeded OFF and in DRY RUN;
--   2. every candidate is a current English kit public on the English channel
--      (or, for ms-arab, an approved Malay kit made from one), and no pair that
--      already has a live translation is eligible;
--   3. Jawi is held until its Malay kit is approved;
--   4. the order is one language at a time (every eligible Arabic pair ranks
--      before every eligible Malay pair);
--   5. auto_translate_enqueue: a dry run inserts nothing; a live call inserts
--      ONE job (params.auto) and ONE audit row; a second call while it is
--      queued is refused (translation_in_flight);
--   6. a failed translation holds its pair (never retried by the agent) — even
--      one whose render failed while its translation_status still reads staged;
--   7. public_catalogue(): a translation's video counts only on its own
--      language's channel.
-- Every check RAISEs on failure; a clean run prints PASS lines and
-- "ALL 0147 CHECKS PASSED", then ROLLS BACK (nothing persists).
-- ============================================================================
begin;

create or replace function _expect_eq(actual anyelement, expected anyelement, msg text) returns void
  language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL (got %, wanted %): %', actual, expected, msg;
  end if;
  raise notice 'PASS (= %): %', expected, msg;
end $$;

do $$
declare
  L text[] := array['ar','ms','hi','te','fr','es','pt','ur','mr','ms-arab'];
  s jsonb;
  src uuid; lang text; res jsonb; n_jobs bigint; n_audit bigint;
  k uuid; tr_kit uuid; tr_lang text;
begin
  -- 1. settings
  s := (select value from platform_settings where key = 'auto_translate');
  perform _expect_eq((s ->> 'enabled')::boolean, false, 'seeded disabled');
  perform _expect_eq((s ->> 'dry_run')::boolean, true, 'seeded in dry run');
  perform _expect_eq(s -> 'languages' ->> 9, 'ms-arab', 'Jawi last in the order');

  -- 2. sources
  perform _expect_eq((select count(*) from auto_translate_candidates(L) c
                       where c.language <> 'ms-arab'
                         and not exists (select 1 from catalogue_current_kits() cur
                                          where cur.topic_kit_id = c.source_kit_id and cur.language = 'en')), 0::bigint,
                     'every direct source is a current English kit');
  perform _expect_eq((select count(*) from auto_translate_candidates(L) c
                       where c.hold is null
                         and exists (select 1 from topic_kits t where t.source_kit_id = c.source_kit_id
                                       and t.language = c.language and t.status in ('generating','in_review','approved')
                                       and coalesce(t.translation_status,'') not in ('failed','stale','blocked'))), 0::bigint,
                     'no eligible pair already has a live translation');

  -- 3. Jawi waits for Malay
  perform _expect_eq((select count(*) from auto_translate_candidates(L) c
                       where c.language = 'ms-arab' and c.hold is null
                         and not exists (select 1 from topic_kits m where m.id = c.source_kit_id and m.language = 'ms'
                                           and m.status = 'approved' and m.translation_status = 'approved')), 0::bigint,
                     'an eligible Jawi pair always sources an approved Malay kit');

  -- 4. one language at a time
  perform _expect_eq((select coalesce(max(rank), 0) from auto_translate_candidates(L) where language = 'ar' and hold is null)
                       < (select coalesce(min(rank), 1000000) from auto_translate_candidates(L) where language = 'ms' and hold is null),
                     true, 'all eligible Arabic before any Malay');

  -- 5. the inserter (only when the lane is free right now)
  if not exists (select 1 from jobs where type = 'kit_translate' and status in ('queued','processing'))
     and not exists (select 1 from topic_kits where status = 'generating' and coalesce(language,'en') <> 'en') then
    select c.source_kit_id, c.language into src, lang from auto_translate_candidates(L) c where c.hold is null order by c.rank limit 1;
    if src is not null then
      n_jobs := (select count(*) from jobs); n_audit := (select count(*) from platform_audit_log);
      res := auto_translate_enqueue(src, lang, true);
      perform _expect_eq((res ->> 'dry_run')::boolean, true, 'dry run reports');
      perform _expect_eq((select count(*) from jobs), n_jobs, 'dry run inserts no job');
      res := auto_translate_enqueue(src, lang, false);
      perform _expect_eq((res ->> 'queued')::boolean, true, 'live call queues');
      perform _expect_eq((select (params ->> 'auto')::boolean from jobs where id = (res ->> 'job_id')::uuid), true, 'params.auto');
      perform _expect_eq((select count(*) from platform_audit_log), n_audit + 1, 'one audit row');
      res := auto_translate_enqueue(src, lang, false);
      perform _expect_eq(res ->> 'why', 'translation_in_flight', 'a second call is refused');
      delete from jobs where id = (select (detail ->> 'job_id')::uuid from platform_audit_log
                                    where action = 'auto_translate_enqueue' order by created_at desc limit 1);
    end if;
  else
    raise notice 'SKIP 5: a translation is in flight right now';
  end if;

  -- 6. a rejected translation holds its pair
  select c.source_kit_id, c.language into src, lang from auto_translate_candidates(L) c
   where c.hold is null and c.language <> 'ms-arab' order by c.rank limit 1;
  if src is not null then
    insert into topic_kits (topic_id, article_id, language, source_kit_id, status, translation_status)
    select t.topic_id, t.article_id, lang, t.id, 'failed', 'staged' from topic_kits t where t.id = src
    returning id into k;
    perform _expect_eq((select hold from auto_translate_candidates(array[lang]) where source_kit_id = src), 'rejected_or_failed',
                       'a render-failed translation (status failed, still staged) holds its pair');
    perform _expect_eq((auto_translate_enqueue(src, lang, true)) ->> 'why', 'rejected_or_failed', 'the inserter refuses it too');
  end if;

  -- 7. own-channel video (any current translation that has no publication)
  select t.id, t.language into tr_kit, tr_lang from topic_kits t
   join catalogue_current_kits() c on c.topic_kit_id = t.id
   where t.language <> 'en' and not exists (select 1 from topic_publications p where p.topic_kit_id = t.id) limit 1;
  if tr_kit is not null then
    insert into topic_publications (topic_kit_id, part, channel_language, youtube_video_id, privacy)
    values (tr_kit, 1, 'en', 'TEST0147_EN', 'public');
    perform _expect_eq((select jsonb_array_length(pc.videos) from public_catalogue() pc
                         join topics tp on tp.slug = pc.slug
                         join topic_kits tk on tk.topic_id = tp.id and tk.id = tr_kit
                        where pc.language = tr_lang), 0, 'a translation posted on the ENGLISH channel shows no video');
    update topic_publications set channel_language = tr_lang where topic_kit_id = tr_kit and youtube_video_id = 'TEST0147_EN';
    perform _expect_eq((select jsonb_array_length(pc.videos) from public_catalogue() pc
                         join topics tp on tp.slug = pc.slug
                         join topic_kits tk on tk.topic_id = tp.id and tk.id = tr_kit
                        where pc.language = tr_lang), 1, 'on its own channel the video counts');
  else
    raise notice 'SKIP 7: every current translation already has a publication';
  end if;
  perform _expect_eq((select count(*) from public_catalogue() where language = 'en' and jsonb_array_length(videos) = 0), 0::bigint,
                     'every English row keeps its video');

  raise notice 'ALL 0147 CHECKS PASSED';
end $$;

rollback;
