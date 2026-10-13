-- 0124: exclude an account from the console's metrics without calling it staff.
--
-- The console leaves two kinds of account out of every number: seeded demo
-- tenants (profiles.is_demo, 0081) and SketchCast staff (platform_admins,
-- 0014). A third kind exists in practice: a real user's account that staff
-- also use to test with (the founder's and the reviewer's personal Gmail
-- logins). They ARE users — a staff row would hand them the staff tier and
-- the Staff tab — but their kits are not customer usage, and they were
-- sitting at the top of "Top teachers by kits" (founder, 2026-10-08).
--
-- One boolean, read by metricsExcludedIds() beside is_demo, toggled from the
-- account's console page ("Exclude from metrics" / "Include in metrics",
-- /api/console/ops metrics_exclude / metrics_include). The roster still lists
-- the account as a user; only the metric pages skip it.
alter table public.profiles
  add column if not exists metrics_excluded boolean not null default false;

comment on column public.profiles.metrics_excluded is
  'Console metrics skip this account (a real user staff also test with). Not staff, not demo.';
