-- 0096 — Present mode, Phase 0: where an ink-latency probe run is RECORDED.
--
-- Present mode (docs/PRESENT-MODE.md) is a whiteboard a teacher drives on a
-- classroom panel, and the decision that gates the whole build is whether live
-- ink feels immediate on the hardware a school actually owns. Phase 0 is that
-- measurement, and it deliberately runs on real panels rather than a laptop.
--
-- WHY A TABLE AND NOT A DOWNLOAD BUTTON. The probe is opened on a wall-mounted
-- panel in a classroom: often no keyboard, no file manager, no way to get a
-- JSON file off the device and into a decision. If the result cannot travel by
-- itself, the run does not happen. So the page posts its report here and the
-- device table grows every time another panel is tried — which is the whole
-- point of "runs on any device": the floor is defined by the WORST machine
-- anyone actually put a finger on, and that is only knowable if the bad results
-- are kept too.
--
-- This is measurement scaffolding, not a product surface. It holds no student
-- data, no lesson content and no identifiers beyond the teacher who ran it, and
-- it can be dropped the day Phase 0 closes.
--
-- ⚠️  NUMBERING: this file was drafted as 0094 and renumbered to 0096 on
-- 2026-08-27. Both 0094 (attribution) and 0095 (refund_when_nothing_was_
-- delivered) were written AND APPLIED TO PRODUCTION in the days between this
-- migration being drafted and being applied, so the number it was born with was
-- taken twice over. Before claiming the next free number, check `list_migrations`
-- against the LIVE DATABASE as well as this folder — the two are NOT 1:1. The
-- upstream ledger currently holds three entries for 0094 alone (`attribution`,
-- `attribution_durable_rows`, `profiles_signup_source`), because that file was
-- applied in pieces; only the first name matches a file here. Counting files is
-- therefore not a safe way to find the next number, and this folder also carries
-- a pre-existing collision at 0052 (two different files share the prefix).
--
-- The main Present tables (present_sessions / present_pages / present_strokes /
-- present_items) are Phase 2 and move to 0097. They must not block a Phase 0
-- measurement on being written.
--
-- Additive + idempotent. Safe to re-run.

-- DDL on a live database should never wait behind a long transaction. The FK
-- below needs a brief lock on `profiles` — the busiest table in the app — and
-- without a timeout a migration that cannot get it will QUEUE, and everything
-- arriving after it queues behind that. Five seconds is far more than this needs
-- and short enough that a failure is a failed migration rather than an outage.
set local lock_timeout = '5s';

create table if not exists public.present_probe (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  -- Nullable + ON DELETE SET NULL: a measurement of a PANEL stays true after
  -- the account that took it is gone. The device table is the asset here.
  teacher_id   uuid references public.profiles(id) on delete set null,
  -- What the person typed before running: "Hisense 75in, Block B" / "my iPad".
  -- Free text on purpose — nobody can enumerate classroom hardware in advance,
  -- and a wrong dropdown would just be filled in with the nearest lie.
  label        text,
  user_agent   text,
  -- probeStatic() from src/board/capabilities.ts — what the browser CLAIMS.
  caps         jsonb not null default '{}'::jsonb,
  -- What real strokes revealed: pointer types, whether pressure genuinely
  -- varies, coalesced points per move. Half the answer is only knowable here.
  observations jsonb not null default '{}'::jsonb,
  -- Per-strategy latency samples + the tier the board chose for this device.
  results      jsonb not null default '{}'::jsonb
);

create index if not exists present_probe_created_idx on public.present_probe (created_at desc);
-- teacher_id is BOTH the only column the read path filters on and the FK column.
-- Unindexed, the GET route scans, and — the reason that actually matters —
-- Postgres has to scan this table on every `delete from profiles` to check the
-- reference, so an unindexed FK here would tax account deletion elsewhere in the
-- app for a measurement table nobody else touches.
create index if not exists present_probe_teacher_idx on public.present_probe (teacher_id);

alter table public.present_probe enable row level security;
-- Belt AND braces, matching 0079 / 0086 / 0093. RLS alone does hold this shut
-- today — there is no write policy, so writes are denied by default — but that
-- is ONE mechanism, and it is the mechanism a future `disable row level
-- security` removes in a single statement. The grant layer denies independently.
-- Nothing legitimate loses access: both routes read and write through the
-- service role, which bypasses both layers, so `authenticated` never needed a
-- grant here at all.
revoke all on public.present_probe from anon, authenticated;

-- READ-ONLY to the person who ran it, and to nobody else. There is no insert,
-- update or delete policy at all: the /api/present/probe route writes under the
-- service role after checking the allowlist, so a signed-in user cannot forge a
-- device report, and RLS-with-no-write-policy is what makes that structural
-- rather than a convention the next route handler might forget.
drop policy if exists present_probe_own_read on public.present_probe;
create policy present_probe_own_read on public.present_probe
  for select using (teacher_id = auth.uid());

comment on table public.present_probe is
  'Present mode Phase 0: one row per ink-latency probe run on a real device. Written by /api/present/probe under the service role; readable only by the teacher who ran it. Measurement scaffolding — droppable when Phase 0 closes.';
