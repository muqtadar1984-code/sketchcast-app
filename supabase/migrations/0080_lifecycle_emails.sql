-- Lifecycle reminder emails — activation nudges for users who registered but
-- never got to a first lesson.
--
-- Context: of 73 real users, 4 have ever generated anything. Activation, not
-- retention or quality, is the constraint. This is the first email SketchCast
-- has ever sent TO A USER (notify.ts only ever emailed the founder), so the
-- guardrails matter more than the feature.
--
-- Two tables' worth of state, both deliberately small:
--   lifecycle_emails   one row per (user, segment) — makes a second send of the
--                      same nudge impossible, enforced by the DB rather than by
--                      remembering to check.
--   profiles.email_optout_at  unsubscribe. Set once, honoured for ever.

create table if not exists public.lifecycle_emails (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  segment    text not null check (segment in ('no_book', 'no_generation')),
  sent_at    timestamptz not null default now(),
  -- THE guard: one nudge per user per segment, for the lifetime of the account.
  -- A cron that runs twice, a redeploy mid-run, or a retry cannot double-send.
  unique (user_id, segment)
);

comment on table public.lifecycle_emails is
  'Sent-marker for activation reminder emails. Written only AFTER a successful '
  'send, so a provider failure retries on the next run instead of being lost.';

create index if not exists lifecycle_emails_user_idx
  on public.lifecycle_emails (user_id);

-- Service-role only: RLS on with no policies denies every normal client, and
-- the cron route uses the admin client which bypasses RLS.
alter table public.lifecycle_emails enable row level security;

-- Unsubscribe. Nullable timestamp rather than a boolean so we keep WHEN, which
-- is what a PDPA/DPDP/GDPR request actually asks for.
alter table public.profiles
  add column if not exists email_optout_at timestamptz;

comment on column public.profiles.email_optout_at is
  'Set when the user clicks unsubscribe. Suppresses ALL lifecycle email; never '
  'suppresses transactional mail (password reset, invites).';


-- Candidate rows for the reminder cron. This function only gathers FACTS — it
-- deliberately makes no decision about who gets what, because that logic lives
-- in src/utils/lifecycle/segments.ts where it is unit-tested.
--
-- TEACHERS ONLY, and that is a correctness rule, not a preference: of 89
-- accounts, 43 are students and 8 are parents. Neither uploads textbooks, and
-- students are minors — emailing them lifecycle content would be both wrong
-- advice and a child-data problem.
--
-- SECURITY DEFINER because it reads auth.users, which the anon/authenticated
-- roles cannot. Execute is granted to service_role only.
create or replace function public.lifecycle_email_candidates(p_since timestamptz)
returns table (
  user_id             uuid,
  email               text,
  first_name          text,
  created_at          timestamptz,
  opted_out_at        timestamptz,
  book_count          bigint,
  oldest_book_at      timestamptz,
  newest_book_title   text,
  generation_attempts bigint,
  already_sent        text[]
)
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    u.id,
    u.email::text,
    -- First name only; empty string collapses to NULL so the template can fall
    -- back to a neutral greeting rather than render "Hi ,".
    nullif(split_part(coalesce(p.full_name, ''), ' ', 1), ''),
    u.created_at,
    p.email_optout_at,
    (select count(*) from books b where b.owner_id = u.id),
    (select min(b.created_at) from books b where b.owner_id = u.id),
    (select b.title from books b where b.owner_id = u.id order by b.created_at desc limit 1),
    -- ATTEMPTS, every status. Counting successes here would select the user
    -- whose 23 generations we broke ourselves.
    (select count(*) from generations g where g.owner_id = u.id),
    coalesce(
      (select array_agg(le.segment) from lifecycle_emails le where le.user_id = u.id),
      '{}'::text[]
    )
  from auth.users u
  join profiles p on p.id = u.id
  where p.role::text = 'teacher'
    and u.created_at >= p_since
    and u.email is not null
    and u.email_confirmed_at is not null;
$$;

revoke all on function public.lifecycle_email_candidates(timestamptz) from public;
revoke all on function public.lifecycle_email_candidates(timestamptz) from anon, authenticated;
grant execute on function public.lifecycle_email_candidates(timestamptz) to service_role;
