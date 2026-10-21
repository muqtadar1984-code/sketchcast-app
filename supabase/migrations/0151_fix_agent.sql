-- SketchCast AI — 0151: the Fix Agent's cases (Phase 1: failed translations)
-- ============================================================================
-- Fix Agent plan, Revision 3 (founder, 2026-10-21): "if there is a fail it
-- prepares a course of action and once i approve it applies the fix and hands
-- it back to translation agent to pick it up."
--
--   fix_cases          one row per problem the agent works on, and one card on
--                      Library → Fixes. new → diagnosing → proposed → (founder)
--                      approved | rejected → applied (its retry job exists) →
--                      resolved (the kit reached review) | needs_founder (two
--                      rounds used, or the agent cannot propose). A failed retry
--                      starts round 2 on the SAME row (its first round is kept
--                      in `history`).
--   fix_case_enqueue   queues an APPROVED case's retry: one kit_translate job
--                      carrying the approved note and waivers, under the same
--                      lock and lane rule as auto_translate_enqueue (0147), so a
--                      fix and the Auto Translate Agent never run two
--                      translations at once. Sets applied_job_id in the same
--                      transaction, so a re-tick or restart cannot queue twice.
--
-- The worker (sketchcast-ai catalogue/fix_agent.py) detects, diagnoses,
-- proposes and applies; the Library writes only the founder's decision
-- (proposed → approved | rejected). Nothing here approves a kit or deploys
-- code. Service role only: RLS on, no policies. Seeded OFF.
-- ============================================================================

begin;

create table if not exists public.fix_cases (
  id              uuid        primary key default gen_random_uuid(),
  kind            text        not null check (kind in ('translation_failure', 'english_failure', 'enhancement')),
  component       text        not null,                 -- the job type it concerns: 'kit_translate' (Phase 1)
  status          text        not null default 'new'
                              check (status in ('new', 'diagnosing', 'proposed', 'approved', 'applied',
                                                'resolved', 'rejected', 'needs_founder')),
  round           integer     not null default 1 check (round between 1 and 2),
  topic_id        uuid        references public.topics(id) on delete cascade,
  source_kit_id   uuid        references public.topic_kits(id) on delete cascade,
  language        text,
  title           text        not null,
  issue           text,                                 -- what failed, in a line (the job's error)
  source_job_id   uuid        references public.jobs(id) on delete set null,   -- the failed job this round diagnoses
  evidence        jsonb       not null default '{}'::jsonb,   -- findings with English beside the translation
  diagnosis       jsonb       not null default '{}'::jsonb,   -- classification, explanation, per-finding verdicts
  proposal        jsonb       not null default '{}'::jsonb,   -- actions, note, waivers, rule suggestion, blast radius, cost
  risk            text        not null default 'low' check (risk in ('low', 'sensitive')),
  decided_by      uuid        references public.profiles(id) on delete set null,
  decided_at      timestamptz,
  decision_note   text,
  applied_job_id  uuid        references public.jobs(id) on delete set null,
  applied_at      timestamptz,
  outcome         jsonb       not null default '{}'::jsonb,   -- kit id and state the retry reached
  history         jsonb       not null default '[]'::jsonb,   -- earlier rounds, whole
  cost_usd        numeric(10, 4) not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

-- one open case per (component, source kit, language): a second failure of the
-- same pair joins the open case instead of opening another
create unique index if not exists fix_cases_one_open
  on public.fix_cases (component, source_kit_id, language)
  where status not in ('resolved', 'rejected', 'needs_founder');
create index if not exists fix_cases_status on public.fix_cases (status, created_at);
create index if not exists fix_cases_source_job on public.fix_cases (source_job_id);
create index if not exists fix_cases_applied_job on public.fix_cases (applied_job_id);

comment on table public.fix_cases is
  'The Fix Agent''s cases: a failure (or, later, a requested enhancement), its diagnosis, the proposed fix, the founder''s decision and the retry''s outcome. One card each on Library → Fixes (0151).';

alter table public.fix_cases enable row level security;

-- ── queue an approved case's retry ─────────────────────────────────────────
create or replace function public.fix_case_enqueue(p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c   public.fix_cases%rowtype;
  v_job uuid;
begin
  -- the Auto Translate Agent's lock (0147): one translation at a time, whoever queues it
  perform pg_advisory_xact_lock(hashtext('auto_translate'));
  select * into v_c from public.fix_cases where id = p_case_id for update;
  if not found then
    return jsonb_build_object('queued', false, 'why', 'not_found');
  end if;
  if v_c.status <> 'approved' then
    return jsonb_build_object('queued', false, 'why', 'status_' || v_c.status);
  end if;
  if v_c.applied_job_id is not null then
    return jsonb_build_object('queued', false, 'why', 'already_applied', 'job_id', v_c.applied_job_id);
  end if;
  if v_c.component <> 'kit_translate' or v_c.source_kit_id is null or coalesce(v_c.language, '') = '' then
    return jsonb_build_object('queued', false, 'why', 'unsupported');
  end if;
  if exists (select 1 from jobs j where j.type = 'kit_translate' and j.status in ('queued', 'processing')) then
    return jsonb_build_object('queued', false, 'why', 'translation_in_flight');
  end if;
  if exists (select 1 from topic_kits k where k.status = 'generating' and coalesce(k.language, 'en') <> 'en') then
    return jsonb_build_object('queued', false, 'why', 'translated_kit_rendering');
  end if;

  insert into jobs (type, status, book_id, generation_id, params)
  values ('kit_translate', 'queued', null, null,
          jsonb_strip_nulls(jsonb_build_object(
            'source_kit_id', v_c.source_kit_id, 'topic_id', v_c.topic_id, 'language', v_c.language,
            'fix_case_id', v_c.id, 'fix_round', v_c.round,
            'fix_note', nullif(v_c.proposal ->> 'note', ''),
            'waivers', case when jsonb_typeof(v_c.proposal -> 'waivers') = 'array'
                              and jsonb_array_length(v_c.proposal -> 'waivers') > 0
                            then v_c.proposal -> 'waivers' end)))
  returning id into v_job;

  update public.fix_cases
     set status = 'applied', applied_job_id = v_job, applied_at = now(), updated_at = now()
   where id = v_c.id;

  insert into platform_audit_log (actor_id, action, target_kind, target_id, detail)
  values (v_c.decided_by, 'fix_case_apply', 'fix_case', v_c.id,
          jsonb_build_object('job_id', v_job, 'source_kit_id', v_c.source_kit_id, 'language', v_c.language,
                             'round', v_c.round, 'actions', v_c.proposal -> 'actions'));

  return jsonb_build_object('queued', true, 'job_id', v_job, 'case_id', v_c.id);
end $$;

revoke all on function public.fix_case_enqueue(uuid) from public, anon, authenticated;
grant execute on function public.fix_case_enqueue(uuid) to service_role;

-- the founder's switch, read by the worker every tick; OFF until switched on
insert into public.platform_settings (key, value, updated_at)
values ('fix_agent', jsonb_build_object('enabled', false,
                                        'summary_email', 'muqtadar.quraishi@sketchcast.app'), now())
on conflict (key) do nothing;

commit;
