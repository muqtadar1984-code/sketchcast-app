-- 0147: the AUTO TRANSLATE AGENT (plan "SketchCast Feature Plan - Auto Translate
-- Agent.md", Revision 3, 2026-10-20).
--
-- The worker's sweep (sketchcast-ai catalogue/auto_translate.py, on the reaper
-- tick) queues ONE kit_translate at a time for every approved English kit that
-- is public on the English YouTube channel, in every lesson language — Jawi
-- from the approved Malay kit. Nothing here runs by itself: the agent ships
-- OFF (enabled=false) and in DRY RUN, and the env AUTO_TRANSLATE=1 must also be
-- set on the worker.
--
-- Four things live here:
--   1. platform_settings 'auto_translate' (the founder's controls — enabled,
--      paused, dry_run, the language order, the cost warning) and
--      'auto_translate_state' (written by the agent only). Seeded OFF; an
--      existing row is never overwritten.
--   2. auto_translate_candidates(p_languages) — every (source kit, language)
--      pair the agent could queue, ranked, with a HOLD reason for the ones it
--      must not (queued, rejected/failed, a recent failed job, Malay not
--      approved, an older live translation). The one source of truth for the
--      worker and the Library strip.
--   3. auto_translate_enqueue(...) — the ONLY inserter for the agent's jobs:
--      under one advisory lock it re-checks that the translation lane is free
--      and the pair still eligible, then inserts the job (params.auto=true)
--      and its platform_audit_log row. Two worker containers cannot both
--      queue; the 0134 one-live index stays the last guard.
--   4. public_catalogue(): a translation's video counts only on ITS OWN
--      language's channel (founder: storage playback until the video is public
--      on its own channel, then the YouTube embed). English rows are unchanged
--      (every English publication is on the 'en' channel).
--
-- Rollback: 0147_auto_translate_agent_rollback.sql.

-- ── 1. settings ─────────────────────────────────────────────────────────────
insert into public.platform_settings (key, value) values
  ('auto_translate', jsonb_build_object(
     'enabled', false,
     'paused', false,
     'dry_run', true,
     'languages', jsonb_build_array('ar','ms','hi','te','fr','es','pt','ur','mr','ms-arab'),
     'retranslate', jsonb_build_array('blocked','stale'),
     -- an English kit first posted after this moment is NEW (it jumps the
     -- backlog in every language); everything posted before is the backlog
     'new_since', to_jsonb(now()),
     'cost_warn_usd', 2.0,
     'summary_email', 'muqtadar1984@gmail.com',
     'summary_hour_utc', 3.5)),
  ('auto_translate_state', '{}'::jsonb)
on conflict (key) do nothing;

-- ── 2. the candidates ───────────────────────────────────────────────────────
create or replace function public.auto_translate_candidates(p_languages text[])
returns table (
  source_kit_id  uuid,
  topic_id       uuid,
  topic_title    text,
  subject        text,
  language       text,
  reason         text,      -- blocked | stale | new | backlog
  hold           text,      -- null = eligible; else why not
  hold_detail    text,
  priority       integer,   -- 1 blocked, 2 stale, 3 new, 4 backlog
  lang_rank      integer,
  subject_turn   integer,   -- the n-th kit of its subject in its language (alternation)
  english_public_at timestamptz,
  rank           bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with
  -- current English kits that are approved AND public on the English channel
  -- (every part), with their script_json (the translator's input)
  en as (
    select c.topic_kit_id as kit_id, c.topic_id, t.title, t.subject, k.created_at,
           (select min(p.created_at) from topic_publications p
             where p.topic_kit_id = k.id and p.channel_language = 'en' and p.superseded_by is null) as public_at
    from catalogue_current_kits() c
    join topic_kits k on k.id = c.topic_kit_id
    join topics t on t.id = c.topic_id
    where c.language = 'en'
      and k.translation_status is null
      and exists (select 1 from topic_publications p
                   where p.topic_kit_id = k.id and p.channel_language = 'en' and p.superseded_by is null)
      and not exists (select 1 from topic_publications p
                       where p.topic_kit_id = k.id and p.channel_language = 'en' and p.superseded_by is null
                         and (p.privacy is distinct from 'public' or p.youtube_video_id is null))
      and exists (select 1 from artifacts a
                   where a.generation_id = k.presentation_generation_id and a.kind = 'script_json')
  ),
  langs as (
    select l.code, l.ord::int as ord
    from unnest(p_languages) with ordinality as l(code, ord)
    where l.code <> 'en'
  ),
  -- the pair's SOURCE: the English kit, or for Jawi the topic's approved Malay
  -- kit made from that English kit (catalogue/translate.py load_source)
  pairs as (
    select en.topic_id, en.title, en.subject, en.created_at, en.public_at, l.code as language, l.ord,
           case when l.code = 'ms-arab' then ms.id else en.kit_id end as source_kit_id,
           (l.code = 'ms-arab' and ms.id is null) as malay_missing
    from en
    cross join langs l
    left join lateral (
      select m.id from topic_kits m
       where m.source_kit_id = en.kit_id and m.language = 'ms'
         and m.status = 'approved' and m.translation_status = 'approved'
       order by coalesce(m.reviewed_at, m.updated_at, m.created_at) desc
       limit 1) ms on l.code = 'ms-arab'
  ),
  judged as (
    select p.*,
      -- an older translation of this topic in this language, stale or blocked
      -- by a supersede: what the new one replaces
      (select max(case k.translation_status when 'blocked' then 2 when 'stale' then 1 else 0 end)
         from topic_kits k
        where k.topic_id = p.topic_id and k.language = p.language
          and k.translation_status in ('blocked', 'stale')
          and k.source_kit_id is distinct from p.source_kit_id) as superseded_kind,
      exists (select 1 from jobs j
               where j.type = 'kit_translate' and j.status in ('queued', 'processing')
                 and j.params ->> 'source_kit_id' = p.source_kit_id::text
                 and j.params ->> 'language' = p.language) as job_live,
      exists (select 1 from topic_kits k
               where k.source_kit_id = p.source_kit_id and k.language = p.language
                 and k.status in ('generating', 'in_review', 'approved')
                 and coalesce(k.translation_status, '') not in ('failed', 'stale', 'blocked')) as kit_live,
      (select string_agg(distinct k.status || '/' || coalesce(k.translation_status, '-'), ', ')
         from topic_kits k
        where k.source_kit_id = p.source_kit_id and k.language = p.language
          and (k.status in ('rejected', 'failed') or k.translation_status = 'failed')) as kit_dead,
      (select j.error from jobs j
        where j.type = 'kit_translate' and j.status = 'error'
          and j.params ->> 'source_kit_id' = p.source_kit_id::text
          and j.params ->> 'language' = p.language
          and j.created_at > now() - interval '7 days'
          -- a person deleting the failed translation (×, 0143) clears the hold
          and j.created_at > coalesce((select max(a.created_at) from platform_audit_log a
                                        where a.action = 'library_kit_translation_delete'
                                          and a.target_id = p.topic_id and a.detail ->> 'language' = p.language),
                                      '-infinity'::timestamptz)
        order by j.created_at desc limit 1) as job_error,
      (select count(*) from jobs j
        where j.type = 'kit_translate' and j.status = 'error'
          and j.params ->> 'source_kit_id' = p.source_kit_id::text
          and j.params ->> 'language' = p.language
          and j.created_at > now() - interval '7 days'
          -- a person deleting the failed translation (×, 0143) clears the hold
          and j.created_at > coalesce((select max(a.created_at) from platform_audit_log a
                                        where a.action = 'library_kit_translation_delete'
                                          and a.target_id = p.topic_id and a.detail ->> 'language' = p.language),
                                      '-infinity'::timestamptz)) as job_errors,
      exists (select 1 from topic_kits k
               where k.topic_id = p.topic_id and k.language = p.language
                 and k.status = 'approved' and k.translation_status = 'approved'
                 and k.source_kit_id is distinct from p.source_kit_id) as older_live
    from pairs p
  ),
  ranked as (
    select j.*,
      case
        when j.malay_missing then 'malay_not_approved'
        when j.job_live then 'queued'
        when j.kit_live then 'translated'
        when j.kit_dead is not null then 'rejected_or_failed'
        when j.job_error is not null then 'job_failed'
        when j.older_live and coalesce(j.superseded_kind, 0) = 0 then 'older_translation_live'
      end as hold,
      case
        when j.kit_dead is not null then j.kit_dead
        when j.job_error is not null then j.job_errors || ' failed job(s) in 7 days: ' || left(j.job_error, 300)
      end as hold_detail,
      case
        when j.superseded_kind = 2 then 1
        when j.superseded_kind = 1 then 2
        when j.public_at > coalesce(
               (select (value ->> 'new_since')::timestamptz from platform_settings where key = 'auto_translate'),
               'infinity'::timestamptz) then 3
        else 4
      end as priority,
      row_number() over (partition by j.language, j.subject order by j.created_at, j.topic_id) as subject_turn
    from judged j
  )
  select r.source_kit_id, r.topic_id, r.title, r.subject, r.language,
         case r.priority when 1 then 'blocked' when 2 then 'stale' when 3 then 'new' else 'backlog' end,
         r.hold, r.hold_detail, r.priority, r.ord, r.subject_turn::int, r.public_at,
         row_number() over (
           order by (r.hold is not null), r.priority, r.ord, r.subject_turn,
                    case r.subject when 'Mathematics' then 0 when 'Science' then 1 else 2 end,
                    r.subject, r.created_at, r.topic_id)
  from ranked r
  order by 13
$$;
comment on function public.auto_translate_candidates(text[]) is
  'Auto Translate Agent (0147): every (source kit, language) pair for the given languages, ranked; hold is null for the ones the agent may queue. Source = the approved English kit public on the English channel, or for ms-arab the approved Malay kit made from it.';
revoke all on function public.auto_translate_candidates(text[]) from public, anon, authenticated;
grant execute on function public.auto_translate_candidates(text[]) to service_role;

-- ── 3. the one inserter ─────────────────────────────────────────────────────
create or replace function public.auto_translate_enqueue(p_source_kit_id uuid, p_language text, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c   record;
  v_job uuid;
begin
  perform pg_advisory_xact_lock(hashtext('auto_translate'));
  -- the lane: one translation at a time (0141/0142's rule, read here too so
  -- the agent never stacks a second job behind a running one)
  if exists (select 1 from jobs j where j.type = 'kit_translate' and j.status in ('queued', 'processing')) then
    return jsonb_build_object('queued', false, 'why', 'translation_in_flight');
  end if;
  if exists (select 1 from topic_kits k where k.status = 'generating' and coalesce(k.language, 'en') <> 'en') then
    return jsonb_build_object('queued', false, 'why', 'translated_kit_rendering');
  end if;
  select * into v_c
    from auto_translate_candidates(array[p_language]) c
   where c.source_kit_id = p_source_kit_id
   limit 1;
  if not found then
    return jsonb_build_object('queued', false, 'why', 'not_a_candidate');
  end if;
  -- a job_failed hold is the worker's call (the one throttle retry); any
  -- other hold refuses here whatever the caller thinks
  if v_c.hold is not null and v_c.hold <> 'job_failed' then
    return jsonb_build_object('queued', false, 'why', v_c.hold);
  end if;
  if p_dry_run then
    return jsonb_build_object('queued', false, 'dry_run', true, 'source_kit_id', p_source_kit_id,
                              'language', p_language, 'topic_id', v_c.topic_id, 'reason', v_c.reason);
  end if;
  insert into jobs (type, status, book_id, generation_id, params)
  values ('kit_translate', 'queued', null, null,
          jsonb_build_object('source_kit_id', p_source_kit_id, 'topic_id', v_c.topic_id,
                             'language', p_language, 'auto', true))
  returning id into v_job;
  insert into platform_audit_log (actor_id, action, target_kind, target_id, detail)
  values (null, 'auto_translate_enqueue', 'topic', v_c.topic_id,
          jsonb_build_object('source_kit_id', p_source_kit_id, 'language', p_language, 'job_id', v_job,
                             'reason', v_c.reason, 'retry', v_c.hold = 'job_failed'));
  return jsonb_build_object('queued', true, 'job_id', v_job, 'source_kit_id', p_source_kit_id,
                            'language', p_language, 'topic_id', v_c.topic_id, 'reason', v_c.reason);
end $$;
comment on function public.auto_translate_enqueue(uuid, text, boolean) is
  'Auto Translate Agent (0147): queue ONE kit_translate (params.auto=true) plus its audit row, under one advisory lock, only while no translation is in flight and the pair is still a candidate. p_dry_run reports what it would queue.';
revoke all on function public.auto_translate_enqueue(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.auto_translate_enqueue(uuid, text, boolean) to service_role;

-- ── 4. public_catalogue(): a translation's video on its own channel only ────
create or replace function public.public_catalogue()
returns table (
  slug                  text,
  title                 text,
  subject               text,
  summary               text,
  language              text,
  languages             text[],
  approved_at           timestamptz,
  objectives            jsonb,
  key_concepts          jsonb,
  sections              jsonb,
  worked_examples       jsonb,
  misconceptions        jsonb,
  curriculum            jsonb,
  videos                jsonb,
  chapters              jsonb,
  kit_pieces            text[],
  question_count        integer,
  has_online_assessment boolean,
  exam_ready            boolean,
  previews              jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with cur as (select * from catalogue_current_kits())
  select
    t.slug,
    coalesce(nullif(a.title, ''), t.title),
    t.subject,
    t.summary,
    cur.language,
    (select array_agg(c2.language order by c2.language) from cur c2 where c2.topic_id = cur.topic_id),
    cur.approved_at,
    a.objectives,
    a.glossary,
    a.sections,
    case when jsonb_typeof(a.worked_examples) = 'array'
         then coalesce((select jsonb_agg(e.value order by e.ord)
                        from jsonb_array_elements(a.worked_examples) with ordinality as e(value, ord)
                        where e.ord <= 2), '[]'::jsonb)
         else '[]'::jsonb end,
    a.misconceptions,
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'curriculum', cu.name, 'curriculum_code', cu.code,
               'code', n.code, 'title', n.title, 'grade', n.grade, 'strand', n.strand,
               'coverage', m.coverage)
             order by cu.code, n.sort, n.code)
      from topic_curriculum_map m
      join curriculum_nodes n on n.id = m.node_id
      join curricula cu on cu.id = n.curriculum_id
      where m.topic_id = t.id), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object('part', p.part, 'youtube_video_id', p.youtube_video_id)
             order by p.part)
      from topic_publications p
      where p.topic_kit_id = k.id and p.superseded_by is null
        and p.privacy = 'public' and p.youtube_video_id is not null
        -- 0147: a translation's video counts only on ITS OWN language's channel
        and p.channel_language = coalesce(k.language, 'en')), '[]'::jsonb),
    coalesce(k.chapters, '[]'::jsonb),
    array['video'] || coalesce(
      (select array_agg(d.key order by d.key) from jsonb_each_text(coalesce(k.doc_generation_ids, '{}'::jsonb)) d
       where nullif(d.value, '') is not null), array[]::text[]),
    (select count(*)::int from topic_questions q
      where q.topic_id = t.id and q.language = cur.language and q.status = 'approved'),
    exists (
      select 1 from artifacts ar
      where ar.generation_id in (
              nullif(coalesce(k.doc_generation_ids, '{}'::jsonb) ->> 'worksheet', '')::uuid,
              nullif(coalesce(k.doc_generation_ids, '{}'::jsonb) ->> 'quiz', '')::uuid)
        and ar.kind = 'questions_json'),
    t.bank_maturity = 'exam_ready',
    -- 0138: the preview cards, as public URLs (the bucket is public). Only
    -- entries with a path; anything else the worker may have written is
    -- dropped here rather than handed to the site.
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', e.value ->> 'kind',
               'url', 'https://pblaxsqhjwlqbrwbraxy.supabase.co/storage/v1/object/public/catalogue-previews/' || (e.value ->> 'path'))
             order by e.ord)
      from jsonb_array_elements(case when jsonb_typeof(k.previews) = 'array' then k.previews else '[]'::jsonb end)
           with ordinality as e(value, ord)
      where nullif(e.value ->> 'path', '') is not null), '[]'::jsonb)
  from cur
  join topics t       on t.id = cur.topic_id
  join topic_kits k   on k.id = cur.topic_kit_id
  join topic_articles a on a.id = cur.article_id
$$;
comment on function public.public_catalogue() is
  'What an anonymous visitor may read about the catalogue (0128), one row per current kit; 0131 adds strand, 0137 keys the assessment flag on the quiz too, 0138 adds the preview cards (public URLs), 0147 counts a translation''s video only on its own language''s channel.';

revoke all on function public.public_catalogue() from public;
grant execute on function public.public_catalogue() to anon, authenticated, service_role;
