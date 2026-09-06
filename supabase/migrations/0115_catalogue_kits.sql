-- 0115_catalogue_kits
--
-- Phase 3 of the topic-catalogue plan (founder, 2026-09-06): the kit. A kit
-- is FIVE ordinary generations rows — presentation, activity, case_study,
-- worksheet, deck — owned by the catalogue system account with book_id and
-- chapter_ref NULL and `params.catalogue = true` (0112 exempts such a row from
-- dedup, the caps and the ledger), plus a lesson_plan the WORKER inserts after
-- the presentation finishes (it cites the clips). The 0112 topic_kits row ties
-- them together; the question bank is filled by a new observer job.
--
-- WHAT IT DOES, AND WHY EACH PIECE
--   1. jobs_one_live_questions — one live `topic_questions` job per (topic,
--      language). The kit route enqueues one automatically when a kit is made
--      and the questions page enqueues one on demand; both check-then-insert,
--      which is racy on its own — the partial unique index is the rule the
--      database enforces, exactly like 0112's harvest, 0113's derive and 0114's
--      article / figure_render indexes. The routes map its 23505 to "the bank
--      job already runs" (kit route: ignored; questions route: 409).
--   2. topic_kits.part_plan — the worker's per-part plan
--      [{part, sections: [...], minutes}] (plan §1.4): which article sections
--      each video part teaches and how long it runs. chapters (timestamps)
--      and clips already exist on the row (0112); the plan is what the portal
--      shows above them and what bounds a human's clip edits.
--   3. create_job_for_generation() — the trigger body is the live prod body
--      (pg_get_functiondef, 2026-09-06; equal to 0001's) with ONE addition:
--      when the new generation carries params.catalogue = 'true', the job row
--      gets {"catalogue": true, "topic_id", "kit_id", "question_set_id"} in
--      jobs.params (0113). That is how the worker RECOGNISES a catalogue job
--      without joining generations on every claim: its user lanes filter
--      `params->>'catalogue' is null or <> 'true'`, and a last lane claims the
--      flagged jobs only when no user builder is live and the off-peak window
--      is open (CATALOGUE_WINDOW_UTC). Vertex image capacity is ~1 image/min
--      per pool, so a catalogue batch in users' hours is an image OUTAGE for
--      paying teachers (2026-09-05 incident) — never-starve is a database
--      fact here, not a worker convention. A row without the flag gets the
--      byte-identical insert it always did.
--   4. approve_topic_kit / reject_topic_kit — plan §1.3 gate 2 ("human
--      approval before YouTube"). Like approve_topic_article (0112) these are
--      the ONLY writers of topic_kits.status = 'approved' / 'rejected': lock
--      the kit, refuse when it is not in an accepting status
--      (check_violation, 23514) or missing (no_data_found, P0002), lock the
--      topic, write the verdict with the reviewer's id and time, move the
--      topic (approve: in_review → video_approved; reject: video_approved →
--      in_review, so a pulled approval reopens review), and audit — in ONE
--      transaction, because PostgREST cannot open one and two reviewers racing
--      must not leave a kit approved with its topic still in review. No route
--      writes those statuses itself (catalogue-routes.test.ts asserts it).
--      Reject REQUIRES a reason from the 0112 list and notes: a rejection with
--      no "why" cannot steer the regeneration (plan §1.7).
--      Both RPCs also check the TOPIC's status (approve: in_review; reject:
--      in_review or video_approved) and approve checks that the kit's ARTICLE
--      is still the approved version. Without the topic check the kit that
--      Regenerate leaves behind at in_review (the topic already back at
--      generating) stays approvable, and a topic ends with TWO approved kits
--      and Phase 4 has no rule for which is THE kit; without the article
--      check a kit built from v1 can be approved after v2 supersedes it, and
--      the video teaches text nobody approved any more (the article is the
--      kit's source of truth, plan §1.7). The kit route mirrors the three
--      checks (kit.ts kitAcceptsApprove / kitAcceptsReject) so the panel's
--      disabled button and the 409 say the same sentence.
--   5. repoint_kit_generation — the portal's Retry re-inserts one failed piece
--      and must point the kit at the new row. A read-modify-write of
--      doc_generation_ids from the route (read at the top of the request,
--      written at the end) races the worker's own read-modify-write in
--      catalogue/kit.py insert_lesson_plan: the worker merges the lesson_plan
--      id in between, the route writes {…stale, worksheet: new} and the
--      lesson_plan pointer is gone — it builds as an orphan, the kit never
--      completes and the only recovery is a full Regenerate (another video's
--      worth of image quota). Here the merge is ONE statement — jsonb `||`
--      cannot lose a sibling key — and a compare-and-swap: p_replaces must be
--      what the kit currently points at for that kind, else check_violation,
--      so a pointer somebody else moved is never overwritten. The worker is
--      invited to call it too (a follow-up in the worker repo); until then its
--      window is a few milliseconds once per kit, the route's is closed.
--
-- TRIGGER AUDIT for a catalogue generations row (from 0112's header, restated
-- because this is the migration that starts inserting them): duplicate_guard,
-- fair_use_cap and credit_ledger_write return early on the flag (guard: only a
-- service-role insert for a platform-admin owner may carry it, else 42501 —
-- the kit route answers "the catalogue owner is not a platform admin");
-- beta_generation_cap passes (book_id, chapter_ref) = (NULL, NULL) as one
-- tuple; enforce_lesson_tools returns for a writer that is not the owner;
-- on_generation_ledger_used is a no-op with book_id NULL; credit_ledger_sync
-- updates zero ledger rows; on_generation_created is WANTED — it is the
-- trigger this migration teaches to copy the flag. No trigger is redefined
-- here except create_job_for_generation.
--
-- WHAT IT DOES NOT DO
--   No new table, no policy, no enum change, no change to existing rows. Does
--   not touch topics.status's check list (generating / in_review /
--   video_approved already exist) nor topic_kits' constraints.
--
-- ROLLBACK: drop index jobs_one_live_questions; alter table topic_kits drop
-- column part_plan; re-run 0001's create_job_for_generation body; drop
-- function approve_topic_kit(uuid, uuid, text),
-- reject_topic_kit(uuid, uuid, text, text) and
-- repoint_kit_generation(uuid, text, uuid, uuid).

begin;

-- ── 1. One live question-bank job per (topic, language) ──────────────────────
create unique index if not exists jobs_one_live_questions
  on public.jobs ((params->>'topic_id'), (coalesce(params->>'language', 'en')))
  where type = 'topic_questions' and status in ('queued', 'processing');

-- ── 2. The per-part plan ─────────────────────────────────────────────────────
alter table public.topic_kits add column if not exists part_plan jsonb not null default '[]'::jsonb;

-- ── 3. The generation → job trigger copies the catalogue flag ────────────────
-- Body of 0001 (== prod), plus the flagged branch. `jsonb_strip_nulls` drops
-- the keys a row does not carry (a composed worksheet has question_set_id and
-- no kit_id; a kit piece the reverse), so jobs.params holds only facts.
create or replace function public.create_job_for_generation() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  if coalesce(new.params->>'catalogue', '') = 'true' then
    insert into jobs (generation_id, type, status, params)
    values (new.id, new.kind::text, 'queued',
            jsonb_strip_nulls(jsonb_build_object(
              'catalogue', true,
              'topic_id', new.params->'topic_id',
              'kit_id', new.params->'kit_id',
              'question_set_id', new.params->'question_set_id')));
    return new;
  end if;
  insert into jobs (generation_id, type, status) values (new.id, new.kind::text, 'queued');
  return new;
end
$$;

-- ── 4. Gate 2: approving and rejecting a kit is ONE transaction each ─────────
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
          jsonb_build_object('kit_id', k.id, 'article_id', k.article_id, 'language', k.language,
                             'reason', p_reason, 'notes', p_notes));
  return k;
end
$$;
revoke execute on function public.reject_topic_kit(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.reject_topic_kit(uuid, uuid, text, text) to service_role;

-- ── 5. Repointing a kit at a retried piece is ONE merged statement ───────────
-- p_kind 'presentation' sets presentation_generation_id; any other kind merges
-- {p_kind: p_generation} into doc_generation_ids with jsonb `||`, which keeps
-- every sibling key whatever another writer added since the caller read the
-- row. p_replaces is the compare-and-swap: the kit must still point at it for
-- that kind (a kind with no pointer yet passes null), else check_violation —
-- a pointer moved by somebody else is reported, never overwritten. The kit
-- must be generating: the route reopens it first, and a kit past review is
-- not repointed. Returns the row as written.
create or replace function public.repoint_kit_generation(p_kit uuid, p_kind text, p_generation uuid, p_replaces uuid default null)
returns public.topic_kits
  language plpgsql security definer set search_path = public as
$$
declare
  k topic_kits%rowtype;
  current_id uuid;
begin
  if p_kind is null or btrim(p_kind) = '' then
    raise exception 'a generation kind is required' using errcode = 'check_violation';
  end if;
  if p_generation is null then
    raise exception 'a generation id is required' using errcode = 'check_violation';
  end if;
  select * into k from topic_kits where id = p_kit for update;
  if not found then
    raise exception 'kit % not found', p_kit using errcode = 'no_data_found';
  end if;
  if k.status <> 'generating' then
    raise exception 'kit % is %, not generating — nothing is repointed', p_kit, k.status using errcode = 'check_violation';
  end if;
  if p_kind = 'presentation' then
    current_id := k.presentation_generation_id;
  else
    current_id := nullif(coalesce(k.doc_generation_ids, '{}'::jsonb) ->> p_kind, '')::uuid;
  end if;
  if current_id is distinct from p_replaces then
    raise exception 'kit % points its % at %, not % — the pointer moved; nothing is repointed', p_kit, p_kind, coalesce(current_id::text, 'nothing'), coalesce(p_replaces::text, 'nothing')
      using errcode = 'check_violation';
  end if;

  if p_kind = 'presentation' then
    update topic_kits set presentation_generation_id = p_generation where id = k.id returning * into k;
  else
    update topic_kits
       set doc_generation_ids = coalesce(doc_generation_ids, '{}'::jsonb) || jsonb_build_object(p_kind, p_generation::text)
     where id = k.id
     returning * into k;
  end if;
  return k;
end
$$;
revoke execute on function public.repoint_kit_generation(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.repoint_kit_generation(uuid, text, uuid, uuid) to service_role;

commit;
