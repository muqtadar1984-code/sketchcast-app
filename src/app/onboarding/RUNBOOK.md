# New-joiner profile onboarding — RUNBOOK

**What:** A blocking, one-time step that makes a new user CONFIRM whether they're a
Teacher or Parent and fill a short profile *before* using the app, so nobody runs
as the silent `profiles.role` default (`'teacher'`).

## Pieces

| Piece | File |
|---|---|
| Flag | `src/utils/flags.ts` → `onboardingEnabled()` (`FEATURE_ONBOARDING=true`) |
| Migration | `supabase/migrations/0038_onboarding_profile.sql` — adds `profiles.onboarded_at`, `profiles.profile jsonb`, backfills existing users |
| Pure logic | `src/utils/onboarding.ts` — `seedRole`, `missingRequired`, `homeForRole`, option lists |
| Gate | `src/app/dashboard/layout.tsx` — redirects an un-onboarded adult to `/onboarding` |
| Page | `src/app/onboarding/page.tsx` (server) + `onboarding-form.tsx` (client) |
| Write | `src/app/api/onboarding/route.ts` (service role; re-validates `missingRequired`) |
| Tests | `src/utils/__tests__/onboarding.test.ts` |

## The gate (who is / isn't forced through)

`onboardingEnabled() && profile && profile.onboarded_at == null && profile.role !== "student"`

- **Forced:** adult self-signups (teacher/parent) that never onboarded → the target case.
- **Exempt — students:** they have their own `must_reset_password` first-run flow and no
  student option in the form; forcing them would trap them.
- **Exempt — provisioned adults:** invited teacher/coordinator/admin (`invite/[token]/accept`),
  school admins (`api/school-finish`), and provisioned students (`api/students`) all stamp
  `onboarded_at` at creation, so they never reach the gate. Their identity is already known.

`profile == null` (0038 not applied yet, or row missing) falls through untouched — the gate
degrades to a no-op, so shipping the code before running the migration is safe.

## The client/server contract

`missingRequired(role, fullName, profile)` is the SINGLE source of truth. The client uses it to
gate "Continue"; `/api/onboarding` re-runs it to reject a bypass. Keep them calling the same
function so they can never disagree. Required fields:

- **Teacher:** full name + affiliation (+ school_name iff affiliation = school) + ≥1 grade + ≥1 subject.
- **Parent:** full name + children_count ≥ 1 + ≥1 child grade level.

## To enable

1. Run migration `0038_onboarding_profile.sql` (additive + idempotent; the 5-minute backfill
   guard makes a re-run safe and won't sweep in a brand-new signup).
2. Set `FEATURE_ONBOARDING=true` in Vercel (server-only flag — no `NEXT_PUBLIC_` needed; the
   gate is server-side).
3. Verify: a fresh email signup lands on `/onboarding`, can't Continue until the required
   fields are filled, and after submit lands on `/dashboard` (teacher) or `/dashboard/children`
   (parent) and never sees the gate again.

## To disable / roll back

Set `FEATURE_ONBOARDING=false` (or unset). The gate and `/onboarding` become no-ops; the
`onboarded_at`/`profile` columns are harmless if left in place.
