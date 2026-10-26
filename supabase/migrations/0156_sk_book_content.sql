-- SketchCast AI — 0156: SK book content — products, units, teaching objectives,
-- the objective → curriculum map, and queryable book blocks (SK plan B1a + B1b)
-- ============================================================================
-- Plan: "SketchCast SK AI Tutor - Architecture and Implementation Plan
-- 2026-10-26.md" Revision 3 (§3 teaching by objective, §10 data model, §15
-- rows B1a/B1b); contracts: docs/SK-CONTRACTS.md §6. Tested on the Supabase
-- BRANCH database `sk-b1` first (docs/SK-B1-REPORT.md); NOT applied to
-- production — that is a separate founder approval.
--
-- The six tables, and the one column on an existing table:
--
--   sk_book_products        one row per study-guide book (slug, edition,
--                           curriculum, languages, manuscript version).
--   sk_book_units           one row per teaching unit = one plan section of a
--                           chapter (chapter, unit_key u1…uN, section sid).
--   teaching_objectives     SketchCast's INTERNAL teaching objective, one per
--                           unit, written at the granularity SK teaches at.
--                           Tutoring, route planning and mastery key on THIS
--                           id, so an objective with no curriculum mapping
--                           still works for teaching (plan §10, R3).
--   objective_curriculum_map the SEPARATE, optional link from a teaching
--                           objective to an official curriculum node
--                           (curriculum_nodes). A model may PROPOSE; only a
--                           human can VERIFY, and only verified rows may ever
--                           be reported as curriculum coverage. No forced
--                           mapping: a unit with no honest match has no row.
--   sk_book_blocks          the chapter's content blocks (paragraph, key_idea,
--                           misconception, worked_example, figure, …) keyed by
--                           section and unit, so a unit's blocks are
--                           queryable for grounding (contracts §1.2 SourceRef
--                           "book:<product>/<chapter>/<sid>#<blockId>").
--   topic_questions.teaching_objective_id
--                           the item ↔ objective link (plan §10): an item
--                           whose objective is not validated contributes no
--                           mastery evidence. Plain FK, ON DELETE SET NULL.
--
-- Access: RLS on everywhere; the service role (worker, exporter, console
-- routes) writes. Signed-in users may READ approved products, their units and
-- VALIDATED objectives only — nothing else (maps, blocks and questions stay
-- server-side; questions and mark schemes are never exposed, contracts §1.2).
--
-- Additive only (expand-then-contract); rollback = 0156_sk_book_content_rollback.sql.
-- ============================================================================

begin;

-- ── 1. products ──────────────────────────────────────────────────────────────
create table if not exists public.sk_book_products (
  id                  uuid        primary key default gen_random_uuid(),
  slug                text        not null unique,
  title               text        not null,
  edition             text,
  isbn                text,
  subject             text,
  curriculum_id       uuid        references public.curricula(id) on delete set null,
  languages           text[]      not null default '{en}',
  status              text        not null default 'draft'
                                  check (status in ('draft', 'approved', 'retired')),
  manuscript_version  text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
drop trigger if exists sk_book_products_touch on public.sk_book_products;
create trigger sk_book_products_touch before update on public.sk_book_products
  for each row execute function touch_updated_at();

-- ── 2. units ────────────────────────────────────────────────────────────────
create table if not exists public.sk_book_units (
  id           uuid        primary key default gen_random_uuid(),
  product_id   uuid        not null references public.sk_book_products(id) on delete cascade,
  chapter      int         not null check (chapter >= 1),
  unit_key     text        not null,                 -- 'u1' … 'uN' in teaching order
  section_sid  text        not null,                 -- the manuscript section this unit teaches ('s1' …)
  title        text        not null,
  sort_order   int         not null default 0,       -- the contracts' "order"
  node_codes   text[]      not null default '{}',    -- curriculum codes the manuscript PLAN cites (informational; the map is the link)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (product_id, chapter, unit_key),
  unique (product_id, chapter, section_sid)
);
create index if not exists sk_book_units_chapter_idx on public.sk_book_units (product_id, chapter, sort_order);
drop trigger if exists sk_book_units_touch on public.sk_book_units;
create trigger sk_book_units_touch before update on public.sk_book_units
  for each row execute function touch_updated_at();

-- ── 3. teaching objectives (internal) ───────────────────────────────────────
create table if not exists public.teaching_objectives (
  id            uuid        primary key default gen_random_uuid(),
  product_id    uuid        not null references public.sk_book_products(id) on delete cascade,
  chapter       int         not null check (chapter >= 1),
  unit_key      text        not null,
  text          text        not null,
  status        text        not null default 'draft' check (status in ('draft', 'validated')),
  validated_by  uuid        references public.profiles(id) on delete set null,
  validated_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- one objective per unit (plan §10: "one per unit"); the unit must exist
  unique (product_id, chapter, unit_key),
  foreign key (product_id, chapter, unit_key)
    references public.sk_book_units (product_id, chapter, unit_key) on delete cascade,
  check (status <> 'validated' or (validated_by is not null and validated_at is not null))
);
drop trigger if exists teaching_objectives_touch on public.teaching_objectives;
create trigger teaching_objectives_touch before update on public.teaching_objectives
  for each row execute function touch_updated_at();

-- ── 4. objective → curriculum map (optional, human-verified) ────────────────
create table if not exists public.objective_curriculum_map (
  id                     uuid        primary key default gen_random_uuid(),
  teaching_objective_id  uuid        not null references public.teaching_objectives(id) on delete cascade,
  curriculum_node_id     uuid        not null references public.curriculum_nodes(id) on delete cascade,
  relation               text        not null default 'supports'
                                     check (relation in ('covers', 'partial', 'supports')),
  map_confidence         numeric(3,2) not null default 0.5
                                     check (map_confidence >= 0 and map_confidence <= 1),
  mapped_by              text        not null default 'model' check (mapped_by in ('model', 'human')),
  reviewed_by            uuid        references public.profiles(id) on delete set null,
  reviewed_at            timestamptz,
  status                 text        not null default 'proposed'
                                     check (status in ('proposed', 'verified', 'rejected')),
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (teaching_objective_id, curriculum_node_id),
  -- the B1 gate: a row is verified or rejected only by a named reviewer
  check (status = 'proposed' or (reviewed_by is not null and reviewed_at is not null))
);
create index if not exists objective_curriculum_map_node_idx
  on public.objective_curriculum_map (curriculum_node_id, status);
drop trigger if exists objective_curriculum_map_touch on public.objective_curriculum_map;
create trigger objective_curriculum_map_touch before update on public.objective_curriculum_map
  for each row execute function touch_updated_at();

-- ── 5. blocks (grounding) ───────────────────────────────────────────────────
create table if not exists public.sk_book_blocks (
  id           uuid        primary key default gen_random_uuid(),
  product_id   uuid        not null references public.sk_book_products(id) on delete cascade,
  chapter      int         not null check (chapter >= 1),
  section_sid  text        not null,
  block_index  int         not null check (block_index >= 0),   -- position within the section
  block_type   text        not null,                            -- paragraph | key_idea | key_term | misconception | think | worked_example | figure | figure_group | list | table | extension
  body         jsonb       not null default '{}'::jsonb,       -- the block as drafted, minus source_refs
  source_refs  text[]      not null default '{}',
  unit_key     text,                                            -- the unit that teaches this section (null until the unit exists)
  created_at   timestamptz not null default now(),
  unique (product_id, chapter, section_sid, block_index),
  foreign key (product_id, chapter, unit_key)
    references public.sk_book_units (product_id, chapter, unit_key) on delete set null
);
create index if not exists sk_book_blocks_unit_idx on public.sk_book_blocks (product_id, chapter, unit_key, block_index);

-- ── 6. item ↔ objective ─────────────────────────────────────────────────────
alter table public.topic_questions
  add column if not exists teaching_objective_id uuid references public.teaching_objectives(id) on delete set null;
create index if not exists topic_questions_teaching_objective_idx
  on public.topic_questions (teaching_objective_id) where teaching_objective_id is not null;
comment on column public.topic_questions.teaching_objective_id is
  'SK: the internal teaching objective this item gives evidence for (plan §10). Only an item whose objective is validated contributes mastery evidence.';

-- ── 7. access ───────────────────────────────────────────────────────────────
alter table public.sk_book_products        enable row level security;
alter table public.sk_book_units           enable row level security;
alter table public.teaching_objectives     enable row level security;
alter table public.objective_curriculum_map enable row level security;
alter table public.sk_book_blocks          enable row level security;

revoke all on public.sk_book_products        from anon, authenticated;
revoke all on public.sk_book_units           from anon, authenticated;
revoke all on public.teaching_objectives     from anon, authenticated;
revoke all on public.objective_curriculum_map from anon, authenticated;
revoke all on public.sk_book_blocks          from anon, authenticated;

-- signed-in users: approved products, their units, and validated objectives — read only
grant select on public.sk_book_products    to authenticated;
grant select on public.sk_book_units       to authenticated;
grant select on public.teaching_objectives to authenticated;

drop policy if exists sk_book_products_read_approved on public.sk_book_products;
create policy sk_book_products_read_approved on public.sk_book_products
  for select to authenticated using (status = 'approved');

drop policy if exists sk_book_units_read_approved on public.sk_book_units;
create policy sk_book_units_read_approved on public.sk_book_units
  for select to authenticated using (
    exists (select 1 from public.sk_book_products p where p.id = product_id and p.status = 'approved'));

drop policy if exists teaching_objectives_read_validated on public.teaching_objectives;
create policy teaching_objectives_read_validated on public.teaching_objectives
  for select to authenticated using (
    status = 'validated'
    and exists (select 1 from public.sk_book_products p where p.id = product_id and p.status = 'approved'));

-- objective_curriculum_map and sk_book_blocks: no policies — service role only.

comment on table public.sk_book_products is 'SK: a study-guide book (plan §10). Students read approved rows only.';
comment on table public.sk_book_units is 'SK: one teaching unit per manuscript plan section of a chapter; unit_key u1…uN in teaching order.';
comment on table public.teaching_objectives is 'SK: INTERNAL teaching objective, one per unit. Tutoring and mastery key on this id; a curriculum mapping is optional (objective_curriculum_map).';
comment on table public.objective_curriculum_map is 'SK: optional link from a teaching objective to a curriculum node. Model rows are proposed; only a human verifies; only verified rows count as curriculum coverage.';
comment on table public.sk_book_blocks is 'SK: the chapter''s drafted blocks by section/unit for grounding. Service role only.';

commit;
