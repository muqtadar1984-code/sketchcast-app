-- 0138: PREVIEW IMAGES of a catalogue kit on its public lesson page.
-- Catalogue plan §4.4 (Phase B leftover, built 2026-10-16).
--
-- "Blurring can be undone and doesn't look good." Instead the worker renders
-- purpose-made preview cards once per kit — the deck's title slide and first
-- content slide, page 1 of the lesson plan, page 1 of the STUDENT worksheet —
-- low resolution, watermarked "PREVIEW", drawn from the documents' own text
-- (catalogue/previews.py). They never come from an answer key, questions_json
-- or the printable bank: the renderer reads only the 'deck_pptx' and 'docx'
-- artifact kinds, by construction.
--
-- Three things live here:
--   1. a PUBLIC bucket, catalogue-previews, PNG only, 1 MB a file. Public on
--      purpose: the landing site is built with the publishable key and must be
--      able to fetch them, and a preview is made to be seen. No client policy
--      is created, so only the service role (the worker) can write; reads are
--      the bucket's public URL.
--   2. topic_kits.previews jsonb — [{kind, path}] as rendered; [] until then.
--   3. public_catalogue() gains `previews` jsonb — [{kind, url}] with the
--      bucket's public URL, for the current kit. A new return column means
--      DROP + CREATE (Postgres refuses to change a function's return type in
--      place); the body is 0137's with the one column added, and the grants
--      are re-stated below because a dropped function loses them.
--
-- Rollback: 0138_kit_previews_rollback.sql (0137's function; the column and
-- bucket are left in place — harmless and holding data).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('catalogue-previews', 'catalogue-previews', true, 1048576, array['image/png'])
  on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

alter table public.topic_kits add column if not exists previews jsonb not null default '[]'::jsonb;
comment on column public.topic_kits.previews is
  'Catalogue plan §4.4: preview cards rendered by the worker (catalogue/previews.py) — [{kind, path}] in bucket catalogue-previews; [] until rendered.';

drop function if exists public.public_catalogue();
create function public.public_catalogue()
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
        and p.privacy = 'public' and p.youtube_video_id is not null), '[]'::jsonb),
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
  'What an anonymous visitor may read about the catalogue (0128), one row per current kit; 0131 adds strand, 0137 keys the assessment flag on the quiz too, 0138 adds the preview cards (public URLs).';

revoke all on function public.public_catalogue() from public;
grant execute on function public.public_catalogue() to anon, authenticated, service_role;
