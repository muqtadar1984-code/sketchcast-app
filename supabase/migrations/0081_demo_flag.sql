-- 0081 — Durable is_demo marker on profiles, so the console can (a) list demo
-- accounts in their own tab and (b) exclude them from every metric.
--
-- WHY A COLUMN. "Is this a demo account?" has so far been an ad-hoc heuristic
-- re-derived on every surface, and the one obvious shortcut is a TRAP: real
-- students ALSO get synthetic @students.sketchcast.app addresses
-- (src/utils/student.ts mints one for every roster/parent-created child), and
-- real parents link to those children via parent_links. The email domain alone
-- must therefore NEVER be the demo criterion. Each backfill rule below states
-- why no real user can match it.
--
-- CENSUS (verified against prod 2026-08-17; the backfill flags exactly 48):
--   37  Demo School members    profiles.school_id → schools.slug 'demo':
--                              1 principal + 11 teachers (@demo.sketchcast.app)
--                              + 25 students (@students.…, school_id SET)
--    1  Demo School parent     parent@demo.sketchcast.app — school_id IS NULL
--                              by design (parents never carry school_id), so
--                              only the email rule can reach it
--    1  Test Academy           principal.test@sketchcast.app (slug 'test-academy')
--    9  standalone seed batch  students-domain, school_id NULL, created
--                              2026-06-29 (aisha.khan … julia.rossi): zero
--                              parent_links, zero submissions, zero progress
--    0  @ln.app / demo.s* strays — checked: none exist in prod
--       (supabase/seed_demo.mjs hard-refuses non-local URLs, so it never wrote prod)
--
-- Deliberately NOT flagged: student@students.sketchcast.app (2026-08-10,
-- school NULL, no parent link, origin unknown) — a post-launch row that rule
-- 4's time fence excludes on purpose. Flag it by hand if it proves synthetic.
--
-- Idempotent (re-runnable: every statement is a no-op the second time).
-- Requires 0018 (parent_links) + 0042 (schools.slug). Reads auth.users, which
-- is fine for a migration (runs as the database owner, not through PostgREST).

-- ── 1. The marker ────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists is_demo boolean not null default false;

comment on column public.profiles.is_demo is
  'Seed/demo account: listed in the console''s Demo tab and excluded from every metric. Backfilled by 0081 (rules, not uuids); kept true on future re-seeds by scripts/seed-school.ts and scripts/add-subject-teachers.ts. Service-role-only — not in authenticated''s column-scoped UPDATE grant.';

-- Client-write protection comes for free here, but on purpose, so state it:
-- the authenticated role's UPDATE on profiles is COLUMN-scoped (the 0010
-- posture that already protects role/school_id/max_*), and a column added
-- later is NOT in that grant list; profiles has no INSERT policy (rows are
-- born in handle_new_user()). So a signed-in user can neither set nor clear
-- their own flag — only the service role (console, seeders, this migration)
-- ever writes it. No extra revoke needed.

-- ── 2. Backfill — RULES, not hardcoded uuids ─────────────────────────────────

-- Rule 1 · members of the two demo tenants, keyed by slug.
-- SAFE because slug is the unique tenant key (0042) and prod holds exactly two
-- schools, BOTH synthetic: 'demo' ("Demo School", built by scripts/
-- seed-school.ts) and 'test-academy' ("Test Academy", founder-created 7/1).
-- Verified: no member of either school carries an organic email — every one is
-- @demo.sketchcast.app, @students.sketchcast.app, or principal.test@… . A real
-- school onboarded later gets its own slug and simply is not in this list; if
-- either school row is gone, the subselect matches nothing and this is a no-op.
update public.profiles p
   set is_demo = true
 where not p.is_demo
   and p.school_id in (select s.id
                         from public.schools s
                        where s.slug in ('demo', 'test-academy'));

-- Rule 2 · @demo.sketchcast.app mailboxes (via auth.users — profiles carries
-- no email). This is the rule that catches the Demo School PARENT
-- (parent@demo.sketchcast.app), whose school_id is NULL by design and who
-- therefore slips through rule 1.
-- SAFE because sketchcast.app is our own domain and only the seeder mints
-- @demo.sketchcast.app accounts (admin API with email_confirm: true); no real
-- mailbox exists on that subdomain, so an organic signup there could never
-- confirm its address. No real user can hold one of these.
update public.profiles p
   set is_demo = true
  from auth.users u
 where u.id = p.id
   and not p.is_demo
   and lower(u.email) like '%@demo.sketchcast.app';

-- Rule 3 · the Test Academy principal, by exact address. Redundant with rule 1
-- today (the profile carries the test-academy school_id) — kept as
-- belt-and-braces so the flag survives a re-run even if that school row is
-- ever deleted. Exact equality on our own domain: no pattern, no collateral.
update public.profiles p
   set is_demo = true
  from auth.users u
 where u.id = p.id
   and not p.is_demo
   and lower(u.email) = 'principal.test@sketchcast.app';

-- Rule 4 · the standalone 2026-06-29 seed students (aisha.khan, ben.carter,
-- chloe.davis, diego.martinez, emma.wilson, farah.ali, george.patel,
-- hana.suzuki, julia.rossi — exactly 9 rows). Three fences, each of which a
-- real student CANNOT cross:
--   · TIME-BOXED: created_at < 2026-07-02. The earliest organic
--     students-domain school-NULL profile in prod is 2026-07-19, a 17-day
--     margin — and because the window is frozen in the past, no FUTURE signup
--     can ever fall into it.
--   · school_id IS NULL: school-rostered students (including Demo School's 25)
--     carry school_id — those are rule 1's. This batch predates tenants (0042).
--   · NO parent_links row: organic school-NULL students are parent-created
--     (src/utils/student.ts) and get a parent_links row — verified for 6 of
--     the 7 post-launch school-NULL student rows in prod; the 7th (student@…,
--     2026-08-10) has no link but sits outside the time fence and is left
--     unflagged on purpose. The seed batch has zero links, zero submissions,
--     zero progress; its only footprint is 13 enrollments into the founder's
--     own test classes ("5A", "Test Class 5A").
-- role = 'student' is a fourth, free fence: all 9 are students.
update public.profiles p
   set is_demo = true
  from auth.users u
 where u.id = p.id
   and not p.is_demo
   and p.role = 'student'
   and p.school_id is null
   and p.created_at < timestamptz '2026-07-02 00:00:00+00'
   and lower(u.email) like '%@students.sketchcast.app'
   and not exists (select 1
                     from public.parent_links pl
                    where pl.child_id = p.id);

-- ── 3. Console filter index ──────────────────────────────────────────────────
-- The Demo tab filters WHERE is_demo; every metric filters WHERE NOT is_demo.
-- A partial index over the true rows serves the tab at O(demo accounts) and
-- costs the organic side nothing.
create index if not exists profiles_is_demo_idx
  on public.profiles (is_demo)
  where is_demo;
