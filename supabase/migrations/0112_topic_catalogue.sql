-- 0112_topic_catalogue
--
-- The topic catalogue: canonical topics, their curricula, knowledge articles,
-- kits, publications and the question bank — and the rule that catalogue
-- generations are never metered.
--
-- Topic-catalogue plan (founder, approved 2026-09-06), §5 "Data model" and
-- "Trigger exemptions", §1.1–1.7. In one sentence: a database of canonical
-- topics (e.g. "Cell"), each with SketchCast's OWN knowledge article, kit and
-- videos, mapped to many curricula ("also Cambridge Stage 7 and CBSE Class 8").
-- Textbooks contribute topic NAMES only (topic_candidates.raw_title is capped
-- at 120 characters so a sentence of book text can never be stored).
--
-- WHAT IT DOES
--   Tables (all service-role only: RLS on, no policies, revoke from
--   anon/authenticated — the portal at library.sketchcast.app reads and writes
--   them through server components and /api/library/* with the service key,
--   exactly like credit_grants and platform_admins):
--     curricula, curriculum_nodes            the syllabi (Cambridge 0893, CBSE
--                                            086, later exam boards: kind)
--     topics, topic_aliases,                 the canonical topic graph; ONE
--     topic_curriculum_map                   normalisation (canonical_key) in
--                                            app and worker, aliases match by
--                                            `normalized` only
--     topic_candidates                       names harvested from books and
--                                            syllabi, waiting to be merged or
--                                            created (the "unmapped" queue)
--     topic_articles, article_figures        the knowledge base (versioned; one
--                                            approved row per topic+language)
--     topic_kits, topic_publications         the generated kit per language and
--                                            its YouTube uploads (one per part)
--     topic_questions                        the question bank — rows, not a
--                                            docx; worksheets and papers are
--                                            renderings composed from it
--     question_set_blueprints, question_sets the composer's presets and every
--                                            set it ever rendered
--   topic_bank_maturity(topic) + a trigger on topic_questions keep
--   topics.bank_maturity current: none <10, basic 10, good 20, strong 30,
--   assessment 50, exam_ready 100 approved English items (§1.7 ladder).
--   Seeds the 12 worksheet presets (Remedial / Standard / Challenge × all
--   objective / all subjective / 50-50 / 40-60) idempotently.
--
--   TRIGGER EXEMPTIONS — a catalogue generation is an ordinary generations row
--   with book_id NULL, params.catalogue = true, params.topic_id, owned by the
--   catalogue system account. Every trigger on generations was read from prod
--   (pg_trigger, 2026-09-06) and classified:
--     duplicate_guard   reject_double_submit   BEFORE INSERT  → EXEMPTED. Two
--                       topic kits inserted within 10 s share (owner, kind,
--                       book_id NULL, chapter_ref NULL, part 0) and would be
--                       rejected as a double click. Guard added first.
--     fair_use_cap      enforce_fair_use       BEFORE INSERT  → EXEMPTED. The
--                       staff tier's sentinel already returns early, but the
--                       document branch's "a lesson must exist for this unit"
--                       and the monthly regeneration cap must never apply to a
--                       catalogue row. Guard added first, before the tier read
--                       and before any advisory lock.
--     credit_ledger_write credit_ledger_write  AFTER INSERT   → EXEMPTED. It
--                       inserts a ledger row for every billable kind even on an
--                       unlimited tier ("always charge 'plan'"), so without the
--                       guard the system account would accumulate ledger rows.
--                       Guard added first: no ledger row is EVER written for a
--                       catalogue generation.
--     credit_ledger_sync                       AFTER UPDATE   → not needed: it
--                       only UPDATES ledger rows of the generation; none exist.
--     credit_ledger_void_unconsumed            BEFORE DELETE  → not needed: same.
--     beta_generation_cap enforce_beta_generation_cap BEFORE INSERT/UPDATE →
--                       not needed, but for a narrower reason than "service
--                       role": 0012 stamps beta_tester = true on every new
--                       profile, so effective_cap(owner,'chapters') is 1, not
--                       the sentinel, and the distinct-(book_id, chapter_ref)
--                       count DOES run. Every catalogue row is (NULL, NULL) —
--                       one tuple — so it passes. SYSTEM-ACCOUNT CHECKLIST when
--                       catalogue@sketchcast.app is created: platform_admins
--                       row; `update profiles set beta_tester = false`; a
--                       catalogue row must keep book_id and chapter_ref NULL.
--     generations_lesson_tools enforce_lesson_tools BEFORE INSERT → not needed:
--                       returns for any writer that is not the row's owner.
--     on_generation_created                    AFTER INSERT   → WANTED: it
--                       creates the worker job.
--     on_generation_ledger_used                AFTER INSERT   → no-op with
--                       book_id NULL.
--   THE FLAG IS NOT TRUSTED ON ITS OWN. generations.params is written by the
--   client on insert (gen_write, 0001/0020 — owner_id = auth.uid() and nothing
--   about params), so a user could set params.catalogue = true on their own
--   row, or UPDATE it in afterwards (gen_write is FOR ALL), and skip dedup, the
--   caps — including the 0100 school hard stops — and the ledger. Three layers
--   close that:
--     1. the guard fires only when auth.uid() IS NULL (the service role: the
--        portal's API routes and the worker) AND is_platform_admin(new.owner_id)
--        (0014; the catalogue system account holds that row). Any other row
--        carrying the flag is REFUSED with insufficient_privilege, so a forgery
--        surfaces as an error instead of a free kit;
--     2. two RESTRICTIVE policies (the 0015 pattern) stop `authenticated` from
--        inserting or updating a generations row with the flag at all, so the
--        guard's raise is defence in depth, not the only lock;
--     3. the worker's catalogue branch (Phase 3) must refuse a flagged row whose
--        owner is not a platform admin before doing any work.
--   Each exempted function is re-declared from its LIVE prod body
--   (pg_get_functiondef, 2026-09-06; equal to its last defining migration:
--   reject_double_submit and enforce_fair_use → 0103, credit_ledger_write →
--   0089) with ONLY the guard added as the first statement.
--
-- WHAT IT DOES NOT DO
--   No policies GRANTING anything to authenticated users (the portal is
--   service-role only); the only policies added are the two RESTRICTIVE ones on
--   generations that forbid the catalogue flag.
--   No change to existing rows. Does not touch plan_tier, fair_use_caps, the
--   premium-voice helper (0105/0109), fair_use_used, fair_use_used_since,
--   credit_ledger_sync or the enum types (0111 adds 'script_json' on its own). Does not insert
--   topics, curricula or members: the seeds come from the worker's
--   scripts/seed_curricula.py; membership from the console.
--
-- ROLLBACK: drop the new tables (they hold nothing yet), drop trigger
-- topic_questions_maturity, the two maturity functions, approve_topic_article,
-- index jobs_one_live_harvest and the two gen_no_catalogue_* policies, and
-- re-run 0103's reject_double_submit / enforce_fair_use and 0089's
-- credit_ledger_write (with its trigger).
--
-- Applied to prod by the agent on the founder's explicit 2026-09-06 instruction, after a rolled-back dry run.

begin;

-- ── 1. Curricula ─────────────────────────────────────────────────────────────
create table if not exists public.curricula (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  kind        text not null default 'syllabus' check (kind in ('syllabus', 'exam_board')),
  country     text,
  edition     text,
  source_url  text,
  created_at  timestamptz not null default now()
);
alter table public.curricula enable row level security;
revoke all on public.curricula from anon, authenticated;

create table if not exists public.curriculum_nodes (
  id             uuid primary key default gen_random_uuid(),
  curriculum_id  uuid not null references public.curricula(id) on delete cascade,
  code           text not null,
  grade          text,
  strand         text,
  sub_strand     text,
  title          text not null,
  description    text,
  parent_id      uuid references public.curriculum_nodes(id) on delete set null,
  sort           int not null default 0,
  created_at     timestamptz not null default now(),
  unique (curriculum_id, code)
);
create index if not exists curriculum_nodes_grade_idx on public.curriculum_nodes (curriculum_id, grade);
alter table public.curriculum_nodes enable row level security;
revoke all on public.curriculum_nodes from anon, authenticated;

-- ── 2. Topics ────────────────────────────────────────────────────────────────
create table if not exists public.topics (
  id             uuid primary key default gen_random_uuid(),
  canonical_key  text not null unique,
  title          text not null,
  subject        text,
  summary        text,
  teacher_avatar text,
  depth_node_id  uuid references public.curriculum_nodes(id) on delete set null,
  prerequisites  uuid[] not null default '{}',
  status         text not null default 'candidate'
                 check (status in ('candidate','approved','article_approved','generating','in_review','video_approved','published','retired')),
  bank_maturity  text not null default 'none'
                 check (bank_maturity in ('none','basic','good','strong','assessment','exam_ready')),
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
drop trigger if exists topics_touch on public.topics;
create trigger topics_touch before update on public.topics
  for each row execute function touch_updated_at();
alter table public.topics enable row level security;
revoke all on public.topics from anon, authenticated;

create table if not exists public.topic_aliases (
  id          uuid primary key default gen_random_uuid(),
  topic_id    uuid not null references public.topics(id) on delete cascade,
  alias       text not null,
  normalized  text not null unique,
  source      text not null check (source in ('curriculum','book','manual')),
  created_at  timestamptz not null default now()
);
create index if not exists topic_aliases_topic_idx on public.topic_aliases (topic_id);
alter table public.topic_aliases enable row level security;
revoke all on public.topic_aliases from anon, authenticated;

create table if not exists public.topic_curriculum_map (
  id          uuid primary key default gen_random_uuid(),
  topic_id    uuid not null references public.topics(id) on delete cascade,
  node_id     uuid not null references public.curriculum_nodes(id) on delete cascade,
  coverage    text not null default 'full' check (coverage in ('full','partial')),
  notes       text,
  created_at  timestamptz not null default now(),
  unique (topic_id, node_id)
);
create index if not exists topic_curriculum_map_node_idx on public.topic_curriculum_map (node_id);
alter table public.topic_curriculum_map enable row level security;
revoke all on public.topic_curriculum_map from anon, authenticated;

-- The "unmapped" queue. raw_title is a NAME, never book text: 120 characters.
create table if not exists public.topic_candidates (
  id                  uuid primary key default gen_random_uuid(),
  source_kind         text not null check (source_kind in ('book','curriculum')),
  -- CASCADE, not SET NULL: the unique index below coalesces a NULL book_id to
  -- one zero uuid, so orphaned rows from two deleted books that shared a
  -- heading ("Summary", "Cell") would collide and the second `delete from
  -- books` would FAIL on this index — breaking book deletion (0100) for any
  -- teacher whose book staff harvested. A candidate is "this name in this
  -- book"; a merged or created one has already produced its alias and mapping.
  book_id             uuid references public.books(id) on delete cascade,
  node_id             uuid references public.curriculum_nodes(id) on delete cascade,
  raw_title           text not null check (char_length(raw_title) <= 120),
  normalized          text not null,
  suggested_topic_id  uuid references public.topics(id) on delete set null,
  status              text not null default 'open' check (status in ('open','merged','created','dismissed')),
  resolved_by         uuid references public.profiles(id) on delete set null,
  resolved_at         timestamptz,
  created_at          timestamptz not null default now()
);
create unique index if not exists topic_candidates_uniq on public.topic_candidates (
  source_kind,
  coalesce(book_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(node_id, '00000000-0000-0000-0000-000000000000'::uuid),
  normalized
);
create index if not exists topic_candidates_status_idx on public.topic_candidates (status, created_at);
alter table public.topic_candidates enable row level security;
revoke all on public.topic_candidates from anon, authenticated;

-- ── 3. Knowledge base ────────────────────────────────────────────────────────
create table if not exists public.topic_articles (
  id                 uuid primary key default gen_random_uuid(),
  topic_id           uuid not null references public.topics(id) on delete cascade,
  version            int not null default 1,
  language           text not null default 'en',
  source_article_id  uuid references public.topic_articles(id) on delete set null,
  title              text not null,
  objectives         jsonb not null default '[]'::jsonb,
  sections           jsonb not null default '[]'::jsonb,
  glossary           jsonb not null default '[]'::jsonb,
  misconceptions     jsonb not null default '[]'::jsonb,
  worked_examples    jsonb not null default '[]'::jsonb,
  claims             jsonb not null default '[]'::jsonb,
  depth_node_id      uuid references public.curriculum_nodes(id) on delete set null,
  depth_rationale    text,
  word_count         int not null default 0,
  status             text not null default 'draft'
                     check (status in ('draft','in_review','approved','superseded','rejected')),
  author             text not null default 'model' check (author in ('model','staff')),
  reviewer_id        uuid references public.profiles(id) on delete set null,
  reviewed_at        timestamptz,
  approved_by        uuid references public.profiles(id) on delete set null,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (topic_id, language, version)
);
-- One approved article per topic and language; approving a new version
-- supersedes the old one first (the app's status machine does that).
create unique index if not exists topic_articles_one_approved
  on public.topic_articles (topic_id, language) where status = 'approved';
drop trigger if exists topic_articles_touch on public.topic_articles;
create trigger topic_articles_touch before update on public.topic_articles
  for each row execute function touch_updated_at();
alter table public.topic_articles enable row level security;
revoke all on public.topic_articles from anon, authenticated;

create table if not exists public.article_figures (
  id               uuid primary key default gen_random_uuid(),
  article_id       uuid not null references public.topic_articles(id) on delete cascade,
  figure_key       text not null,
  caption          text,
  spec             jsonb not null default '{}'::jsonb,
  visual_asset_id  uuid,                 -- worker-owned visual_assets; no FK on purpose
  labels           jsonb not null default '[]'::jsonb,
  sort             int not null default 0,
  status           text not null default 'draft' check (status in ('draft','rendered','approved','rejected')),
  created_at       timestamptz not null default now(),
  unique (article_id, figure_key)
);
alter table public.article_figures enable row level security;
revoke all on public.article_figures from anon, authenticated;

-- ── 4. Kits and publications ─────────────────────────────────────────────────
create table if not exists public.topic_kits (
  id                          uuid primary key default gen_random_uuid(),
  topic_id                    uuid not null references public.topics(id) on delete cascade,
  article_id                  uuid not null references public.topic_articles(id) on delete restrict,
  language                    text not null default 'en',
  source_kit_id               uuid references public.topic_kits(id) on delete set null,
  teacher_avatar              text,
  voice_pair                  jsonb,
  presentation_generation_id  uuid references public.generations(id) on delete set null,
  doc_generation_ids          jsonb not null default '{}'::jsonb,
  chapters                    jsonb not null default '[]'::jsonb,
  clips                       jsonb not null default '[]'::jsonb,
  status                      text not null default 'generating'
                              check (status in ('generating','in_review','approved','rejected','failed')),
  reject_reason               text check (reject_reason is null or reject_reason in ('factual','grade_fit','pacing','visuals','pronunciation','translation','other')),
  approved_by                 uuid references public.profiles(id) on delete set null,
  reviewer_id                 uuid references public.profiles(id) on delete set null,
  reviewed_at                 timestamptz,
  notes                       text,
  judge_score                 jsonb,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
create index if not exists topic_kits_topic_idx on public.topic_kits (topic_id, language);
drop trigger if exists topic_kits_touch on public.topic_kits;
create trigger topic_kits_touch before update on public.topic_kits
  for each row execute function touch_updated_at();
alter table public.topic_kits enable row level security;
revoke all on public.topic_kits from anon, authenticated;

create table if not exists public.topic_publications (
  id                 uuid primary key default gen_random_uuid(),
  topic_kit_id       uuid not null references public.topic_kits(id) on delete cascade,
  part               int not null default 1,
  channel_language   text not null,
  youtube_video_id   text,
  privacy            text not null default 'private' check (privacy in ('private','unlisted','public')),
  playlist_ids       text[] not null default '{}',
  captions_uploaded  text[] not null default '{}',
  thumbnail_set      boolean not null default false,
  published_at       timestamptz,
  error              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (topic_kit_id, part, channel_language)
);
drop trigger if exists topic_publications_touch on public.topic_publications;
create trigger topic_publications_touch before update on public.topic_publications
  for each row execute function touch_updated_at();
alter table public.topic_publications enable row level security;
revoke all on public.topic_publications from anon, authenticated;

-- ── 5. Question bank ─────────────────────────────────────────────────────────
create table if not exists public.topic_questions (
  id                    uuid primary key default gen_random_uuid(),
  topic_id              uuid not null references public.topics(id) on delete cascade,
  article_id            uuid not null references public.topic_articles(id) on delete restrict,
  objective_ref         text,
  claim_ref             text,
  language              text not null default 'en',
  source_question_id    uuid references public.topic_questions(id) on delete set null,
  item_type             text not null
                        check (item_type in ('mcq','true_false','fill_blank','match','assertion_reason','short_answer','long_answer','numerical','diagram_label')),
  answer_mode           text not null check (answer_mode in ('objective','subjective')),
  difficulty            int not null check (difficulty between 1 and 5),
  cognitive_level       text not null
                        check (cognitive_level in ('recall','understand','apply','analyse','evaluate','create')),
  marks                 int not null default 1,
  est_seconds           int,
  stem                  text not null,
  options               jsonb,
  distractor_rationale  jsonb,
  answer                jsonb not null,
  marking_scheme        jsonb,
  explanation           text,
  tags                  text[] not null default '{}',
  content_hash          text not null,
  status                text not null default 'draft' check (status in ('draft','approved','rejected','retired')),
  reviewer_id           uuid references public.profiles(id) on delete set null,
  reviewed_at           timestamptz,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (topic_id, language, content_hash)
);
create index if not exists topic_questions_compose_idx on public.topic_questions (topic_id, status, answer_mode, difficulty);
create index if not exists topic_questions_tags_idx on public.topic_questions using gin (tags);
drop trigger if exists topic_questions_touch on public.topic_questions;
create trigger topic_questions_touch before update on public.topic_questions
  for each row execute function touch_updated_at();
alter table public.topic_questions enable row level security;
revoke all on public.topic_questions from anon, authenticated;

create table if not exists public.question_set_blueprints (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  scope          text not null check (scope in ('worksheet','paper','mock_exam')),
  curriculum_id  uuid references public.curricula(id) on delete set null,
  spec           jsonb not null default '{}'::jsonb,
  min_maturity   text not null default 'good' check (min_maturity in ('basic','good','strong','assessment','exam_ready')),
  status         text not null default 'active' check (status in ('active','retired')),
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now()
);
alter table public.question_set_blueprints enable row level security;
revoke all on public.question_set_blueprints from anon, authenticated;

create table if not exists public.question_sets (
  id                       uuid primary key default gen_random_uuid(),
  blueprint_id             uuid not null references public.question_set_blueprints(id) on delete restrict,
  topic_ids                uuid[] not null default '{}',
  language                 text not null default 'en',
  question_ids             uuid[] not null default '{}',
  seed                     int not null default 0,
  rendered_generation_id   uuid references public.generations(id) on delete set null,
  requested_by             uuid references public.profiles(id) on delete set null,
  created_at               timestamptz not null default now()
);
alter table public.question_sets enable row level security;
revoke all on public.question_sets from anon, authenticated;

-- ── 6. Bank maturity (plan §1.7 ladder) ──────────────────────────────────────
create or replace function public.topic_bank_maturity(p_topic uuid) returns text
  language sql stable set search_path = public as
$$
  select case
    when s.n >= 100 then 'exam_ready'
    when s.n >= 50  then 'assessment'
    when s.n >= 30  then 'strong'
    when s.n >= 20  then 'good'
    when s.n >= 10  then 'basic'
    else 'none'
  end
  from (select count(*) as n
          from topic_questions q
         where q.topic_id = p_topic and q.status = 'approved' and q.language = 'en') s
$$;
revoke execute on function public.topic_bank_maturity(uuid) from public, anon, authenticated;
grant execute on function public.topic_bank_maturity(uuid) to service_role;

create or replace function public.topic_questions_maturity_sync() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare
  t uuid;
  m text;
begin
  -- One topic at a time (two approvals racing under READ COMMITTED would
  -- each count their own snapshot and the stored rung could lag by one), and
  -- write only when the rung changes, so topics.updated_at is not bumped by
  -- every item edit.
  for t in select distinct x from unnest(array[
             case when tg_op in ('INSERT', 'UPDATE') then new.topic_id end,
             case when tg_op in ('DELETE', 'UPDATE') then old.topic_id end]) as u(x)
           where x is not null
  loop
    perform pg_advisory_xact_lock(hashtext('bank:' || t::text));
    m := topic_bank_maturity(t);
    update topics set bank_maturity = m where id = t and bank_maturity is distinct from m;
  end loop;
  return null;
end
$$;
drop trigger if exists topic_questions_maturity on public.topic_questions;
create trigger topic_questions_maturity after insert or update or delete on public.topic_questions
  for each row execute function public.topic_questions_maturity_sync();

-- ── 6a. Approving an article is ONE transaction ──────────────────────────────
-- The partial unique index above allows one approved article per (topic,
-- language). The portal talks to Postgres through PostgREST, which cannot open
-- a transaction, so "supersede v1, then approve v2" as two calls could leave a
-- topic with NO approved article after a failure, or two reviewers racing.
-- This RPC does it atomically: lock the topic, supersede every other approved
-- row of that (topic, language), approve the target, move the topic to
-- article_approved, and audit — plan §1.3 (human approval, recorded).
create or replace function public.approve_topic_article(p_article uuid, p_reviewer uuid, p_notes text default null)
returns public.topic_articles
  language plpgsql security definer set search_path = public as
$$
declare
  a topic_articles%rowtype;
begin
  select * into a from topic_articles where id = p_article for update;
  if not found then
    raise exception 'article % not found', p_article using errcode = 'no_data_found';
  end if;
  if a.status not in ('draft', 'in_review') then
    raise exception 'article % is %, not reviewable', p_article, a.status using errcode = 'check_violation';
  end if;
  perform 1 from topics where id = a.topic_id for update;

  update topic_articles
     set status = 'superseded'
   where topic_id = a.topic_id and language = a.language and status = 'approved' and id <> a.id;

  update topic_articles
     set status = 'approved', approved_by = p_reviewer, reviewer_id = p_reviewer,
         reviewed_at = now(), notes = coalesce(p_notes, notes)
   where id = a.id
   returning * into a;

  update topics set status = 'article_approved'
   where id = a.topic_id and status in ('candidate', 'approved');

  insert into platform_audit_log (actor_id, action, target_kind, target_id, detail)
  values (p_reviewer, 'library_article_approve', 'topic', a.topic_id,
          jsonb_build_object('article_id', a.id, 'version', a.version, 'language', a.language));
  return a;
end
$$;
revoke execute on function public.approve_topic_article(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.approve_topic_article(uuid, uuid, text) to service_role;

-- ── 6b. One live harvest per book ────────────────────────────────────────────
-- The portal's Harvest button enqueues a public.jobs row {type: 'topic_harvest',
-- book_id, generation_id NULL}. Its check-then-insert ("refuse while one is
-- queued or processing") is racy on its own; this partial unique index is the
-- rule the database enforces, and the route maps 23505 to its 409.
create unique index if not exists jobs_one_live_harvest
  on public.jobs (book_id)
  where type = 'topic_harvest' and status in ('queued', 'processing');

-- ── 7. Worksheet presets (idempotent) ────────────────────────────────────────
-- min_maturity is the CHEAP pre-check only: the ladder counts approved English
-- items of both answer modes, so 'basic' (10) does not by itself guarantee ten
-- objective items for "all objective", nor anything for another language. The
-- composer (Phase 3) checks availability per answer_mode and language and
-- fails loudly rather than padding — plan §1.7.
insert into public.question_set_blueprints (name, scope, spec, min_maturity)
select v.name, 'worksheet', v.spec::jsonb, v.min_maturity from (values
  ('Remedial · all objective',  '{"preset":"remedial","objective_ratio":1.0,"difficulty_mix":{"1":0.5,"2":0.4,"3":0.1},"count":10,"total_marks":20}', 'basic'),
  ('Remedial · all subjective', '{"preset":"remedial","objective_ratio":0.0,"difficulty_mix":{"1":0.5,"2":0.4,"3":0.1},"count":10,"total_marks":20}', 'basic'),
  ('Remedial · 50/50',          '{"preset":"remedial","objective_ratio":0.5,"difficulty_mix":{"1":0.5,"2":0.4,"3":0.1},"count":10,"total_marks":20}', 'basic'),
  ('Remedial · 40/60',          '{"preset":"remedial","objective_ratio":0.4,"difficulty_mix":{"1":0.5,"2":0.4,"3":0.1},"count":10,"total_marks":20}', 'basic'),
  ('Standard · all objective',  '{"preset":"standard","objective_ratio":1.0,"difficulty_mix":{"2":0.3,"3":0.5,"4":0.2},"count":10,"total_marks":20}', 'basic'),
  ('Standard · all subjective', '{"preset":"standard","objective_ratio":0.0,"difficulty_mix":{"2":0.3,"3":0.5,"4":0.2},"count":10,"total_marks":20}', 'basic'),
  ('Standard · 50/50',          '{"preset":"standard","objective_ratio":0.5,"difficulty_mix":{"2":0.3,"3":0.5,"4":0.2},"count":10,"total_marks":20}', 'basic'),
  ('Standard · 40/60',          '{"preset":"standard","objective_ratio":0.4,"difficulty_mix":{"2":0.3,"3":0.5,"4":0.2},"count":10,"total_marks":20}', 'basic'),
  ('Challenge · all objective', '{"preset":"challenge","objective_ratio":1.0,"difficulty_mix":{"3":0.3,"4":0.5,"5":0.2},"count":10,"total_marks":20}', 'good'),
  ('Challenge · all subjective','{"preset":"challenge","objective_ratio":0.0,"difficulty_mix":{"3":0.3,"4":0.5,"5":0.2},"count":10,"total_marks":20}', 'good'),
  ('Challenge · 50/50',         '{"preset":"challenge","objective_ratio":0.5,"difficulty_mix":{"3":0.3,"4":0.5,"5":0.2},"count":10,"total_marks":20}', 'good'),
  ('Challenge · 40/60',         '{"preset":"challenge","objective_ratio":0.4,"difficulty_mix":{"3":0.3,"4":0.5,"5":0.2},"count":10,"total_marks":20}', 'good')
) as v(name, spec, min_maturity)
on conflict (name) do nothing;

-- ── 7b. No client may carry the catalogue flag ───────────────────────────────
-- Defence in depth for the guards below (the 0015 restrictive-policy pattern):
-- `authenticated` can neither insert nor update a generations row whose params
-- say catalogue = true. The service role is not subject to RLS, so the portal
-- and the worker are unaffected.
drop policy if exists gen_no_catalogue_insert on public.generations;
create policy gen_no_catalogue_insert on public.generations as restrictive for insert
  to authenticated
  with check (coalesce(params->>'catalogue', '') <> 'true');
drop policy if exists gen_no_catalogue_update on public.generations;
create policy gen_no_catalogue_update on public.generations as restrictive for update
  to authenticated
  using (true)
  with check (coalesce(params->>'catalogue', '') <> 'true');

-- ── 8. Trigger exemptions for catalogue generations ──────────────────────────
-- Each body below is its last defining migration's body (0103 / 0089), which
-- equals the live prod body (pg_get_functiondef, 2026-09-06), with ONLY the
-- catalogue guard added as the first statement.

-- reject_double_submit — body of 0103 (== prod), plus the guard.
create or replace function public.reject_double_submit() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare
  new_part int;
begin
  -- 0112: a catalogue generation (topic kit, owned by the catalogue system
  -- account; params.catalogue = true) is never deduplicated, capped or metered
  -- here. `params` is CLIENT-writable on insert, so the flag alone proves
  -- nothing: only a platform admin's row may carry it (the catalogue system
  -- account is one); anyone else's is refused outright rather than metered as
  -- if the flag were absent, so a forgery is visible, not silently ignored.
  -- See 0112's header for the trigger-by-trigger reasoning.
  if coalesce(new.params->>'catalogue', '') = 'true' then
    if auth.uid() is not null or not public.is_platform_admin(new.owner_id) then
      raise exception 'params.catalogue is reserved for the catalogue system account.'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if new.kind::text not in
     ('presentation','worksheet','lesson_plan','activity','exam_paper','case_study','deck')
     or coalesce(new.params->>'revision','') = 'true' then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));

  new_part := coalesce(
    case when new.params->>'part' ~ '^[0-9]{1,9}$' then (new.params->>'part')::int end, 0);

  if exists (
    select 1 from generations g
    where g.owner_id = new.owner_id
      and g.kind = new.kind
      and g.book_id is not distinct from new.book_id
      and g.chapter_ref is not distinct from new.chapter_ref
      and coalesce(
            case when g.params->>'part' ~ '^[0-9]{1,9}$' then (g.params->>'part')::int end, 0
          ) = new_part
      and coalesce(g.params->>'revision','') <> 'true'
      and g.status <> 'error'
      and g.created_at > now() - interval '10 seconds'
  ) then
    raise exception 'That kit is already being made — give it a moment to appear.'
      using errcode = 'unique_violation';
  end if;

  return new;
end;
$$;

-- enforce_fair_use — body of 0103 (== prod), plus the guard.
create or replace function public.enforce_fair_use() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare
  tier text;
  caps record;
  a record;
  new_part int;
  has_lesson boolean;
  kind_rows int;
  cumulative_count int;
  eff_cap int;
begin
  -- 0112: a catalogue generation (topic kit, owned by the catalogue system
  -- account; params.catalogue = true) is never deduplicated, capped or metered
  -- here. `params` is CLIENT-writable on insert, so the flag alone proves
  -- nothing: only a platform admin's row may carry it (the catalogue system
  -- account is one); anyone else's is refused outright rather than metered as
  -- if the flag were absent, so a forgery is visible, not silently ignored.
  -- See 0112's header for the trigger-by-trigger reasoning.
  if coalesce(new.params->>'catalogue', '') = 'true' then
    if auth.uid() is not null or not public.is_platform_admin(new.owner_id) then
      raise exception 'params.catalogue is reserved for the catalogue system account.'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  tier := plan_tier(new.owner_id);

  -- 0100: the locked school states are decided FIRST. Suspension is the console
  -- kill switch, so it sits above even the console cap override; expiry sits
  -- just below that override (a blessed account stays blessed). Both must come
  -- before the exam and revision-paper branches, which return without ever
  -- reaching a credit check — a 0 cap alone would not stop them.
  if tier = 'school_suspended' then
    raise exception 'Your school''s SketchCast access is suspended. Please contact support.';
  end if;

  if exists (select 1 from profiles p where p.id = new.owner_id
             and (p.max_books is not null or p.max_chapters is not null)) then
    return new;
  end if;

  if tier = 'school_expired' then
    raise exception 'Your school''s free trial has ended. Ask your SketchCast contact to activate the school to keep generating.';
  end if;

  select * into caps from fair_use_caps(tier);

  -- The effective cap: tier default + anything support has comped. Guarded so
  -- the school sentinel (2147483647) is never arithmetic'd into an overflow.
  if caps.parts_cap >= 2147483647 then
    eff_cap := caps.parts_cap;
  else
    eff_cap := caps.parts_cap + fair_use_granted(new.owner_id);
  end if;

  if new.kind::text = 'exam' then
    perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));
    if coalesce(jsonb_typeof(new.params->'scope'), '') <> 'array'
       or jsonb_array_length(new.params->'scope') = 0 then
      raise exception 'Pick at least one covered chapter or part to build the exam from.';
    end if;
    if exists (
      select 1 from jsonb_array_elements(new.params->'scope') s
      where not exists (
        select 1 from generations p
        where p.owner_id = new.owner_id and p.kind = 'presentation' and p.status <> 'error'
          and p.book_id is not distinct from new.book_id
          and p.chapter_ref = (s.value->>'chapter')
          and coalesce(case when p.params->>'part' ~ '^[0-9]{1,9}$' then (p.params->>'part')::int end, 0)
              = coalesce(case when s.value->>'part' ~ '^[0-9]{1,9}$' then (s.value->>'part')::int end, 0)
      )
    ) then
      raise exception 'An exam can only cover chapters and parts you''ve already generated a lesson for.';
    end if;
    if caps.parts_cap < 2147483647
       and (select count(*) from generations g
              where g.owner_id = new.owner_id and g.kind::text = 'exam' and g.status <> 'error'
                and g.created_at >= date_trunc('month', now())) >= 12 then
      raise exception 'You''ve reached this month''s exams (12). It resets on the 1st.';
    end if;
    return new;
  end if;

  -- 0103: the slide deck is FREE with its lesson. Two guards and no credit
  -- check — the lesson for this exact unit must exist (rows inserted earlier
  -- in the same kit statement are visible here, 0075), and a unit's deck can
  -- be (re)generated at most 3 times a month. Unlimited tiers skip both, as
  -- the documents do.
  if new.kind::text = 'deck' then
    if caps.parts_cap >= 2147483647 then
      return new;
    end if;
    perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));
    new_part := coalesce(case when new.params->>'part' ~ '^[0-9]{1,9}$'
                              then (new.params->>'part')::int end, 0);
    select exists (
      select 1 from generations p
      where p.owner_id = new.owner_id and p.kind = 'presentation' and p.status <> 'error'
        and p.book_id is not distinct from new.book_id
        and p.chapter_ref is not distinct from new.chapter_ref
        and coalesce(case when p.params->>'part' ~ '^[0-9]{1,9}$'
                          then (p.params->>'part')::int end, 0) = new_part
    ) into has_lesson;
    if not has_lesson then
      raise exception 'The slide deck is part of a lesson kit — generate the lesson for this chapter first.';
    end if;
    select count(*) into kind_rows from generations d
      where d.owner_id = new.owner_id and d.kind::text = 'deck' and d.status <> 'error'
        and d.book_id is not distinct from new.book_id
        and d.chapter_ref is not distinct from new.chapter_ref
        and coalesce(case when d.params->>'part' ~ '^[0-9]{1,9}$'
                          then (d.params->>'part')::int end, 0) = new_part
        and d.created_at >= date_trunc('month', now());
    if kind_rows >= 3 then
      raise exception 'Regeneration limit: the slide deck was already generated % times this month for this lesson. It resets on the 1st.', kind_rows;
    end if;
    return new;
  end if;

  if new.kind = 'presentation' then
    if caps.parts_cap >= 2147483647 then
      return new;
    end if;
    perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));
    if tier = 'promo' then
      if fair_use_used(new.owner_id, 'credits', promo_credit_from()) >= eff_cap then
        raise exception 'Your free trial includes % generations with every feature unlocked, and you''ve used them all. Subscribe to keep generating.',
          eff_cap;
      end if;
      return new;
    end if;
    -- 0100: the school trial is a period total from its anchor, not a month.
    if tier = 'school_trial' then
      if fair_use_used_since(new.owner_id, school_trial_anchor(new.owner_id)) >= eff_cap then
        raise exception 'Your school''s free trial includes % generations, and you''ve used them all. Ask your SketchCast contact to activate the school to keep generating.',
          eff_cap;
      end if;
      return new;
    end if;
    select * into a from fair_use_avail(new.owner_id, 'credits', eff_cap);
    if a.available < 1
       and a.available + fair_use_purchased_remaining(new.owner_id) < 1 then
      raise exception 'Monthly limit reached: your plan includes % generations/month (+% carried over) — a lesson, a worksheet, a plan, an activity, a test paper and a case study each count as one. It resets on the 1st, or upgrade for more.',
        eff_cap, a.carry;
    end if;
    return new;
  end if;

  if new.kind in ('worksheet', 'exam_paper', 'lesson_plan', 'activity', 'case_study') then
    if caps.parts_cap >= 2147483647 then
      return new;
    end if;
    perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));

    if (new.params->>'revision') = 'true'
       and new.chapter_ref is null
       and jsonb_typeof(new.params->'chapters') = 'array' then
      if exists (
        select 1 from jsonb_array_elements_text(new.params->'chapters') ch
        where not exists (
          select 1 from generations p
          where p.owner_id = new.owner_id and p.kind = 'presentation' and p.status <> 'error'
            and p.book_id is not distinct from new.book_id
            and p.chapter_ref = ch.value
        )
      ) then
        raise exception 'Revision papers are built from your generated lessons — generate the lesson for every chapter you selected first.';
      end if;
      select count(*) into cumulative_count from generations g
        where g.owner_id = new.owner_id and g.kind = new.kind and g.status <> 'error'
          and (g.params->>'revision') = 'true' and g.chapter_ref is null
          and g.created_at >= date_trunc('month', now());
      if cumulative_count >= 12 then
        raise exception 'You''ve reached this month''s revision papers of this type. It resets on the 1st.';
      end if;
      return new;
    end if;

    new_part := coalesce(case when new.params->>'part' ~ '^[0-9]{1,9}$'
                              then (new.params->>'part')::int end, 0);
    select exists (
      select 1 from generations p
      where p.owner_id = new.owner_id and p.kind = 'presentation' and p.status <> 'error'
        and p.book_id is not distinct from new.book_id
        and p.chapter_ref is not distinct from new.chapter_ref
        and coalesce(case when p.params->>'part' ~ '^[0-9]{1,9}$'
                          then (p.params->>'part')::int end, 0) = new_part
    ) into has_lesson;
    if not has_lesson then
      raise exception 'Documents generate with their lesson — generate the lesson for this chapter first, or use Revision papers over chapters you''ve already taught.';
    end if;
    select (
      (select count(*) from credit_ledger cl
        where cl.owner_id = new.owner_id and cl.kind = new.kind::text and not cl.voided
          and cl.book_id is not distinct from new.book_id
          and cl.chapter_ref is not distinct from new.chapter_ref
          and cl.part = new_part
          and cl.created_at >= date_trunc('month', now()))
      +
      (select count(*) from generations d
        where d.owner_id = new.owner_id and d.kind = new.kind and d.status <> 'error'
          and d.book_id is not distinct from new.book_id
          and d.chapter_ref is not distinct from new.chapter_ref
          and coalesce(case when d.params->>'part' ~ '^[0-9]{1,9}$'
                            then (d.params->>'part')::int end, 0) = new_part
          and d.created_at >= date_trunc('month', now())
          and not exists (select 1 from credit_ledger cl2 where cl2.generation_id = d.id))
    ) into kind_rows;
    if kind_rows >= 3 then
      raise exception 'Regeneration limit: this document type was already generated % times this month for this lesson. It resets on the 1st.', kind_rows;
    end if;

    if tier = 'promo' then
      if fair_use_used(new.owner_id, 'credits', promo_credit_from()) >= eff_cap then
        raise exception 'Your free trial includes % generations with every feature unlocked, and you''ve used them all. Subscribe to keep generating.',
          eff_cap;
      end if;
    elsif tier = 'school_trial' then
      -- 0100: same period budget as the lesson path.
      if fair_use_used_since(new.owner_id, school_trial_anchor(new.owner_id)) >= eff_cap then
        raise exception 'Your school''s free trial includes % generations, and you''ve used them all. Ask your SketchCast contact to activate the school to keep generating.',
          eff_cap;
      end if;
    else
      select * into a from fair_use_avail(new.owner_id, 'credits', eff_cap);
      if a.available < 1
         and a.available + fair_use_purchased_remaining(new.owner_id) < 1 then
        raise exception 'Monthly limit reached: your plan includes % generations/month (+% carried over) — a lesson, a worksheet, a plan, an activity, a test paper and a case study each count as one. It resets on the 1st, or upgrade for more.',
          eff_cap, a.carry;
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- credit_ledger_write — body of 0089 (== prod), plus the guard. Qualified
-- and re-bound on purpose: if this ever resolved to another schema the
-- trigger would keep the UNGUARDED body and the system account would
-- accumulate ledger rows.
create or replace function public.credit_ledger_write() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare
  n int := 1;
  src text := 'plan';
  tier text;
  caps record;
  eff_cap int;
  m0 timestamptz := date_trunc('month', now());
  plan_used int;
  used_prev int;
  carry_v int := 0;
begin
  -- 0112: a catalogue generation (topic kit, owned by the catalogue system
  -- account; params.catalogue = true) is never deduplicated, capped or metered
  -- here. `params` is CLIENT-writable on insert, so the flag alone proves
  -- nothing: only a platform admin's row may carry it (the catalogue system
  -- account is one); anyone else's is refused outright rather than metered as
  -- if the flag were absent, so a forgery is visible, not silently ignored.
  -- See 0112's header for the trigger-by-trigger reasoning.
  if coalesce(new.params->>'catalogue', '') = 'true' then
    if auth.uid() is not null or not public.is_platform_admin(new.owner_id) then
      raise exception 'params.catalogue is reserved for the catalogue system account.'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if new.kind in ('presentation', 'worksheet', 'exam_paper', 'lesson_plan', 'activity', 'case_study') then
    -- 0089: coalesce, so an ABSENT part key (every chapter-level lesson)
    -- takes the branch — `not (NULL ~ …)` is NULL and never fired.
    if new.kind = 'presentation' and coalesce(new.params->>'part', '') !~ '^[0-9]{1,9}$' then
      select coalesce((
        select greatest(jsonb_array_length(c.value->'parts'), 1)
        from books b, jsonb_array_elements(coalesce(b.chapters, '[]'::jsonb)) c
        where b.id = new.book_id and c.value->>'num' = new.chapter_ref
          and jsonb_typeof(c.value->'parts') = 'array'
          limit 1), 1) into n;
    end if;

    -- Which pool does this row consume? Console-blessed accounts, promo (a
    -- period-total budget packs are never sold against) and unlimited tiers
    -- always charge 'plan'. Otherwise: 'plan' while any monthly room (cap +
    -- carry + live 0079 grants) remains, else 'purchase'. Decided from the
    -- LEDGER alone — see 0086's header for why fair_use_used() would
    -- mislabel a kit's early rows here.
    if not exists (select 1 from profiles p where p.id = new.owner_id
                   and (p.max_books is not null or p.max_chapters is not null)) then
      tier := plan_tier(new.owner_id);
      select * into caps from fair_use_caps(tier);
      if tier <> 'promo' and caps.parts_cap < 2147483647 then
        eff_cap := caps.parts_cap + fair_use_granted(new.owner_id);
        select coalesce(sum(cl.units), 0)::int into plan_used
          from credit_ledger cl
         where cl.owner_id = new.owner_id and not cl.voided
           and coalesce(cl.source, 'plan') = 'plan'
           and cl.created_at >= m0 and cl.created_at < m0 + interval '1 month';
        -- Carry mirrors fair_use_avail(uid, 'credits', eff_cap) exactly.
        if exists (select 1 from profiles p where p.id = new.owner_id and p.created_at < m0) then
          used_prev := fair_use_used(new.owner_id, 'credits', m0 - interval '1 month');
          carry_v := least(eff_cap, greatest(0, eff_cap - used_prev));
        end if;
        if plan_used >= eff_cap + carry_v then
          src := 'purchase';
        end if;
      end if;
    end if;

    insert into credit_ledger (owner_id, generation_id, kind, units, book_id, chapter_ref, part, voided, source)
    values (new.owner_id, new.id, new.kind, n, new.book_id, new.chapter_ref,
            coalesce(case when new.params->>'part' ~ '^[0-9]{1,9}$' then (new.params->>'part')::int end, 0),
            new.status = 'error', src);
  end if;
  return null;
end $$;
drop trigger if exists credit_ledger_write on public.generations;
create trigger credit_ledger_write after insert on public.generations
  for each row execute function public.credit_ledger_write();

commit;
