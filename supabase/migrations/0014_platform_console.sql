-- 0014 — Platform console (SketchCast staff): admin membership, ops audit
-- trail, and tech-issue tracking.
--
-- Platform admin is a MEMBERSHIP TABLE, not a user_role value — same doctrine
-- as coordinator grants: no ALTER TYPE, and a staff member keeps their normal
-- school-side identity. Deny-by-default RLS: platform_admins and the audit log
-- have NO policies (service role only); issues let reporters insert + read
-- their own rows, lifecycle writes are service-role only.
--
-- Run in the Supabase SQL editor as ONE execution. Idempotent.

-- ── Staff membership ──────────────────────────────────────────────────────────
create table if not exists public.platform_admins (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  granted_by uuid references public.profiles(id) on delete set null,
  note       text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz            -- soft revoke keeps audit continuity
);

create or replace function public.is_platform_admin(uid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from platform_admins
                  where user_id = uid and revoked_at is null) $$;

alter table public.platform_admins enable row level security;
revoke all on public.platform_admins from anon, authenticated;

-- ── Immutable ops audit trail (service-role writes only) ─────────────────────
create table if not exists public.platform_audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references public.profiles(id) on delete set null,
  action      text not null,   -- 'issue_status'|'suspend'|'cap_override'|'takedown'|'view_as'|…
  target_kind text,            -- 'profile'|'book'|'generation'|'issue'|'school'
  target_id   uuid,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists pal_created_idx on public.platform_audit_log (created_at desc);
create index if not exists pal_target_idx  on public.platform_audit_log (target_kind, target_id);
alter table public.platform_audit_log enable row level security;
revoke all on public.platform_audit_log from anon, authenticated;

-- ── Tech issues ───────────────────────────────────────────────────────────────
create table if not exists public.platform_issues (
  id            uuid primary key default gen_random_uuid(),
  reporter_id   uuid references public.profiles(id) on delete set null,
  reporter_role user_role,               -- snapshot at report time
  school_id     uuid references public.schools(id) on delete set null,
  category      text not null default 'other'
                check (category in ('video','deck_docs','quiz','upload','login','speed','other')),
  severity      text not null default 'normal'
                check (severity in ('low','normal','high','critical')),
  status        text not null default 'open'
                check (status in ('open','triaged','in_progress','resolved')),
  title         text not null check (char_length(title) <= 200),
  description   text check (char_length(description) <= 4000),
  context       jsonb,                   -- {url, user_agent, recent_job_errors[]}
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  resolution_note text
);
create index if not exists pi_status_idx   on public.platform_issues (status, created_at desc);
create index if not exists pi_reporter_idx on public.platform_issues (reporter_id);

alter table public.platform_issues enable row level security;
drop policy if exists pi_report_insert on public.platform_issues;
create policy pi_report_insert on public.platform_issues for insert
  with check (reporter_id = auth.uid());
drop policy if exists pi_report_read on public.platform_issues;
create policy pi_report_read on public.platform_issues for select
  using (reporter_id = auth.uid());
-- No UPDATE/DELETE policies for authenticated (lifecycle is service-role only);
-- revoke closes the door even if a permissive policy appears later.
revoke update, delete on public.platform_issues from anon, authenticated;

drop trigger if exists platform_issues_touch on public.platform_issues;
create trigger platform_issues_touch before update on public.platform_issues
  for each row execute function touch_updated_at();
