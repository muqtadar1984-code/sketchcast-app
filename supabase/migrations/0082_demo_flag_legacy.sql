-- 0082 — Flag legacy-seeder demo identities that 0081's census missed.
--
-- 0081's recon concluded no demo.* accounts existed in prod; the founder then
-- found demo.parent1@sketchcast.app (created 2026-07-04, no school, no
-- parent_links, zero activity) sitting in the real-users tab. The 0081 check
-- looked for @ln.app and demo.s* shapes; this account matches the broader
-- legacy identity pattern the console's password helper already recognises:
-- a "demo."-prefixed local-part on the bare sketchcast.app (or the synthetic
-- students.sketchcast.app) domain — src/utils/demo.ts documents why no real
-- account can look like this (organic signups on our own domain cannot
-- confirm a mailbox that does not exist; real students' synthetic addresses
-- are name-derived by src/utils/student.ts, never "demo."-prefixed).
--
-- Rule-based like 0081, so any further stray with this shape is covered on
-- re-run. Idempotent. The Demo tab shows "—" for these (password unknown —
-- the legacy local-only seeder used a different one).

update public.profiles p
   set is_demo = true
  from auth.users u
 where u.id = p.id
   and not p.is_demo
   and lower(u.email) ~ '^demo\.[^@]+@(students\.)?sketchcast\.app$';
