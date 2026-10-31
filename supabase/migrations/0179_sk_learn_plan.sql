-- SketchCast AI — 0179: concept tags, the recommended plan and SK's focus
-- (SK student Board plan 2026-10-31, phase 4 "Mastery and the recommended plan")
-- ============================================================================
-- Phase 2 (0178) keeps every worksheet attempt. Phase 4 turns them into a
-- mastery score per concept per student, and a short RECOMMENDED PLAN that a
-- grown-up approves before it changes anything:
--   * a school student's plan is approved by her CLASS TEACHER (the parent
--     reads it, read-only);
--   * a home student's plan (no class — parent-managed) is approved by her
--     PARENT.
-- Approved, the plan becomes her next sessions: its practice / next-topic
-- items are ASSIGNED (generation_shares — the same rows the Library and SK's
-- `assign` write, so they show in My lessons and on her student Board), and
-- its re-teach concepts become SK's FOCUS for her (sk_learn_focus).
--
-- MASTERY IS NOT STORED. It is computed on read from sk_practice_attempts
-- (src/sk/practice/mastery.ts, rule sk-learn.1): the attempts are the record,
-- the rule is pure and versioned, and a class's rows are small. A plan keeps
-- the SNAPSHOT its reasons rest on (sk_learn_plans.mastery), so an approver
-- sees what SK saw.
--
-- The three tables:
--
--   sk_practice_concepts  the CACHE of concept tags: which concept of the
--                         kit's lesson map (sk_manifests concepts) a worksheet
--                         question tests. One row per question × question_hash
--                         (the question + its key, as sk_practice_help), so a
--                         re-generated paper is re-tagged. method = paper (the
--                         paper names it), manifest (the lesson map already
--                         mapped it), model (Haiku 5.5, one call per worksheet).
--                         A kit-level fallback is never cached.
--   sk_learn_plans        one recommended plan: whose, for which kit (null =
--                         the weekly plan), who approves it (teacher + class,
--                         or parent), its items (re-teach / practice / next),
--                         its status
--                             draft → pending_approval → approved | declined
--                         (and superseded, when a newer weekly plan replaces
--                         an open one), who decided, and what approval
--                         created (applied).
--   sk_learn_focus        the concepts SK should teach her next, per kit, from
--                         an approved plan, until a date. SK's learner turns
--                         read them (src/sk/practice/focus.ts).
--
-- WRITES. Service role only for the tags and the drafts (the practice route
-- and the weekly cron). The approver's decision goes through ONE function,
-- sk_learn_plan_decide(), security definer, which checks the caller IS the
-- plan's approver (the class teacher of plan.class_id with the student
-- enrolled in it; or a linked parent of a home student), and on approve writes
-- the shares, the focus rows and the plan's new status in one transaction.
-- An edit before approval may reword or drop items; it can never add a kit
-- or a concept that SK did not propose.
--
-- READS (RLS):
--   sk_practice_concepts  whoever can read an attempt on that question (the
--                         policy reads sk_practice_attempts under the
--                         caller's own RLS: the student, her teachers, her
--                         parent, the school admin / coordinator slice);
--   sk_learn_plans        the student: her APPROVED plans only; her teachers
--                         (teaches_student) and her linked parent: all of
--                         hers; the school admin: plans of her school's
--                         students;
--   sk_learn_focus        the student, her teachers, her parent.
--
-- Additive only; rollback = 0179_sk_learn_plan_rollback.sql.
-- Verification: supabase/tests/0179_sk_learn_plan_test.sql.
-- NOT APPLIED — a founder approval, like every migration. Requires 0178.
-- ============================================================================

begin;

-- ── 1. concept tags (cache) ──────────────────────────────────────────────────
create table if not exists public.sk_practice_concepts (
  generation_id  uuid        not null references public.generations(id) on delete cascade,  -- the worksheet
  question_id    text        not null check (char_length(question_id) between 1 and 80),
  question_hash  text        not null check (char_length(question_hash) = 64),
  concept_key    text        not null check (char_length(concept_key) between 1 and 120),   -- the manifest concept_id, or "p:<slug>" for a paper-named concept
  concept_name   text        not null check (char_length(concept_name) between 1 and 200),
  method         text        not null check (method in ('paper', 'manifest', 'model')),
  model          text,
  cost_usd       numeric(10,6) not null default 0 check (cost_usd >= 0),
  created_at     timestamptz not null default now(),
  primary key (generation_id, question_id, question_hash)
);
create index if not exists sk_practice_concepts_q_idx
  on public.sk_practice_concepts (generation_id, question_id, created_at desc);

-- ── 2. recommended plans ─────────────────────────────────────────────────────
create table if not exists public.sk_learn_plans (
  id             uuid        primary key default gen_random_uuid(),
  student_id     uuid        not null references public.profiles(id) on delete cascade,
  kit_id         uuid        references public.generations(id) on delete set null,  -- the kit she finished; null = the weekly plan
  trigger        text        not null check (trigger in ('kit_done', 'weekly')),
  approver_role  text        not null check (approver_role in ('teacher', 'parent')),
  class_id       uuid        references public.classes(id) on delete set null,      -- teacher plans: the class whose teacher approves
  approver_id    uuid        references public.profiles(id) on delete set null,     -- who was asked (informational; the function re-checks)
  status         text        not null default 'draft'
                 check (status in ('draft', 'pending_approval', 'approved', 'declined', 'superseded')),
  summary        text        check (summary is null or char_length(summary) <= 600),
  items          jsonb       not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  mastery        jsonb       not null default '[]'::jsonb,                           -- the snapshot the reasons rest on
  model          text,
  cost_usd       numeric(10,6) not null default 0 check (cost_usd >= 0),
  edited         boolean     not null default false,
  decided_by     uuid        references public.profiles(id) on delete set null,
  decided_role   text        check (decided_role is null or decided_role in ('teacher', 'parent')),
  decided_at     timestamptz,
  decline_note   text        check (decline_note is null or char_length(decline_note) <= 500),
  applied        jsonb,                                                              -- what approval created: shares, focus, whole_class
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check ((status in ('approved', 'declined')) = (decided_at is not null))
);
-- One OPEN plan per student per kit (the weekly plan is the kit-less one).
create unique index if not exists sk_learn_plans_one_open
  on public.sk_learn_plans (student_id, coalesce(kit_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status in ('draft', 'pending_approval');
create index if not exists sk_learn_plans_student_idx on public.sk_learn_plans (student_id, created_at desc);
create index if not exists sk_learn_plans_class_idx   on public.sk_learn_plans (class_id, status);

-- ── 3. SK's focus concepts (from approved plans) ─────────────────────────────
create table if not exists public.sk_learn_focus (
  student_id    uuid        not null references public.profiles(id) on delete cascade,
  kit_id        uuid        not null references public.generations(id) on delete cascade,
  concept_key   text        not null check (char_length(concept_key) between 1 and 120),
  concept_name  text        not null check (char_length(concept_name) between 1 and 200),
  plan_id       uuid        references public.sk_learn_plans(id) on delete cascade,
  until         timestamptz not null,
  created_at    timestamptz not null default now(),
  primary key (student_id, kit_id, concept_key)
);
create index if not exists sk_learn_focus_student_idx on public.sk_learn_focus (student_id, until desc);

-- ── 4. access ────────────────────────────────────────────────────────────────
alter table public.sk_practice_concepts enable row level security;
alter table public.sk_learn_plans       enable row level security;
alter table public.sk_learn_focus       enable row level security;

revoke all on public.sk_practice_concepts from anon, authenticated;
revoke all on public.sk_learn_plans       from anon, authenticated;
revoke all on public.sk_learn_focus       from anon, authenticated;
grant select on public.sk_practice_concepts to authenticated;
grant select on public.sk_learn_plans       to authenticated;
grant select on public.sk_learn_focus       to authenticated;

drop policy if exists sk_practice_concepts_read on public.sk_practice_concepts;
create policy sk_practice_concepts_read on public.sk_practice_concepts
  for select to authenticated
  using (exists (select 1 from public.sk_practice_attempts a
                  where a.generation_id = sk_practice_concepts.generation_id
                    and a.question_id   = sk_practice_concepts.question_id));

drop policy if exists sk_learn_plans_student_read on public.sk_learn_plans;
create policy sk_learn_plans_student_read on public.sk_learn_plans
  for select to authenticated using (student_id = auth.uid() and status = 'approved');
drop policy if exists sk_learn_plans_teacher_read on public.sk_learn_plans;
create policy sk_learn_plans_teacher_read on public.sk_learn_plans
  for select to authenticated using (teaches_student(student_id));
drop policy if exists sk_learn_plans_parent_read on public.sk_learn_plans;
create policy sk_learn_plans_parent_read on public.sk_learn_plans
  for select to authenticated using (is_parent_of(student_id));
drop policy if exists sk_learn_plans_admin_read on public.sk_learn_plans;
create policy sk_learn_plans_admin_read on public.sk_learn_plans
  for select to authenticated using (admin_school_student(student_id));

drop policy if exists sk_learn_focus_read on public.sk_learn_focus;
create policy sk_learn_focus_read on public.sk_learn_focus
  for select to authenticated
  using (student_id = auth.uid() or teaches_student(student_id) or is_parent_of(student_id));

-- ── 5. the decision: approve / decline / edit ────────────────────────────────
-- sk_learn_plan_decide(plan, decision, items, whole_class, note)
--   decision  'approve' | 'decline' | 'edit'
--   items     null = keep SK's items; else the edited list (reworded / fewer).
--             Every item must be one SK proposed: same kind, and the same
--             generation_id / kit_id / concept_key as one of the plan's items.
--   whole_class  teacher plans only: assign to the class and focus every
--             enrolled student, not just her.
-- Returns jsonb {outcome: done | refused | not_found, reason?, status?, applied?}.
create or replace function public.sk_learn_plan_decide(
  p_plan        uuid,
  p_decision    text,
  p_items       jsonb   default null,
  p_whole_class boolean default false,
  p_note        text    default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  p          public.sk_learn_plans%rowtype;
  v_items    jsonb;
  v_edited   boolean;
  it         jsonb;
  orig       jsonb;
  v_ok       boolean;
  v_gen      uuid;
  v_kit      uuid;
  v_share    uuid;
  v_shares   jsonb := '[]'::jsonb;
  v_already  jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_focus    int := 0;
  v_targets  uuid[];
  v_until    timestamptz := now() + interval '14 days';
  v_title    text;
  v_reason   text;
begin
  if v_uid is null then
    return jsonb_build_object('outcome', 'refused', 'reason', 'not_signed_in');
  end if;
  select * into p from public.sk_learn_plans where id = p_plan for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if p_decision is null or p_decision not in ('approve', 'decline', 'edit') then
    return jsonb_build_object('outcome', 'refused', 'reason', 'bad_decision');
  end if;
  if p.status <> 'pending_approval' then
    return jsonb_build_object('outcome', 'refused', 'reason', 'not_pending', 'status', p.status);
  end if;

  -- The approver: the class teacher (student enrolled in that class), or a
  -- linked parent of a home student. Nobody else — not another teacher of
  -- hers, not the parent of a school student (read-only), not the student.
  if p.approver_role = 'teacher' then
    v_ok := p.class_id is not null and exists (
      select 1 from public.classes c join public.enrollments e on e.class_id = c.id
       where c.id = p.class_id and c.teacher_id = v_uid and e.student_id = p.student_id);
  else
    v_ok := exists (select 1 from public.parent_links l where l.parent_id = v_uid and l.child_id = p.student_id);
  end if;
  if not v_ok then
    return jsonb_build_object('outcome', 'refused', 'reason', 'not_approver');
  end if;
  if coalesce(p_whole_class, false) and p.approver_role <> 'teacher' then
    return jsonb_build_object('outcome', 'refused', 'reason', 'whole_class_teacher_only');
  end if;

  -- Items: SK's, or an edit of them (reworded / fewer — never a new kit or concept).
  v_items := p.items;
  v_edited := p.edited;
  if p_items is not null then
    if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 8 then
      return jsonb_build_object('outcome', 'refused', 'reason', 'bad_items');
    end if;
    v_items := '[]'::jsonb;
    for it in select * from jsonb_array_elements(p_items) loop
      if jsonb_typeof(it) <> 'object' or coalesce(it->>'kind', '') not in ('reteach', 'practice', 'next') then
        return jsonb_build_object('outcome', 'refused', 'reason', 'bad_items');
      end if;
      v_title  := btrim(coalesce(it->>'title', ''));
      v_reason := btrim(coalesce(it->>'reason', ''));
      if char_length(v_title) < 1 or char_length(v_title) > 160 or char_length(v_reason) > 300 then
        return jsonb_build_object('outcome', 'refused', 'reason', 'bad_items');
      end if;
      orig := null;
      select o into orig from jsonb_array_elements(p.items) o
       where o->>'kind' = it->>'kind'
         and coalesce(o->>'generation_id', '') = coalesce(it->>'generation_id', '')
         and coalesce(o->>'kit_id', '')        = coalesce(it->>'kit_id', '')
         and coalesce(o->>'concept_key', '')   = coalesce(it->>'concept_key', '')
       limit 1;
      if orig is null then
        return jsonb_build_object('outcome', 'refused', 'reason', 'item_not_proposed');
      end if;
      v_items := v_items || jsonb_build_array(orig || jsonb_build_object('title', v_title, 'reason', v_reason));
    end loop;
    v_edited := true;
  end if;

  if p_decision = 'edit' then
    update public.sk_learn_plans set items = v_items, edited = v_edited, updated_at = now() where id = p.id;
    return jsonb_build_object('outcome', 'done', 'status', 'pending_approval');
  end if;

  if p_decision = 'decline' then
    update public.sk_learn_plans
       set status = 'declined', items = v_items, edited = v_edited,
           decided_by = v_uid, decided_role = p.approver_role, decided_at = now(),
           decline_note = nullif(left(btrim(coalesce(p_note, '')), 500), ''), updated_at = now()
     where id = p.id;
    return jsonb_build_object('outcome', 'done', 'status', 'declined');
  end if;

  -- APPROVE. Targets: her, or every student enrolled in the class.
  if coalesce(p_whole_class, false) then
    select array_agg(e.student_id) into v_targets from public.enrollments e where e.class_id = p.class_id;
  else
    v_targets := array[p.student_id];
  end if;

  for it in select * from jsonb_array_elements(v_items) loop
    -- practice / next: assign the kit piece (once).
    if it->>'kind' in ('practice', 'next') and coalesce(it->>'generation_id', '') <> '' then
      begin
        v_gen := (it->>'generation_id')::uuid;
      exception when others then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('generation_id', it->>'generation_id', 'reason', 'bad_id'));
        continue;
      end;
      if not exists (select 1 from public.generations g
                      where g.id = v_gen and g.status = 'done' and g.withdrawn_at is null
                        and g.kind::text not in ('lesson_plan', 'question_bank', 'answer_key')) then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('generation_id', v_gen, 'reason', 'not_assignable'));
      elsif not coalesce(p_whole_class, false) and exists (
              select 1 from public.generation_shares s
               where s.generation_id = v_gen
                 and (s.student_id = p.student_id
                      or s.class_id in (select e.class_id from public.enrollments e where e.student_id = p.student_id))) then
        v_already := v_already || jsonb_build_array(v_gen);                       -- already in her My lessons
      elsif coalesce(p_whole_class, false) and exists (
              select 1 from public.generation_shares s where s.generation_id = v_gen and s.class_id = p.class_id) then
        v_already := v_already || jsonb_build_array(v_gen);
      elsif not exists (select 1 from public.generations g where g.id = v_gen and g.owner_id = v_uid) then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('generation_id', v_gen, 'reason', 'not_yours'));
      elsif coalesce(p_whole_class, false) then
        insert into public.generation_shares (generation_id, class_id, shared_by)
        values (v_gen, p.class_id, v_uid)
        on conflict (generation_id, class_id) do nothing
        returning id into v_share;
        if v_share is not null then v_shares := v_shares || jsonb_build_array(v_share); end if;
      else
        insert into public.generation_shares (generation_id, student_id, shared_by)
        values (v_gen, p.student_id, v_uid)
        on conflict (generation_id, student_id) where student_id is not null do nothing
        returning id into v_share;
        if v_share is not null then v_shares := v_shares || jsonb_build_array(v_share); end if;
      end if;
      v_share := null;
    end if;

    -- reteach: SK's focus concept for the next sessions.
    if it->>'kind' = 'reteach' and coalesce(it->>'concept_key', '') <> '' and coalesce(it->>'kit_id', '') <> '' then
      begin
        v_kit := (it->>'kit_id')::uuid;
      exception when others then
        continue;
      end;
      if exists (select 1 from public.generations g where g.id = v_kit) then
        insert into public.sk_learn_focus (student_id, kit_id, concept_key, concept_name, plan_id, until)
        select t, v_kit, left(it->>'concept_key', 120), left(coalesce(nullif(it->>'concept_name', ''), it->>'title'), 200), p.id, v_until
          from unnest(v_targets) as t
        on conflict (student_id, kit_id, concept_key) do update
          set concept_name = excluded.concept_name, plan_id = excluded.plan_id, until = excluded.until, created_at = now();
        v_focus := v_focus + coalesce(array_length(v_targets, 1), 0);
      end if;
    end if;
  end loop;

  update public.sk_learn_plans
     set status = 'approved', items = v_items, edited = v_edited,
         decided_by = v_uid, decided_role = p.approver_role, decided_at = now(),
         applied = jsonb_build_object('shares', v_shares, 'already', v_already, 'skipped', v_skipped,
                                      'focus', v_focus, 'whole_class', coalesce(p_whole_class, false)),
         updated_at = now()
   where id = p.id;

  return jsonb_build_object('outcome', 'done', 'status', 'approved',
    'applied', jsonb_build_object('shares', v_shares, 'already', v_already, 'skipped', v_skipped,
                                  'focus', v_focus, 'whole_class', coalesce(p_whole_class, false)));
end $$;

revoke all on function public.sk_learn_plan_decide(uuid, text, jsonb, boolean, text) from public, anon;
grant execute on function public.sk_learn_plan_decide(uuid, text, jsonb, boolean, text) to authenticated, service_role;

comment on table public.sk_practice_concepts is 'SK student Board phase 4: cache of concept tags per worksheet question × question_hash (paper / lesson map / Haiku 5.5). Service role writes; readable by whoever can read an attempt on the question.';
comment on table public.sk_learn_plans is 'SK student Board phase 4: recommended plans (draft → pending_approval → approved | declined | superseded). Class teacher approves a school student''s plan, a parent a home student''s; decided only through sk_learn_plan_decide().';
comment on table public.sk_learn_focus is 'SK student Board phase 4: concepts SK teaches a student next (from an approved plan), per kit, until a date.';

commit;
