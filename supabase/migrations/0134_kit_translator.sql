-- SketchCast AI — 0134: the Kit Translator (plan revision 3, 2026-10-16; phase T0)
-- ============================================================================
-- An approved ENGLISH catalogue kit becomes the SAME kit in another lesson
-- language: the worker's `kit_translate` job rewrites the words of the
-- finished artifacts and re-renders them (decision D1), and the result is an
-- ordinary `topic_kits` row in that language whose `source_kit_id` names the
-- English kit (R3 lineage). This migration gives the schema what that needs:
--
--   1. topic_kits: translation_status (null for an English kit; staged →
--      in_review → approved | stale | blocked | failed), the provenance
--      record (`translation`), the pre-check report (`precheck`) and, on a
--      superseded English kit, WHY it was superseded (cosmetic → its
--      translations stay visible as stale; correction → blocked).
--   2. topic_articles / topic_questions: a `staged` status (R2 — a translated
--      article or item exists before its kit is reviewed and becomes
--      `approved` ONLY through the kit's approval); items carry their source
--      item and the translation kit they belong to, unique per (source item,
--      translation kit) so a retranslation stages beside the live one.
--   3. topic_term_translations: the glossary (R1), keyed (language, subject,
--      sense) so "cell" in biology and "cell" in electricity never collide;
--      a reviewer's row is never overwritten by a model's.
--   4. jobs: one live kit_translate per (source kit, language) — the same
--      partial-unique-index pattern as 0114 / 0115 / 0116.
--   5. approve_topic_kit / reject_topic_kit: a TRANSLATION branch. The
--      English branch is 0115's, verbatim. The translation branch does not
--      touch the topic's status (the topic is wherever its English kit put
--      it), verifies the kit's artifacts EXIST before any flip (storage
--      first, then one transaction — review finding, revision 3), promotes
--      the staged article and items, retires the previous translation's,
--      and audits as library_kit_translation_approve / _reject.
--   6. catalogue_current_kits(): a NON-English kit is current when approved
--      (translation_status approved or stale) — decision D5: approved equals
--      visible in the app, played from storage; the YouTube clause stays for
--      English. `blocked` is excluded.
--
-- Additive except the two status check constraints, which are replaced with
-- a superset. Nothing here writes 'approved' outside the two RPCs.
-- Rollback: supabase/migrations/0134_kit_translator_rollback.sql.
-- ============================================================================

begin;

-- ── 1. topic_kits ────────────────────────────────────────────────────────────
alter table public.topic_kits
  add column if not exists translation_status text,
  add column if not exists translation       jsonb,
  add column if not exists precheck          jsonb,
  add column if not exists supersede_reason  text;

alter table public.topic_kits drop constraint if exists topic_kits_translation_status_check;
alter table public.topic_kits add constraint topic_kits_translation_status_check
  check (translation_status is null or translation_status in ('staged','in_review','approved','stale','blocked','failed'));
alter table public.topic_kits drop constraint if exists topic_kits_supersede_reason_check;
alter table public.topic_kits add constraint topic_kits_supersede_reason_check
  check (supersede_reason is null or supersede_reason in ('cosmetic','correction'));

create index if not exists topic_kits_translations_idx
  on public.topic_kits (source_kit_id, language) where translation_status is not null;

comment on column public.topic_kits.translation_status is
  'Kit Translator (0134): null for an English kit. staged while the worker builds the translation, in_review when every piece is done, approved by approve_topic_kit, stale when the English source was superseded cosmetically (still served), blocked when it was superseded for a correction (hidden until retranslated), failed.';
comment on column public.topic_kits.translation is
  'Kit Translator provenance: source kit / generation / article, the staged script paths and the source scripts'' hashes, the glossary pairs, the assets reused, model and prompt versions, voices, the two cost buckets (translation = model calls; conversion = TTS, render, storage, bandwidth) and per-stage progress for a resume.';
comment on column public.topic_kits.precheck is
  'Kit Translator pre-checks (catalogue.translate_check): A = structure + equivalence + leftovers + glossary before the render, C = post-render drift/silence/overlaps. {ok, blocking[], flags[], checks[], parts[], post_render}. A check may block or flag; nothing here approves.';
comment on column public.topic_kits.supersede_reason is
  'Why THIS kit was superseded by a newer approved kit of the same topic and language: cosmetic (its translations stay visible as stale) or correction (its translations are blocked until retranslated). Set by the portal when the replacement is approved; null while current.';

-- ── 2. staged articles and items ────────────────────────────────────────────
alter table public.topic_articles drop constraint if exists topic_articles_status_check;
alter table public.topic_articles add constraint topic_articles_status_check
  check (status in ('draft','staged','in_review','approved','superseded','rejected'));

alter table public.topic_questions drop constraint if exists topic_questions_status_check;
alter table public.topic_questions add constraint topic_questions_status_check
  check (status in ('draft','staged','approved','rejected','retired'));

alter table public.topic_questions
  add column if not exists source_item_id     uuid references public.topic_questions(id) on delete set null,
  add column if not exists translation_kit_id uuid references public.topic_kits(id) on delete set null;

create unique index if not exists topic_questions_translation_uniq
  on public.topic_questions (source_item_id, translation_kit_id)
  where source_item_id is not null and translation_kit_id is not null;

comment on column public.topic_questions.source_item_id is
  'Kit Translator: the English item this one translates (inherits its pedagogical approval, D4); null for an authored item.';
comment on column public.topic_questions.translation_kit_id is
  'Kit Translator: the translated kit this item was staged for. The composer and the Kits tab select a translation''s items by this id, never by language alone; unique with source_item_id so a retranslation stages beside the live set.';

-- ── 3. the glossary (R1) ────────────────────────────────────────────────────
create table if not exists public.topic_term_translations (
  id          uuid primary key default gen_random_uuid(),
  language    text not null,
  subject     text not null default 'general',
  sense       text not null,
  term_en     text not null,
  term        text not null,
  source      text not null default 'model' check (source in ('model','reviewer')),
  topic_id    uuid references public.topics(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (language, subject, sense)
);
drop trigger if exists topic_term_translations_touch on public.topic_term_translations;
create trigger topic_term_translations_touch before update on public.topic_term_translations
  for each row execute function touch_updated_at();
alter table public.topic_term_translations enable row level security;
revoke all on public.topic_term_translations from anon, authenticated;
comment on table public.topic_term_translations is
  'Kit Translator glossary (R1): one translation of an English term per (language, subject, sense), translated FIRST and pinned as a directive for every later call of a kit. A reviewer''s row (source=reviewer) is never overwritten by a model''s. Internal: service role only.';

-- ── 4. one live kit_translate per (source kit, language) ────────────────────
create unique index if not exists jobs_one_live_translate
  on public.jobs ((params->>'source_kit_id'), (params->>'language'))
  where type = 'kit_translate' and status in ('queued', 'processing');

-- ── 5. gate 2 for a translation: the two RPCs ───────────────────────────────
create or replace function public.approve_topic_kit(p_kit uuid, p_reviewer uuid, p_notes text default null)
returns public.topic_kits
  language plpgsql security definer set search_path = public as
$$
declare
  k topic_kits%rowtype;
  t_status text;
  a_status text;
  deck_id uuid;
begin
  select * into k from topic_kits where id = p_kit for update;
  if not found then
    raise exception 'kit % not found', p_kit using errcode = 'no_data_found';
  end if;
  if k.status <> 'in_review' then
    raise exception 'kit % is %, not reviewable', p_kit, k.status using errcode = 'check_violation';
  end if;

  -- ── the TRANSLATION branch (0134) ──────────────────────────────────────
  if k.translation_status is not null then
    if k.translation_status <> 'in_review' then
      raise exception 'translation % is %, not in review', p_kit, k.translation_status using errcode = 'check_violation';
    end if;
    select status into t_status from topics where id = k.topic_id for update;
    if t_status is null or t_status = 'retired' then
      raise exception 'topic % is %; a translation of a retired topic is not approved', k.topic_id, coalesce(t_status, 'missing')
        using errcode = 'check_violation';
    end if;
    -- Storage first, then the flip: every artifact the kit will serve must
    -- already exist. The worker uploaded them before it finished each
    -- generation; a kit that reached in_review without them is a defect
    -- this refusal names, never a half-published translation.
    if k.presentation_generation_id is null
       or not exists (select 1 from artifacts a where a.generation_id = k.presentation_generation_id and a.kind = 'video_mp4') then
      raise exception 'translation % has no rendered video; nothing is approved', p_kit using errcode = 'check_violation';
    end if;
    deck_id := nullif(k.doc_generation_ids->>'deck', '')::uuid;
    if deck_id is not null
       and not exists (select 1 from artifacts a where a.generation_id = deck_id and a.kind = 'deck_pptx') then
      raise exception 'translation % names a deck with no file; nothing is approved', p_kit using errcode = 'check_violation';
    end if;
    select status into a_status from topic_articles where id = k.article_id;
    if a_status is distinct from 'staged' and a_status is distinct from 'approved' then
      raise exception 'translated article % of kit % is %, not staged', k.article_id, p_kit, coalesce(a_status, 'missing')
        using errcode = 'check_violation';
    end if;

    -- The previous translation in this language steps aside: its article
    -- version is superseded, its items retired, its kit marked stale (it
    -- stays approved; catalogue_current_kits picks the newest reviewed).
    update topic_articles set status = 'superseded'
     where topic_id = k.topic_id and language = k.language and status = 'approved' and id <> k.article_id;
    update topic_questions set status = 'retired'
     where topic_id = k.topic_id and language = k.language and status = 'approved'
       and translation_kit_id is not null and translation_kit_id <> k.id;
    update topic_kits set translation_status = 'stale'
     where topic_id = k.topic_id and language = k.language and id <> k.id
       and status = 'approved' and translation_status = 'approved';

    -- Promote the staged set — the article, the items — and the kit, as
    -- ONE transaction with the checks above.
    update topic_articles
       set status = 'approved', approved_by = p_reviewer, reviewer_id = p_reviewer, reviewed_at = now()
     where id = k.article_id and status in ('staged', 'approved');
    update topic_questions set status = 'approved'
     where translation_kit_id = k.id and status = 'staged';
    update topic_kits
       set status = 'approved', translation_status = 'approved', approved_by = p_reviewer, reviewer_id = p_reviewer,
           reviewed_at = now(), notes = coalesce(p_notes, notes), reject_reason = null
     where id = k.id
     returning * into k;

    insert into platform_audit_log (actor_id, action, target_kind, target_id, detail)
    values (p_reviewer, 'library_kit_translation_approve', 'topic', k.topic_id,
            jsonb_build_object('kit_id', k.id, 'article_id', k.article_id, 'language', k.language,
                               'source_kit_id', k.source_kit_id));
    return k;
  end if;

  -- ── the ENGLISH branch: 0115, verbatim ──────────────────────────────────
  select status into t_status from topics where id = k.topic_id for update;
  -- The topic must be the one under review: a kit Regenerate left behind at
  -- in_review while the topic went back to generating is history (see the
  -- header). Approving it would leave two approved kits on one topic.
  if t_status is distinct from 'in_review' then
    raise exception 'topic % is %, not in review — kit % is not the kit under review', k.topic_id, coalesce(t_status, 'missing'), p_kit
      using errcode = 'check_violation';
  end if;
  -- The kit's article must still be the approved version: the article is the
  -- kit's source of truth, and a superseded one is regenerated, not approved.
  select status into a_status from topic_articles where id = k.article_id;
  if a_status is distinct from 'approved' then
    raise exception 'article % of kit % is %, not the approved version — regenerate the kit', k.article_id, p_kit, coalesce(a_status, 'missing')
      using errcode = 'check_violation';
  end if;

  update topic_kits
     set status = 'approved', approved_by = p_reviewer, reviewer_id = p_reviewer,
         reviewed_at = now(), notes = coalesce(p_notes, notes), reject_reason = null
   where id = k.id
   returning * into k;

  update topics set status = 'video_approved'
   where id = k.topic_id and status = 'in_review';

  insert into platform_audit_log (actor_id, action, target_kind, target_id, detail)
  values (p_reviewer, 'library_kit_approve', 'topic', k.topic_id,
          jsonb_build_object('kit_id', k.id, 'article_id', k.article_id, 'language', k.language));
  return k;
end
$$;
revoke execute on function public.approve_topic_kit(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.approve_topic_kit(uuid, uuid, text) to service_role;

create or replace function public.reject_topic_kit(p_kit uuid, p_reviewer uuid, p_reason text, p_notes text)
returns public.topic_kits
  language plpgsql security definer set search_path = public as
$$
declare
  k topic_kits%rowtype;
  t_status text;
begin
  if p_reason is null or p_reason not in ('factual','grade_fit','pacing','visuals','pronunciation','translation','other') then
    raise exception 'a reject reason from the list is required' using errcode = 'check_violation';
  end if;
  if p_notes is null or btrim(p_notes) = '' then
    raise exception 'notes are required to reject a kit' using errcode = 'check_violation';
  end if;
  select * into k from topic_kits where id = p_kit for update;
  if not found then
    raise exception 'kit % not found', p_kit using errcode = 'no_data_found';
  end if;
  if k.status not in ('in_review', 'approved') then
    raise exception 'kit % is %, not reviewable', p_kit, k.status using errcode = 'check_violation';
  end if;

  -- ── the TRANSLATION branch (0134): the topic is not touched ────────────
  if k.translation_status is not null then
    update topic_articles set status = 'rejected', reviewer_id = p_reviewer, reviewed_at = now()
     where id = k.article_id and status = 'staged';
    update topic_questions set status = 'retired'
     where translation_kit_id = k.id and status in ('staged', 'approved');
    update topic_kits
       set status = 'rejected', translation_status = 'failed', reject_reason = p_reason, reviewer_id = p_reviewer,
           reviewed_at = now(), notes = p_notes, approved_by = null
     where id = k.id
     returning * into k;
    insert into platform_audit_log (actor_id, action, target_kind, target_id, detail)
    values (p_reviewer, 'library_kit_translation_reject', 'topic', k.topic_id,
            jsonb_build_object('kit_id', k.id, 'article_id', k.article_id, 'language', k.language,
                               'source_kit_id', k.source_kit_id, 'reason', p_reason));
    return k;
  end if;

  -- ── the ENGLISH branch: 0115, verbatim ──────────────────────────────────
  select status into t_status from topics where id = k.topic_id for update;
  -- A reviewable kit puts its topic in review (kit in_review) or video
  -- approved (kit approved); anywhere else the kit is history or the topic
  -- has moved on (published: unpublish first), and nothing is rejected.
  if t_status is distinct from 'in_review' and t_status is distinct from 'video_approved' then
    raise exception 'topic % is %, not in review or video approved — kit % is not reviewed', k.topic_id, coalesce(t_status, 'missing'), p_kit
      using errcode = 'check_violation';
  end if;

  update topic_kits
     set status = 'rejected', reject_reason = p_reason, reviewer_id = p_reviewer,
         reviewed_at = now(), notes = p_notes, approved_by = null
   where id = k.id
   returning * into k;

  -- A pulled approval reopens review; a kit rejected while still in review
  -- leaves the topic in review (the portal's Regenerate kit moves it on).
  update topics set status = 'in_review'
   where id = k.topic_id and status = 'video_approved';

  insert into platform_audit_log (actor_id, action, target_kind, target_id, detail)
  values (p_reviewer, 'library_kit_reject', 'topic', k.topic_id,
          jsonb_build_object('kit_id', k.id, 'article_id', k.article_id, 'language', k.language, 'reason', p_reason));
  return k;
end
$$;
revoke execute on function public.reject_topic_kit(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.reject_topic_kit(uuid, uuid, text, text) to service_role;

-- ── 6. the visibility rule ──────────────────────────────────────────────────
create or replace function public.catalogue_current_kits()
returns table (
  topic_id     uuid,
  language     text,
  topic_kit_id uuid,
  article_id   uuid,
  approved_at  timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (k.topic_id, k.language)
         k.topic_id, k.language, k.id, k.article_id,
         coalesce(k.reviewed_at, k.updated_at, k.created_at)
  from topic_kits k
  join topics t on t.id = k.topic_id
  where k.status = 'approved'
    and t.status <> 'retired'
    and t.bank_maturity <> 'none'
    and (
      -- English: the kit's own video is public on YouTube (0128)
      (k.language = 'en' and exists (
        select 1 from topic_publications p
        where p.topic_kit_id = k.id
          and p.superseded_by is null
          and p.privacy = 'public'
          and p.youtube_video_id is not null))
      -- a translation (0134, D5): approved is visible; stale stays; blocked hides
      or (k.language <> 'en' and coalesce(k.translation_status, 'approved') in ('approved', 'stale'))
    )
  -- a current translation beats a stale one whatever their review times
  -- (two approvals in one transaction share now()); English rows all read
  -- null here, so the term is inert for them
  order by k.topic_id, k.language,
           (k.translation_status is distinct from 'approved') asc,
           coalesce(k.reviewed_at, k.updated_at, k.created_at) desc,
           k.created_at desc, k.id desc
$$;

comment on function public.catalogue_current_kits() is
  'The catalogue visibility rule in one place: one row per (topic, language). English — the most recently approved kit whose own video is public on YouTube (0128). A translation (0134) — the most recently approved kit whose translation_status is approved or stale; blocked is hidden. Non-retired topic, approved bank. Internal: service role and the catalogue functions only.';

commit;
