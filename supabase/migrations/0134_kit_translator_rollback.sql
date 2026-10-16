-- SketchCast AI — rollback of 0134 (Kit Translator). Run only when no
-- translated kit exists (a translation_status that is not null, a staged
-- article or item): the check constraints below would otherwise refuse.
-- Restores 0115's two RPCs and 0128's catalogue_current_kits() verbatim.
begin;

drop index if exists public.jobs_one_live_translate;
drop table if exists public.topic_term_translations;

drop index if exists public.topic_questions_translation_uniq;
alter table public.topic_questions drop column if exists translation_kit_id;
alter table public.topic_questions drop column if exists source_item_id;
alter table public.topic_questions drop constraint if exists topic_questions_status_check;
alter table public.topic_questions add constraint topic_questions_status_check
  check (status in ('draft','approved','rejected','retired'));

alter table public.topic_articles drop constraint if exists topic_articles_status_check;
alter table public.topic_articles add constraint topic_articles_status_check
  check (status in ('draft','in_review','approved','superseded','rejected'));

drop index if exists public.topic_kits_translations_idx;
alter table public.topic_kits drop constraint if exists topic_kits_translation_status_check;
alter table public.topic_kits drop constraint if exists topic_kits_supersede_reason_check;
alter table public.topic_kits
  drop column if exists translation_status,
  drop column if exists translation,
  drop column if exists precheck,
  drop column if exists supersede_reason;

-- 0115's approve_topic_kit
create or replace function public.approve_topic_kit(p_kit uuid, p_reviewer uuid, p_notes text default null)
returns public.topic_kits
  language plpgsql security definer set search_path = public as
$$
declare
  k topic_kits%rowtype;
  t_status text;
  a_status text;
begin
  select * into k from topic_kits where id = p_kit for update;
  if not found then
    raise exception 'kit % not found', p_kit using errcode = 'no_data_found';
  end if;
  if k.status <> 'in_review' then
    raise exception 'kit % is %, not reviewable', p_kit, k.status using errcode = 'check_violation';
  end if;
  select status into t_status from topics where id = k.topic_id for update;
  if t_status is distinct from 'in_review' then
    raise exception 'topic % is %, not in review — kit % is not the kit under review', k.topic_id, coalesce(t_status, 'missing'), p_kit
      using errcode = 'check_violation';
  end if;
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

-- 0115's reject_topic_kit
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
  select status into t_status from topics where id = k.topic_id for update;
  if t_status is distinct from 'in_review' and t_status is distinct from 'video_approved' then
    raise exception 'topic % is %, not in review or video approved — kit % is not reviewed', k.topic_id, coalesce(t_status, 'missing'), p_kit
      using errcode = 'check_violation';
  end if;

  update topic_kits
     set status = 'rejected', reject_reason = p_reason, reviewer_id = p_reviewer,
         reviewed_at = now(), notes = p_notes, approved_by = null
   where id = k.id
   returning * into k;

  update topics set status = 'in_review'
   where id = k.topic_id and status = 'video_approved';

  insert into platform_audit_log (actor_id, action, target_kind, target_id, detail)
  values (p_reviewer, 'library_kit_reject', 'topic', k.topic_id,
          jsonb_build_object('kit_id', k.id, 'article_id', k.article_id, 'language', k.language, 'reason', p_reason));
  return k;
end
$$;

-- 0128's catalogue_current_kits()
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
    and exists (
      select 1 from topic_publications p
      where p.topic_kit_id = k.id
        and p.superseded_by is null
        and p.privacy = 'public'
        and p.youtube_video_id is not null)
  order by k.topic_id, k.language,
           coalesce(k.reviewed_at, k.updated_at, k.created_at) desc,
           k.created_at desc, k.id desc
$$;

commit;
