-- 0138 rollback: public_catalogue() back to its 0137 shape (no previews column).
-- The catalogue-previews bucket and topic_kits.previews stay: harmless, and holding data.
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
  exam_ready            boolean
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
    t.bank_maturity = 'exam_ready'
  from cur
  join topics t       on t.id = cur.topic_id
  join topic_kits k   on k.id = cur.topic_kit_id
  join topic_articles a on a.id = cur.article_id
$$;
revoke all on function public.public_catalogue() from public;
grant execute on function public.public_catalogue() to anon, authenticated, service_role;
