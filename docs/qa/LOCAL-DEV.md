# Local isolated platform — bring-up & QA

A fully offline copy of the portal (Next.js + **local** Supabase: Postgres + Auth + Storage +
Studio) so you can test **before** anything ships to prod. Nothing here touches production —
the seed hard-refuses any non-local database URL.

This enforces the release rule: **test on local, confirm green, THEN ship to prod.**

## One-time prerequisites (you install these — I can't)

1. **Docker Desktop** — https://www.docker.com/products/docker-desktop/ . Install, launch it,
   and make sure it's **running** (whale icon in the tray). This is the hard requirement; the
   local Supabase stack runs as Docker containers.
2. The **Supabase CLI** is already a devDependency (`npx supabase …` works). Nothing to do.

Verify Docker is up: `docker info` should print server details (not an error).

## Bring it up (≈2–3 min the first time — it pulls container images)

```bash
# from sketchcast-app/
npx supabase start          # or: npm run db:start
```

`supabase start` boots the stack, **applies every migration** in `supabase/migrations/`
(0001→0038, incl. the storage buckets), and prints your local URLs + keys:

- API:    http://127.0.0.1:54321
- Studio: http://127.0.0.1:54323   ← visual DB browser
- Inbucket (local email): http://127.0.0.1:54324   ← password-reset / magic-link emails land here

**Confirm the keys** match `.env.development.local`:

```bash
npx supabase status -o env   # copy API_URL / ANON_KEY / SERVICE_ROLE_KEY if they differ
```

If they differ from the values already in `.env.development.local`, paste the printed
`ANON_KEY` → `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SERVICE_ROLE_KEY` → `SUPABASE_SERVICE_ROLE_KEY`.

## Seed the demo world

```bash
node supabase/seed_demo.mjs   # or: npm run db:seed
```

Creates a self-contained demo: **Demo Primary School**, a principal, 2 teachers, 1 parent,
2 students, a class (5A), a ready book with grounding, and one shared "done" lesson with
per-student progress. Idempotent — safe to re-run.

**Log in** at http://localhost:3000 — password for **all** demo accounts: `sketchcast`
- `demo.principal@sketchcast.app` · `demo.teacher1@sketchcast.app` · `demo.parent1@sketchcast.app`
- students sign in with the bare ID `demo.s1` / `demo.s2`

## Run the app against local

```bash
npm run dev      # http://localhost:3000
```

Next.js loads `.env.development.local` **ahead of** `.env.local`, so `npm run dev` talks to
**local** Supabase while your prod `.env.local` stays intact for diagnostics.

## Point the QA agent at local

Invoke the **qa-frontend** agent with TARGET `local` (see `.claude/agents/qa-frontend.md`).
It runs `preview_start({name:"web"})` and executes `docs/qa/QA-PLAN.md`. For authenticated
scenarios it mints password-free sessions the same way as prod — via the **local** service
role → `/auth/confirm`.

## Handy commands

| Command | What |
|---|---|
| `npm run db:bootstrap` | `supabase start` + seed in one go |
| `npm run db:reset` | wipe + re-apply all migrations (then re-seed) — the "fresh slate" |
| `npm run db:status` | URLs + keys |
| `npm run db:stop` | stop the containers (data persists) |

## What works locally vs. what needs more

- ✅ **Everything front-end + data**: auth, onboarding gate, role nav, guards/RLS, parent &
  student views, the Assistant *panel* + grounded answers (uses your Anthropic key from
  `.env.local` for LLM only — no prod data touched).
- ⚠️ **Lesson generation** and **real video/deck playback** need the **Python worker + mathsvc**
  running against this local DB (edge-tts, ffmpeg, models). The seed inserts a lesson *row* so
  the UI shows it, but Watch/Deck won't play until the worker is wired locally. That's a
  separate follow-on if you want to test the generation pipeline offline.
- Billing stays **off** locally (don't set `BILLING_ENABLED`).

## Testing the onboarding gate locally

All seeded accounts are onboarded. To exercise the blocking gate, null one adult's flag then
load `/dashboard` (it redirects to `/onboarding`):

```sql
-- in Studio SQL editor, or psql against 127.0.0.1:54322
update profiles set onboarded_at = null
 where id = (select id from auth.users where email = 'demo.teacher2@sketchcast.app');
```
