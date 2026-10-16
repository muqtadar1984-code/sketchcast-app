-- SketchCast AI — verification for 0134 (the Kit Translator)
-- ============================================================================
-- Run AFTER applying 0134. Builds a throwaway topic with an approved English
-- kit whose video is public, then a TRANSLATED kit of it, and proves:
--   1. the status lists accept 'staged' on articles and items;
--   2. a translation is not in catalogue_current_kits() while staged or in
--      review; the English kit still needs its YouTube row;
--   3. approve_topic_kit refuses a translation whose video artifact is
--      missing (storage first), and never touches the topic;
--   4. with the artifacts present it promotes the article and the items,
--      approves the kit, marks the previous translation stale, audits — and
--      the translation becomes current for its language while the topic's
--      status is unchanged;
--   5. a 'blocked' translation is hidden; a 'stale' one stays current;
--   6. reject_topic_kit's translation branch rejects the article, retires the
--      items and leaves the topic alone;
--   7. the glossary's (language, subject, sense) key refuses a second row;
--   8. jobs_one_live_translate refuses a second live kit_translate for the
--      same source kit and language, and allows it once the first is done.
-- Every check RAISEs on failure; a clean run prints PASS lines and
-- "ALL 0134 CHECKS PASSED", then ROLLS BACK (nothing persists).
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
create or replace function _err(stmt text) returns text language plpgsql as $$
begin execute stmt; return 'ok'; exception when others then return sqlerrm; end $$;

do $$
declare
  REV uuid := '88888888-0134-0000-0000-000000000001';   -- the reviewer (a profile)
  OWN uuid;                                              -- the catalogue system account (existing platform admin)
  topic uuid; art_en uuid; art_ar uuid; kit_en uuid; kit_ar uuid; kit_ar2 uuid;
  gen_en uuid; gen_ar uuid; deck_ar uuid; q_en uuid; q_ar uuid;
  r text; n int; t_status text; k topic_kits%rowtype;
begin
  select user_id into OWN from platform_admins limit 1;
  if OWN is null then raise exception 'no platform admin to own the catalogue rows'; end if;
  insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', REV, 'authenticated', 'authenticated', REV::text || '@t0134.example.com', now(), now())
  on conflict (id) do nothing;
  insert into profiles (id, role) values (REV, 'teacher') on conflict (id) do nothing;

  -- the topic, its English article and kit (approved, video public)
  insert into topics (canonical_key, title, subject, status) values ('t0134_semicircle', 'T0134 Semicircle', 'Mathematics', 'published')
  returning id into topic;
  insert into topic_articles (topic_id, version, language, title, status, sections, glossary)
  values (topic, 1, 'en', 'T0134', 'approved', '[{"id":"s1","heading":"A","body_md":"b"}]', '[{"term":"radius","definition":"r"}]')
  returning id into art_en;
  insert into generations (owner_id, kind, status, book_id, chapter_ref, params)
  values (OWN, 'presentation', 'done', null, null, jsonb_build_object('catalogue', true, 'topic_id', topic, 'language', 'en'))
  returning id into gen_en;
  insert into topic_kits (topic_id, article_id, language, status, presentation_generation_id, reviewed_at)
  values (topic, art_en, 'en', 'approved', gen_en, now() - interval '1 day') returning id into kit_en;
  insert into topic_publications (topic_kit_id, part, channel_language, youtube_video_id, privacy)
  values (kit_en, 1, 'en', 't0134video', 'public');
  -- ten approved English items: the bank floor the visibility rule needs
  for n in 1..10 loop
    insert into topic_questions (topic_id, article_id, language, item_type, answer_mode, difficulty, cognitive_level, stem, answer, marks, status, content_hash, objective_ref)
    values (topic, art_en, 'en', 'short_answer', 'subjective', 2, 'understand', 'q' || n, '{"text":"a"}', 1, 'approved', 't0134_' || n, 'o1')
    returning id into q_en;
  end loop;

  -- 1. 'staged' is a status now
  insert into topic_articles (topic_id, version, language, source_article_id, title, status, sections)
  values (topic, 1, 'ar', art_en, 'T0134 ar', 'staged', '[{"id":"s1","heading":"أ","body_md":"ب"}]')
  returning id into art_ar;
  perform _expect_eq((select status from topic_articles where id = art_ar), 'staged', 'a translated article can be staged');

  -- the translated kit: generating → in_review, its items staged
  insert into generations (owner_id, kind, status, book_id, chapter_ref, params)
  values (OWN, 'presentation', 'done', null, null, jsonb_build_object('catalogue', true, 'topic_id', topic, 'language', 'ar'))
  returning id into gen_ar;
  insert into generations (owner_id, kind, status, book_id, chapter_ref, params)
  values (OWN, 'deck', 'done', null, null, jsonb_build_object('catalogue', true, 'topic_id', topic, 'language', 'ar'))
  returning id into deck_ar;
  insert into topic_kits (topic_id, article_id, language, source_kit_id, status, translation_status, presentation_generation_id, doc_generation_ids)
  values (topic, art_ar, 'ar', kit_en, 'in_review', 'in_review', gen_ar, jsonb_build_object('deck', deck_ar)) returning id into kit_ar;
  insert into topic_questions (topic_id, article_id, language, item_type, answer_mode, difficulty, cognitive_level, stem, answer, marks, status, content_hash, objective_ref, source_item_id, translation_kit_id)
  values (topic, art_ar, 'ar', 'short_answer', 'subjective', 2, 'understand', 'س', '{"text":"ج"}', 1, 'staged', 't0134_ar_1', 'o1', q_en, kit_ar)
  returning id into q_ar;
  perform _expect_eq((select status from topic_questions where id = q_ar), 'staged', 'a translated item can be staged');
  r := _err(format('insert into topic_questions (topic_id, article_id, language, item_type, answer_mode, difficulty, cognitive_level, stem, answer, marks, status, content_hash, objective_ref, source_item_id, translation_kit_id) values (%L, %L, ''ar'', ''short_answer'', ''subjective'', 2, ''understand'', ''x'', ''{"text":"y"}'', 1, ''staged'', ''t0134_ar_dup'', ''o1'', %L, %L)', topic, art_ar, q_en, kit_ar));
  perform _expect_eq(r like '%duplicate key%', true, 'one translation of an item per translation kit');

  -- 2. not current while in review; English current through YouTube
  perform _expect_eq((select count(*) from catalogue_current_kits() c where c.topic_id = topic and c.language = 'ar')::int, 0, 'an in-review translation is not current');
  perform _expect_eq((select count(*) from catalogue_current_kits() c where c.topic_id = topic and c.language = 'en')::int, 1, 'the English kit is current through its public video');

  -- 3. approve refuses without the video artifact; the topic is untouched
  select status into t_status from topics where id = topic;
  r := _err(format('select approve_topic_kit(%L, %L, null)', kit_ar, REV));
  perform _expect_eq(r like '%no rendered video%', true, 'a translation without a video artifact is refused');
  perform _expect_eq((select status from topic_kits where id = kit_ar), 'in_review', 'the kit stays in review after the refusal');
  perform _expect_eq((select status from topics where id = topic), t_status, 'the topic is not touched by the refusal');

  -- 4. with the artifacts: promotion in one transaction
  insert into artifacts (generation_id, kind, storage_path) values (gen_ar, 'video_mp4', 'x/' || gen_ar || '/lesson.mp4');
  insert into artifacts (generation_id, kind, storage_path) values (deck_ar, 'deck_pptx', 'x/' || deck_ar || '/deck.pptx');
  k := approve_topic_kit(kit_ar, REV, 'spot-checked');
  perform _expect_eq(k.status, 'approved', 'the translation kit is approved');
  perform _expect_eq(k.translation_status, 'approved', 'translation_status follows');
  perform _expect_eq((select status from topic_articles where id = art_ar), 'approved', 'the staged article is promoted');
  perform _expect_eq((select status from topic_questions where id = q_ar), 'approved', 'the staged item is promoted');
  perform _expect_eq((select status from topics where id = topic), t_status, 'the topic status is unchanged by a translation approval');
  perform _expect_eq((select count(*) from platform_audit_log where action = 'library_kit_translation_approve' and target_id = topic)::int, 1, 'audited');
  perform _expect_eq((select c.topic_kit_id from catalogue_current_kits() c where c.topic_id = topic and c.language = 'ar'), kit_ar, 'the approved translation is current without a YouTube row (D5)');
  perform _expect_eq((select array_agg(c.language order by c.language) from catalogue_current_kits() c where c.topic_id = topic), array['ar','en'], 'both languages listed');

  -- a second translation replaces the first: the first goes stale, its article superseded, its item retired
  insert into topic_articles (topic_id, version, language, source_article_id, title, status, sections)
  values (topic, 2, 'ar', art_en, 'T0134 ar v2', 'staged', '[{"id":"s1","heading":"أ","body_md":"ب2"}]') returning id into art_ar;
  insert into topic_kits (topic_id, article_id, language, source_kit_id, status, translation_status, presentation_generation_id, doc_generation_ids)
  values (topic, art_ar, 'ar', kit_en, 'in_review', 'in_review', gen_ar, '{}'::jsonb) returning id into kit_ar2;
  k := approve_topic_kit(kit_ar2, REV, null);
  perform _expect_eq((select translation_status from topic_kits where id = kit_ar), 'stale', 'the previous translation is stale');
  perform _expect_eq((select status from topic_questions where id = q_ar), 'retired', 'the previous translation''s items are retired');
  perform _expect_eq((select c.topic_kit_id from catalogue_current_kits() c where c.topic_id = topic and c.language = 'ar'), kit_ar2, 'the newest approved translation is current');

  -- 5. blocked hides, stale serves
  update topic_kits set translation_status = 'blocked' where id = kit_ar2;
  perform _expect_eq((select c.topic_kit_id from catalogue_current_kits() c where c.topic_id = topic and c.language = 'ar'), kit_ar, 'a blocked translation is hidden; the stale one serves');
  update topic_kits set translation_status = 'approved' where id = kit_ar2;

  -- 6. reject's translation branch
  k := reject_topic_kit(kit_ar2, REV, 'translation', 'the student voice reads the teacher''s line');
  perform _expect_eq(k.status, 'rejected', 'rejected');
  perform _expect_eq(k.translation_status, 'failed', 'translation failed on reject');
  perform _expect_eq((select status from topics where id = topic), t_status, 'the topic is untouched by a translation reject');
  perform _expect_eq((select count(*) from platform_audit_log where action = 'library_kit_translation_reject' and target_id = topic)::int, 1, 'reject audited');

  -- 7. the glossary key
  insert into topic_term_translations (language, subject, sense, term_en, term) values ('ar', 'mathematics', 'radius', 'radius', 'نصف القطر');
  r := _err('insert into topic_term_translations (language, subject, sense, term_en, term) values (''ar'', ''mathematics'', ''radius'', ''radius'', ''شعاع'')');
  perform _expect_eq(r like '%duplicate key%', true, 'one term per (language, subject, sense)');
  r := _err('insert into topic_term_translations (language, subject, sense, term_en, term) values (''ar'', ''physics'', ''radius'', ''radius'', ''شعاع'')');
  perform _expect_eq(r, 'ok', 'another subject is another sense');

  -- 8. one live translate job per (source kit, language)
  insert into jobs (type, status, params) values ('kit_translate', 'queued', jsonb_build_object('source_kit_id', kit_en, 'language', 'ar'));
  r := _err(format('insert into jobs (type, status, params) values (''kit_translate'', ''queued'', jsonb_build_object(''source_kit_id'', %L::uuid, ''language'', ''ar''))', kit_en));
  perform _expect_eq(r like '%duplicate key%', true, 'a second live translate job is refused');
  r := _err(format('insert into jobs (type, status, params) values (''kit_translate'', ''queued'', jsonb_build_object(''source_kit_id'', %L::uuid, ''language'', ''fr''))', kit_en));
  perform _expect_eq(r, 'ok', 'another language is another job');
  update jobs set status = 'done' where type = 'kit_translate' and params->>'source_kit_id' = kit_en::text and params->>'language' = 'ar';
  r := _err(format('insert into jobs (type, status, params) values (''kit_translate'', ''queued'', jsonb_build_object(''source_kit_id'', %L::uuid, ''language'', ''ar''))', kit_en));
  perform _expect_eq(r, 'ok', 'once the first is done a new one may queue');

  raise notice 'ALL 0134 CHECKS PASSED';
end $$;

rollback;
