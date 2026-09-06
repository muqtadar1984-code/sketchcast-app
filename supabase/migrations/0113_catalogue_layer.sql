-- 0113_catalogue_layer
--
-- The catalogue layer between a curriculum and its canonical topics — the
-- three refinements from the curriculum review of 2026-09-06 (plan §10, Phase
-- 2a). The bridge itself (curriculum_nodes ↔ topic_curriculum_map ↔ topics)
-- shipped in 0112; this makes it explicit and lets a MODEL propose the
-- groupings a curator then approves, instead of mapping 200 objectives one at
-- a time.
--
-- WHAT IT DOES
--   1. curriculum_nodes.kind — strand | sub_strand | objective | unit |
--      chapter | topic. Until now the level was implied by the code's shape
--      and its depth; new curricula (IB, Pearson, ICSE…) will not share those
--      shapes, so the level becomes a column. Backfilled for the two loaded
--      curricula from their code patterns (Cambridge: "7/Biology" strand,
--      "7/Bs" sub-strand, "7Bs.01" objective; CBSE: "cbse:9:U1" unit,
--      "cbse:9:U1:01" topic, "cbse:6:ch01" chapter). Nullable: a seed may
--      leave it unset and the loader infers it the same way.
--   2. topic_candidates.node_ids + rationale — one candidate may now propose a
--      topic for a GROUP of objectives ("Cells" for 7Bs.01–7Bs.05), with the
--      model's one-line reason. node_id stays the anchor (the sub-strand or
--      unit the group belongs to); node_ids lists the objectives to map when
--      the candidate is created or merged.
--   3. jobs.params — an input payload for observer jobs that own no
--      generation and no book. topic_derive needs a curriculum id; nothing on
--      jobs could carry one (stage is the worker's progress, usage its cost).
--      One live derive per curriculum, enforced like the harvest index in 0112.
--
-- WHAT IT DOES NOT DO
--   No new tables, no policies, no change to existing rows beyond the kind
--   backfill, no change to any generations trigger.
--
-- ROLLBACK: drop the three columns and the index.
--
-- Applied to prod by the agent on the founder's explicit 2026-09-06 instruction.

begin;

-- ── 1. curriculum_nodes.kind ─────────────────────────────────────────────────
alter table public.curriculum_nodes
  add column if not exists kind text
  check (kind is null or kind in ('strand', 'sub_strand', 'objective', 'unit', 'chapter', 'topic'));
create index if not exists curriculum_nodes_kind_idx on public.curriculum_nodes (curriculum_id, kind);

-- Backfill from the code shapes the two shipped seeds use.
update public.curriculum_nodes set kind = 'objective'
 where kind is null and code ~ '^[0-9](Bs|Bp|Be|Cm|Cp|Cc|Pf|Pl|Ps|ESp|ESc|ESs|TWSm|TWSp|TWSc|TWSa|SIC)\.[0-9]{2}$';
update public.curriculum_nodes set kind = 'strand'
 where kind is null and code ~ '^[0-9]/' and parent_id is null;
update public.curriculum_nodes set kind = 'sub_strand'
 where kind is null and code ~ '^[0-9]/' and parent_id is not null;
update public.curriculum_nodes set kind = 'chapter'
 where kind is null and code ~ '^cbse:[0-9]+:ch[0-9]+$';
update public.curriculum_nodes set kind = 'unit'
 where kind is null and code ~ '^cbse:[0-9]+:U[0-9]+$';
update public.curriculum_nodes set kind = 'topic'
 where kind is null and code ~ '^cbse:[0-9]+:U[0-9]+:[0-9]+$';

-- ── 2. Grouped candidates ────────────────────────────────────────────────────
alter table public.topic_candidates
  add column if not exists node_ids uuid[] not null default '{}',
  add column if not exists rationale text;

-- ── 3. Observer-job inputs ───────────────────────────────────────────────────
alter table public.jobs add column if not exists params jsonb;
create unique index if not exists jobs_one_live_derive
  on public.jobs ((params->>'curriculum_id'))
  where type = 'topic_derive' and status in ('queued', 'processing');

commit;
