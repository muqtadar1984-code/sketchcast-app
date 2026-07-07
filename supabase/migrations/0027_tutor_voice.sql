-- 0027 — AI Tutor voice (M4): a spend cap for PAID (ElevenLabs) synthesis and a
-- private bucket for cached coach-voice clips.
--
-- The free coach voice speaks in the browser ($0) and never touches this. Paid
-- synthesis is metered per account per month; the reserve function only commits
-- characters that fit under the cap, so concurrent requests can't overspend, and
-- a cap-hit degrades to the free voice. Cached clips live in a PRIVATE bucket and
-- are handed out as short-lived signed URLs — never public.
--
-- Additive + idempotent. Safe to run as ONE execution.

-- ── tts_usage — running monthly character total per account ──────────────────
create table if not exists public.tts_usage (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  period     text not null,             -- 'YYYY-MM'
  provider   text not null,             -- 'elevenlabs' (only paid providers are metered)
  chars      int  not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, period, provider)
);
alter table public.tts_usage enable row level security; -- service-role only
revoke all on public.tts_usage from anon, authenticated;

-- Atomic reservation: bump the counter ONLY if the new total stays within the
-- cap; return whether the reservation succeeded. SECURITY DEFINER so the tutor
-- route can call it with the service role.
create or replace function public.tutor_tts_reserve(
  p_user uuid, p_period text, p_provider text, p_chars int, p_cap int
) returns boolean
  language plpgsql volatile security definer set search_path = public as $$
declare
  ok boolean;
begin
  insert into public.tts_usage (user_id, period, provider, chars)
    values (p_user, p_period, p_provider, 0)
    on conflict (user_id, period, provider) do nothing;

  update public.tts_usage
     set chars = chars + greatest(0, p_chars),
         updated_at = now()
   where user_id = p_user and period = p_period and provider = p_provider
     and chars + greatest(0, p_chars) <= p_cap
   returning true into ok;

  return coalesce(ok, false);
end
$$;
revoke all on function public.tutor_tts_reserve(uuid, text, text, int, int) from anon, authenticated;

-- ── private bucket for cached coach-voice clips ──────────────────────────────
insert into storage.buckets (id, name, public)
  values ('tutor-voice', 'tutor-voice', false)
  on conflict (id) do nothing;
-- No storage policies: only the service role reads/writes; playback is via
-- short-lived signed URLs minted server-side after the access check.
