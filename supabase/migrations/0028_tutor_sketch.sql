-- 0028 — AI Tutor Phase 2: whiteboard "sketch" clips.
--
-- The Coach can DRAW a short animated explainer instead of only talking. This is
-- self-contained on purpose: the tutor_sketch table is BOTH the render queue AND
-- the cross-student cache, so sketches never clutter the teacher's content library
-- / analytics / health (unlike routing them through generations+jobs). The worker
-- polls this table, renders ONE mp4 with the native slide renderer (PIL mask-reveal
-- + pen) + free Edge TTS + ffmpeg (~$0 compute), and caches by spec hash so an
-- identical sketch replays instantly for $0 across every student. Per-account
-- monthly cap. Rendered clips live in a PRIVATE bucket, served via signed URLs.
--
-- Additive + idempotent. Safe to run as ONE execution.

-- ── tutor_sketch — render queue + shared clip cache ──────────────────────────
-- One row per unique (book_id, chapter_num, spec_hash). The app enqueues by
-- upserting on that key (so concurrent identical requests COALESCE onto one
-- render); the worker claims 'queued' rows, renders, and flips to 'done' with the
-- storage_path. SERVICE-ROLE ONLY — the worker and the /api/tutor/sketch routes
-- touch it; no client ever does.
create table if not exists public.tutor_sketch (
  id            uuid primary key default gen_random_uuid(),
  book_id       uuid not null references public.books(id) on delete cascade,
  chapter_num   int  not null,
  spec_hash     text not null,               -- sha256 over (contract_version, spec, narration, voice)
  spec          jsonb not null,              -- {heading, points, visual} — the slide the coach draws
  narration     text not null,               -- what the coach says while drawing
  voice_id      text,                        -- registry voice id (defaults to edge-aria)
  owner_id      uuid,                         -- the LESSON owner (branding + entitlement source)
  requested_by  uuid references public.profiles(id) on delete set null,
  status        text not null default 'queued' check (status in ('queued','processing','done','error')),
  storage_path  text,                         -- set on done: path inside the tutor-sketch bucket
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (book_id, chapter_num, spec_hash)
);
create index if not exists tutor_sketch_queue on public.tutor_sketch (status, created_at);
alter table public.tutor_sketch enable row level security; -- service-role only
revoke all on public.tutor_sketch from anon, authenticated;

-- ── monthly per-account sketch cap (mold: tutor_tts_reserve in 0027) ──────────
create table if not exists public.tutor_sketch_usage (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  period     text not null,               -- 'YYYY-MM'
  count      int  not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, period)
);
alter table public.tutor_sketch_usage enable row level security; -- service-role only
revoke all on public.tutor_sketch_usage from anon, authenticated;

-- Atomic reservation: bump the counter ONLY if it stays within the cap; return
-- whether it succeeded. Reserved only on a cache MISS, so a $0 replay never spends
-- quota. SECURITY DEFINER so the route can call it with the service role.
create or replace function public.tutor_sketch_reserve(
  p_user uuid, p_period text, p_cap int
) returns boolean
  language plpgsql volatile security definer set search_path = public as $$
declare
  ok boolean;
begin
  insert into public.tutor_sketch_usage (user_id, period, count)
    values (p_user, p_period, 0)
    on conflict (user_id, period) do nothing;

  update public.tutor_sketch_usage
     set count = count + 1, updated_at = now()
   where user_id = p_user and period = p_period and count + 1 <= p_cap
   returning true into ok;

  return coalesce(ok, false);
end
$$;
revoke all on function public.tutor_sketch_reserve(uuid, text, int) from anon, authenticated;

-- ── private bucket for rendered sketch clips ─────────────────────────────────
insert into storage.buckets (id, name, public)
  values ('tutor-sketch', 'tutor-sketch', false)
  on conflict (id) do nothing;
-- No storage policies: only the service role reads/writes; playback is via
-- short-lived signed URLs minted server-side after the tutor access check.
