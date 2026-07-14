# School portal + tenant seeder — how it fits together, and the deploy runbook

## What this is

Every school is now a first-class tenant with a public address:

```
school.sketchcast.app/{slug}             → the school's landing / role picker
school.sketchcast.app/{slug}/principal   → role-scoped logins
school.sketchcast.app/{slug}/teacher       (principal | teacher | student | parent)
school.sketchcast.app/{slug}/student
school.sketchcast.app/{slug}/parent
```

One deployment serves every school. The proxy (`src/proxy.ts` → `src/utils/school-routing.ts`)
rewrites `/{slug}/…` on the school host to the internal `/school/{slug}/…` route
group; after sign-in users land on the **existing** dashboards on the same host.
Shared vs isolated:

- **Shared, propagates to all schools automatically:** app code, routing, the
  dashboards, the seeder template.
- **Isolated per school:** all data (`school_id` + RLS — the slug is never
  trusted for data access; `/api/school-portal/verify` bounces wrong-tenant
  logins, and RLS is the real guard regardless).
- **Customizable per school:** `schools.config` (e.g. `{"school_analytics": true}`
  lights the leadership suite for one tenant via `schoolAnalyticsEnabledFor()`),
  `schools.display_name`, `schools.branding`.

**"demo" is the canonical template tenant.** Onboarding a real school is the
same command with a different slug — new `school_id`, zero overlap:

```
ALLOW_SEED=true npx tsx scripts/seed-school.ts --slug sk-taman-maju --name "SK Taman Maju" --clone-from <book-owner-email>
```

## Kill switch

`NEXT_PUBLIC_SCHOOL_HOST` (e.g. `school.sketchcast.app`). Unset ⇒ no host rules,
nothing rewrites, the portal pages stay reachable only by their internal
`/school/{slug}` paths. Same pattern as the console subdomain
(`NEXT_PUBLIC_CONSOLE_HOST`, see docs/CONSOLE.md).

## What the seeder builds (per tenant)

| Piece | Detail |
|---|---|
| School | slug, display_name, `config.school_analytics=true`, status active |
| Principal | `principal@{slug}.sketchcast.app`, school_admin **+ a Grade-5 coordinator grant** |
| Teachers ×5 | `teacher1..5@{slug}.sketchcast.app`, `max_books=20` override (the 0024 trial cap would block the cloned library). **teacher1 also holds a Grade-5 coordinator grant** — her School tab shows the *named* at-risk worklist (admins see the aggregate view) |
| Classes ×5 | realistic names/grades, DB-default join codes |
| Students ×25 | provisioned exactly like `/api/students` (synthetic `@students.sketchcast.app` logins), varied realistic names |
| Parent | `parent@{slug}.sketchcast.app`, verified `parent_links` row to one student |
| Library | **cloned from `--clone-from`'s real ready books**: rows + storage copies (book PDF, covers, video/deck/docx/quiz artifacts, chapter_grounding) so Watch/Deck/Worksheet/Quiz genuinely open. Auto-enqueued index/generation jobs are closed immediately so the worker never re-generates |
| Assignments | `generation_shares` with mixed `due_at` (past-due + upcoming) |
| Progress | all statuses incl. `revised` (revision hotspots) and backdated `updated_at` (trips the 14-day inactivity rule) |
| Submissions | pending / auto / graded — the "To grade" queue is populated; one real PDF file-submission |
| At-risk | students shaped to trip: <50% completion, >14d inactive, never-started, ≥2 overdue, low + declining scores |
| Output | `scripts/out/{slug}-credentials.md` + `.json`, verification report, signed-in cross-tenant isolation check |

Demo-tenant conveniences (deliberate, seeder-only): **one shared documented
password** and `must_reset_password=false` on every account, so a salesperson
can log in live mid-pitch. Normal provisioning keeps the forced reset.

Re-running the seeder = wipe + rebuild to the identical known state. The wipe
touches ONLY: profiles with that `school_id`, students enrolled in that school's
classes (heals orphans), adults whose email ends `@{slug}.sketchcast.app`, and
those users' storage objects. Guards: `ALLOW_SEED=true`, explicit `--slug`,
printed project ref + typed slug confirmation (`--yes` to skip), aborts if 0042
isn't applied.

## Deploy runbook (in order — nothing auto-deploys)

1. **Run migration 0042** — paste `supabase/migrations/0042_school_tenant.sql`
   wholesale into the Supabase SQL editor (prod). Idempotent. Existing schools
   get name-derived slugs backfilled; new school inserts auto-derive a slug.
2. **(One-time, replacing the old demo)** point the old demo school at the
   `demo` slug so the seeder absorbs it:
   `update schools set slug = 'demo' where id = '<old-demo-school-id>';`
   (Find it: `select id, name, slug from schools;`.) Skip for real schools.
3. **Run the seeder** from the repo root (uses `.env.local`'s service key):
   `ALLOW_SEED=true npx tsx scripts/seed-school.ts --slug demo --name "Demo School" --clone-from <book-owner-email>`
   Read the verification report + isolation check at the end; credentials land
   in `scripts/out/demo-credentials.md`.
4. **Domain** — Vercel: add `school.sketchcast.app` to the app project.
   Cloudflare (sketchcast.app zone): `CNAME school → cname.vercel-dns.com`,
   DNS-only (grey cloud), same as the console subdomain.
5. **Env** — set `NEXT_PUBLIC_SCHOOL_HOST=school.sketchcast.app` in Vercel
   (Production). This is the feature's on-switch.
6. **Deploy** the branch (merge to main → Vercel auto-deploy).
7. **Smoke** — `school.sketchcast.app/demo` shows the Demo School landing; all
   four role logins work with the shared password; a teacher from another
   school is bounced with "belongs to a different school"; `/dashboard` on the
   school host serves the normal app after login.

## Ops notes

- **Archive a school:** `update schools set status='archived' where slug='…'` —
  the portal 404s, data untouched.
- **Slug is lowercase `[a-z0-9-]`,** unique, enforced by `schools_slug_chk`; the
  proxy passes non-slug-shaped first segments straight through, and the
  `RESERVED_SEGMENTS` list in `src/utils/school-routing.ts` prevents a slug ever
  shadowing an app route — **add to it if a new top-level route is added**.
- **Worker + cloned content:** cloned books/generations arrive `done` with their
  jobs closed; the Railway worker never touches them. If a demo teacher
  generates something NEW, that runs the real pipeline (real cost) — fine, and
  a re-seed clears it.
- The old `supabase/seed_demo.mjs` (LOCAL Docker stack only) still exists and is
  unrelated — `scripts/seed-school.ts` is the prod-tenant tool.
