-- 0145 — Jawi follows Malay (Kit Translator plan §5.11, 2026-10-19).
--
-- A Jawi (ms-arab) kit is DERIVED from the topic's approved Malay
-- translation: its source_kit_id is the Malay kit (worker catalogue/jawi.py,
-- app kit route `translate`). The English supersede cascade already runs
-- through it (worker catalogue/supersede.cascade_translations walks
-- source_kit_id hop by hop). This migration covers the two ways a MALAY kit
-- leaves service inside the database:
--
--   approve_topic_kit  a newer Malay translation is approved: the previous
--                      Malay kit goes stale (0134) — and now so does every
--                      approved kit derived from it (the Jawi kit);
--   reject_topic_kit   an approved Malay kit is pulled: every approved kit
--                      derived from it is blocked.
--
-- Both functions are the LIVE definitions (pg_get_functiondef, 2026-10-19;
-- identical to 0134) with one statement added each. Rollback:
-- 0145_jawi_follows_malay_rollback.sql restores them verbatim.

begin;

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
    -- 0145: a kit DERIVED from a translation that has stepped aside — Jawi
    -- from Malay (plan §5.11: its source_kit_id is the Malay kit) — steps
    -- aside with it: stale, re-derived from the new Malay kit when wanted.
    update topic_kits d set translation_status = 'stale'
      from topic_kits s
     where d.source_kit_id = s.id
       and s.topic_id = k.topic_id and s.language = k.language and s.id <> k.id
       and s.translation_status = 'stale'
       and d.status = 'approved' and d.translation_status = 'approved';

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
    -- 0145: a pulled translation takes the kits DERIVED from it with it — a
    -- Jawi kit made from this Malay kit (plan §5.11) is blocked until it is
    -- re-derived from an approved Malay kit.
    update topic_kits set translation_status = 'blocked'
     where source_kit_id = k.id and status = 'approved' and translation_status = 'approved';
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

commit;
