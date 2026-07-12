-- LOCAL-ONLY seed (runs automatically AFTER migrations on `supabase start` / `db reset`).
-- NEVER applied to production — prod's platform provides these grants automatically.
--
-- Why this exists: our migrations assume Supabase Cloud's default-privilege grants (every
-- table the `postgres` role creates is auto-granted to anon/authenticated/service_role). The
-- local CLI did NOT apply that to migration-created tables, so all three roles had ZERO grants
-- (the app + seed got "permission denied") and every migration's targeted `revoke` was a no-op.
-- We replicate the base grants, then re-apply the security-critical lockdowns for parity.

-- ── Base grants (what Supabase Cloud auto-provides) ──
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all routines in schema public to anon, authenticated, service_role;
-- Future objects (e.g. tables a later re-run creates) inherit the same grants.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on routines to anon, authenticated, service_role;

-- ── Re-apply the migrations' lockdowns the base grant above re-opened (prod parity) ──
-- service_role keeps full access everywhere (it's the trusted bypass role) — do NOT revoke from it.

-- 0010: profiles — role/school_id are service-role-only; users may edit only safe fields.
revoke update on public.profiles from anon, authenticated;
grant update (full_name, username, parent_email, must_reset_password) on public.profiles to authenticated;

-- 0014: platform-admin surfaces are staff/service-role only.
revoke all on public.platform_admins from anon, authenticated;
revoke all on public.platform_audit_log from anon, authenticated;
revoke update, delete on public.platform_issues from anon, authenticated;

-- 0025–0034: tutor / assistant internals are service-role only (RLS also has no policies for them).
revoke all on public.chapter_grounding from anon, authenticated;
revoke all on public.tutor_qa from anon, authenticated;
revoke insert, update, delete on public.mastery_events from anon, authenticated;
revoke all on public.tts_usage from anon, authenticated;
revoke all on public.tutor_sketch from anon, authenticated;
revoke all on public.tutor_sketch_usage from anon, authenticated;
revoke insert, update, delete on public.tutor_board_event from anon, authenticated;
revoke all on public.tutor_tal_cache from anon, authenticated;
revoke insert, update, delete on public.assistant_sessions from anon, authenticated;

-- 0022: billing bookkeeping is service-role write-only.
revoke all on public.webhook_events from anon, authenticated;

-- Note: a few finer-grained GRANT-level lockdowns from other migrations are not re-listed here;
-- RLS (intact from the migrations) is the primary protection locally. Good enough for QA.
