-- 0031 — Clear the stale must_reset_password backlog before enforcement goes live.
--
-- profiles.must_reset_password has been WRITTEN since invited-student provisioning
-- (migration 0010) but never ENFORCED anywhere — so today every student account
-- ever created still carries must_reset_password = true. The password-recovery
-- feature now enforces it (the dashboard redirects to /auth/update-password while
-- the flag is set), which would otherwise force EVERY existing student — including
-- those who know their password — through a reset on their next sign-in.
--
-- Clear the backlog once so enforcement only bites GO-FORWARD accounts:
--   * a fresh /api/reset-password hand-out (the intended forced change), and
--   * students provisioned AFTER this migration (their first-login "set your own
--     password" step, which the invite copy already promises).
-- Existing users are unaffected — exactly the current behaviour.
--
-- One-time data fix; re-running is a harmless no-op.

update public.profiles
set must_reset_password = false
where must_reset_password is true;
