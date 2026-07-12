# SketchCast AI — Technical Document

_Last updated: 12 July 2026. The single, current source of truth for the SketchCast platform — architecture, data model, the generation pipeline, every feature area, config/flags/secrets, security, and operations. Generated from the live codebase._

> Supersedes the earlier `sketchcast/TECHNICAL_DOCUMENT.md` stub in the worker repo.

## Contents

1. [Overview & architecture](#1-overview-architecture)
2. [Data model & migrations](#2-data-model-amp-migrations)
3. [Generation pipeline (the worker)](#3-generation-pipeline-the-worker)
4. [Auth, roles & onboarding](#4-auth-roles-onboarding)
5. [Library & authoring](#5-library-authoring)
6. [Classes, students, assignments & analytics](#6-classes-students-assignments-analytics)
7. [Parent portal](#7-parent-portal)
8. [AI features (Assistant, Tutor, TAL board, ERE)](#8-ai-features-assistant-tutor-tal-board-ere)
9. [Billing & pricing](#9-billing-pricing)
10. [Support agent, issues & autofix](#10-support-agent-issues-autofix)
11. [Platform console (admin)](#11-platform-console-admin)
12. [Config, security, QA & operations](#12-config-security-qa-operations)

---
## 1. Overview & architecture

### 1.1 What SketchCast is

SketchCast turns a **textbook chapter (PDF)** into a complete set of teaching materials, then lets teachers/parents **assign** that content and **track** learner progress. From one uploaded chapter a user can generate:

- a **narrated lesson video** — a deterministic, on-device "object animation" render (title writes on, dividers grow, bullets and diagrams draw in) with free text‑to‑speech voiceover;
- an **editable slide deck** (`.pptx`) with the spoken narration in the speaker notes;
- teacher **documents** (`.docx`): lesson plan, class activities, worksheet, exam/test paper, case study;
- **interactive, auto‑graded quizzes** (a `questions.json` drives an in‑app quiz player), with a file‑upload path for subjective answers.

On top of the generated content sits an optional **book‑grounded AI study assistant** — a fast, voice‑capable chat tutor that answers only from the student's assigned book/chapter (hints and method, not graded answers). The audience is **schools, teachers, parents, and their students**; students never self‑sign‑up (their accounts are provisioned by an adult).

The product ships as a public **freemium beta**: the free tier deliberately uses zero‑cost generation (free Edge‑TTS, no AI images, deterministic native video), with paid upsells (AI images, premium ElevenLabs voices, richer video) gated behind billing and feature flags.

### 1.2 Operating entity

The service is operated by **Aethel Twin Sdn. Bhd.** (Company No. 202601012908 / 1675006-X), a company incorporated in Malaysia, registered at *D‑1‑1, Bangi Gateway Shopping Complex, Persiaran Pekeliling, Seksyen 15, 43650 Bandar Baru Bangi, Selangor, Malaysia*. Aethel Twin is the data controller for general account data and acts as a **processor** for data inside a school's workspace (the school is the controller). Privacy contact: `privacy@sketchcast.app` / `hello@sketchcast.app`. See `sketchcast-landing/privacy.html` §1 and `sketchcast-landing/terms.html` (both last updated 12 July 2026) for the canonical legal statements, sub‑processor list, and jurisdiction coverage (India DPDP, GDPR/UK GDPR, COPPA/FERPA, CCPA/CPRA, Malaysia PDPA).

### 1.3 Repositories & hosting

Four repositories make up the system (all under the `muqtadar1984-code` GitHub org). Each auto‑deploys from its production branch:

| Repo (local dir) | GitHub | Contents | Host | Prod branch |
|---|---|---|---|---|
| `sketchcast-app` | `sketchcast-app` | Next.js web app (App Router) + Supabase migrations (`supabase/migrations/`); real‑time AI Assistant route (`src/app/api/assistant/`); vendored ERE engine (`src/ere/`) | **Vercel** → `app.sketchcast.app` | `main` |
| `sketchcast` | `sketchcast-ai` | Python generation worker (agents 1–8 + `docgen`), the constrained SymPy `mathsvc/`, legacy Streamlit monolith | **Railway** (worker split + a 2nd math service) | `master` |
| `sketchcast-landing` | `sketchcast-landing` | Static marketing site + `/pricing`, `privacy.html`, `terms.html` | **Cloudflare** → `sketchcast.app` | `main` |
| `sketchcast-ere` | `sketchcast-ere` | `@sketchcast/ere` — the TAL teaching‑action engine + pure SVG renderer (vendored into the app; also targets a standalone board SPA) | GitHub source of truth; **vendored** into the app build | `master` |

Notes:

- **Domain & DNS**: `sketchcast.app` is registered at Cloudflare (free DNS/SSL/CDN; the `.app` TLD forces HTTPS).
- **Supabase** (Postgres + Auth + Storage) is the single source of truth shared by the app and the worker.
- **Deploy discipline**: Supabase migrations are applied **manually** in the SQL editor and **must precede** the matching app deploy. The app build gates on TypeScript. The ERE engine uses NodeNext ESM in its own repo but the vendored app copy must use extensionless imports (a known `next build` trap — see the ERE board notes).

### 1.4 Live domains

| Domain | Serves | Host |
|---|---|---|
| `app.sketchcast.app` | The Next.js web app (auth, dashboards, upload, assign, results, AI Assistant) | Vercel |
| `sketchcast.app` | Public marketing/landing + pricing + legal (privacy/terms) | Cloudflare (static) |
| `board.sketchcast.app` | Standalone ERE whiteboard board SPA (Phase‑2 of the TAL engine) | Cloudflare Workers |

> **Current status of `board.sketchcast.app`**: the standalone board app is **preserved but paused**. The TAL whiteboard ("Ask Coach" board, flag `FEATURE_AI_TUTOR_TAL`) was superseded on 2026‑07‑11 by the book‑first **AI Assistant** (`FEATURE_AI_ASSISTANT`), which is the live study‑tutor surface today. The board code and its `sketchcast-board` SPA build are retained behind flags (preserved on branch/tag `preserve/tal-board-phase1-2`) for later revival; the domain is provisioned for it.

### 1.5 High‑level request / data flow

Three independently deployed runtimes (web app, worker, and the static/board Cloudflare surfaces) all coordinate through **one Supabase project**. The client never writes to the job queue or talks to the worker directly — it inserts `books`/`generations` rows and **DB triggers** enqueue worker jobs, keeping the queue authoritative and RLS‑safe.

```
   sketchcast.app                          board.sketchcast.app
   (Cloudflare static:                     (Cloudflare Workers:
    marketing, /pricing,                     standalone ERE board SPA —
    privacy, terms)                          preserved/paused behind flags)

   Teacher ┐
   Parent  ┤        app.sketchcast.app
   Student ┼──────▶ Next.js web app  (Vercel · branch main)
   Admin   ┘         · auth, dashboards, upload, assign
                     · serve results via signed Storage URLs
                     · real-time AI Assistant  ──▶ Anthropic Claude
                                               ──▶ SymPy math service (Railway)
                                               ──▶ TTS (browser / ElevenLabs)
                          │  reads/writes (RLS) + service-role ops
                          ▼
                  ┌────────────────────────────┐
                  │  Supabase                  │  Postgres + Auth + Storage
                  │  · tables + RLS            │  · job queue (DB triggers)
                  │  · storage buckets         │
                  └────────────────────────────┘
                          ▲  polls job queue, uploads artifacts (service role)
                          │
                  ┌────────────────────────────┐
                  │  Worker (Python)           │  Railway · repo sketchcast-ai · branch master
                  │  · agents 1–8 pipeline     │──▶ Anthropic Claude (analysis, scripts, docs)
                  │  · docgen (.docx/.pptx)    │──▶ Edge-TTS / ElevenLabs (narration audio)
                  │  · native video renderer   │
                  └────────────────────────────┘
```

**End‑to‑end flow**

1. A teacher/parent uploads a chapter PDF → the web app inserts a `books` row.
2. A DB trigger enqueues an `index_book` job → the worker (`worker/process.py`) extracts the chapter list (and a book‑health score) and writes it back onto the book.
3. The user clicks **Generate** for a chapter/kind → the app inserts a `generations` row.
4. A DB trigger enqueues a job → the worker runs the pipeline (ingest → analyze → script → slides → native video / docgen) → uploads artifacts (deck, video, `.docx`, `questions.json`) to Storage and marks the job done.
5. The app serves results via **signed Storage URLs**; teachers/parents assign chapters to classes; students consume them; progress and submissions flow back into Supabase for the analytics dashboards.

**Two distinct AI paths.** Batch content generation runs **asynchronously in the Python worker** (Claude for analysis/scripts/documents; Edge‑TTS/ElevenLabs for narration). The **AI Assistant** runs **synchronously inside the Next.js app** (`/api/assistant`, streaming SSE) calling Anthropic Claude directly, grounded on the student's assigned book, with an optional constrained SymPy `mathsvc` (a second Railway service) for verified calculations. This split is why the app carries its own `ANTHROPIC_API_KEY` in addition to the worker's model credentials.

---

## 2. Data model & migrations

The app's persistence layer is a single **Supabase Postgres** database, versioned as a linear stack of 39 hand-authored SQL files in `sketchcast-app/supabase/migrations/` (`0001_init.sql` … `0039_autofix.sql`). There is no ORM and no migration runner — each file is idempotent (`create … if not exists`, `add column if not exists`, function `create or replace`) and applied by hand in the Supabase SQL editor, usually "as one execution". The header comment of every file is the authoritative design note for that change.

Two principals touch the DB:

- **`authenticated`** — the browser (Supabase JS with the user's JWT). Every table has **RLS enabled**, so this principal sees only what policy allows.
- **`service_role`** — the Next.js server routes and the Python worker (`sketchcast`). It **bypasses RLS entirely** and does all privileged writes (job processing, billing webhooks, invite accept, role/scope grants, tutor grounding). A large share of the schema (grounding, caches, audit logs, billing internals) is **service-role only**: RLS is on with *no* policies, plus a belt-and-suspenders `revoke all … from anon, authenticated`.

A critical, repeated invariant: **BEFORE triggers fire regardless of RLS**, so the DB-level caps and sanity checks (`0011`/`0016`/`0018`) hold even against a service-role insert or a hand-crafted API call — they are the real enforcement, not the UI.

### Enums

Defined in `0001_init.sql` unless noted. Most *status/category* fields elsewhere are `text` + a `check` constraint rather than enums (deliberate — no `ALTER TYPE` needed to add a value).

| Enum | Values | Added by |
|---|---|---|
| `user_role` | `school_admin`, `teacher`, `student`, `coordinator`, `parent` | 0001; `coordinator` in `0009`; `parent` in `0017` |
| `book_kind` | `textbook`, `material` | 0001 |
| `generation_kind` | `presentation`, `lesson_plan`, `worksheet`, `exam_paper`, `case_study`, `activity` | 0001 |
| `job_status` | `queued`, `processing`, `done`, `error` | 0001 |
| `artifact_kind` | `deck_pptx`, `video_mp4`, `slide_png`, `pdf`, `docx`, `other`, `questions_json` | 0001; `questions_json` in `0007` |
| `progress_status` | `assigned`, `in_progress`, `completed`, `revised` | 0006 |

> **Operational gotcha:** `alter type … add value` cannot be used in the same transaction as anything that references the new value. `0009` (coordinator) and `0017` (parent) both carry loud "RUN THIS LINE BY ITSELF FIRST" warnings; `0017` is a one-line migration for exactly this reason.

### Core tables

**Identity & org (`0001`, `0005`)**
- **`schools`** — first-class but *optional*; independent teachers/parents run with `school_id = NULL`. Just `id, name`.
- **`profiles`** — one row per `auth.users` id, auto-created by the `handle_new_user()` trigger on signup. Carries `role` (default `teacher`), `full_name`, `school_id`. Later migrations bolt on: `username`/`parent_email`/`must_reset_password` (`0005` invited-student identity), `beta_tester`/`signup_notified_at` (`0011`/`0012`), `suspended_at` (`0015`), cap overrides `max_books`/`max_chapters`/`max_students`/`max_children` (`0016`/`0018`), and `onboarded_at`/`profile jsonb` (`0038`).
- **`classes`** — teacher-owned; `grade`, `teacher_id`, `school_id`, a unique `join_code`.
- **`enrollments`** — `(class_id, student_id)` unique; the student↔class join.

**Content pipeline (`0001`–`0004`, `0021`)**
- **`books`** — the *shared library*. `owner_id` writes; anyone in the same `school_id` reads. Worker-populated fields: `chapters jsonb` (`[{num,title}]`), `pages`, `grade`, `subject`, `cover_path`, `health jsonb` (Book Health Score, `0021`). `removed_at`/`removed_by` are takedown markers (`0015`).
- **`generations`** — teacher-*owned* output (one row per requested artifact set), keyed to a `book_id` + `chapter_ref`, with `kind`, `params jsonb`, `status`. Also `removed_at`/`removed_by`.
- **`artifacts`** — files produced for a generation (`kind`, `storage_path` in the `artifacts` bucket).
- **`jobs`** — the worker's queue. `type` is free `text` (`'index_book'`, each `generation_kind`, `'support_diagnose'`, …), `status`, `progress`, `error`. `book_id` set for index jobs, `generation_id` for content jobs, `issue_id` for support-agent jobs (`0020`), `usage jsonb` for per-job Claude cost (`0013`). Rows are created by DB triggers (`create_job_for_generation`, `create_index_job_for_book`) — **the client never inserts jobs** (the `jobs_insert` policy was dropped in `0011` to close a cost side-door).
- **`generation_shares`** — how a teacher assigns content. Originally class-only; `0018` added a nullable `student_id` for direct-to-child shares and a `num_nonnulls(class_id, student_id) = 1` constraint. **`branding`** (`0001`/`0004`) holds a teacher's `.docx`/`.pptx` template paths.

**Student work (`0006`, `0007`)**
- **`student_progress`** — one row per `(generation, student)`; lifecycle `status` (`progress_status`), `progress_pct`, timestamps, `revision_count`.
- **`submissions`** — a student's worksheet/exam answer: `mode` (`file`|`interactive`), `answers jsonb`, `file_path` (submissions bucket), `auto_score`/`teacher_score`/`grade_status`, `feedback`, `graded_by`.

**Leadership & governance (`0009`, `0010`, `0019`)**
- **`coordinator_scope`** — maps a `coordinator_id` → `(grade, subject?)` slice; *this membership IS the permission* (never the enum literal alone).
- **`analytics_access_log`** — DPDP audit trail of leadership viewing minors' data.
- **`invites`** / **`invite_children`** — email-based role grants (`school_admin`/`teacher`/`parent` only — never `student`); accept runs server-side. `invite_children` maps a parent invite to its child rows.

**Parent portal (`0018`)**
- **`parent_links`** — `(parent_id, child_id)`, `source` (`school`|`self`), `verified_at`. Parenthood is a **grant**: written *only* by the service role — no client insert/update/delete policy exists, so a parent can never self-grant access to a minor. A `parent_link_sanity` trigger enforces child = student / parent ≠ student.

**Platform console (`0014`, `0020`, `0039`)**
- **`platform_admins`** — SketchCast staff *membership* (not a `user_role`). `is_platform_admin()` gates `/console`. Soft-revoke via `revoked_at`.
- **`platform_audit_log`** — immutable ops trail (`action`, `target_kind`/`target_id`, `detail`); service-role writes only.
- **`platform_issues`** — the tech-issue tracker *and* the support-agent's unit of work. `category`/`severity`/`status` are `check`-constrained text. `0020` added `book_id`/`generation_id`/`job_id`, `trigger_source`, `diagnosis jsonb` (user-safe only), `agent_action`, and content-quality categories (`wrong_chapter`, `poor_quality`, …).
- **`autofix_runs`** (`0039`) — one row per "Attempt auto-fix" the automated bug-fix pipeline fires on an issue: `run_key` (unique correlation id for the GitHub Action), `branch`/`pr_number`/`pr_url`, `status` (`dispatched`→`merged`/`rejected`/`error`), `ci_passed`, `sensitive`, `decided_at` (set once → the signed Approve/Reject link is single-use). Service-role only; flag `FEATURE_AUTOFIX` **OFF** by default.

**Billing (`0022`, `0023`)** — Stripe IDs/status only; **no card data ever lands in the DB**.
- **`billing_customers`**, **`subscriptions`**, **`payments`** — provider mirrors. `0023` added a `provider` discriminator (`stripe`|`lemonsqueezy`), LS id columns, nullable `user_id` + `email`/`claim_email` for logged-out Merchant-of-Record checkout ("parked, unclaimed" rows), and widened currency to `myr`/`usd`.
- **`entitlements`** — **the single provider-agnostic source of truth for paid access**, keyed `(user_id, plan_key)`; the whole app gates on this table, never on the raw subscription. `active`, `status`, `current_period_end`.
- **`webhook_events`** — idempotency ledger (Stripe event id PK). Stripe (schools/MYR) is live; Lemon Squeezy (parents/teachers/USD) ships behind `BILLING_ENABLED` + LS keys.

**AI Tutor / ERE board (`0025`–`0033`)** — all real-time app routes, mostly service-role only.
- **`chapter_grounding`** — `(book_id, chapter_num)` PK; the tutor's *source of truth*: Agent-2 `concepts jsonb`, Agent-3 `script_text`, and cached scanned-book `source_text` (`0036`). Written by the worker at index/generation time.
- **`tutor_qa`** — shared fuzzy-matched answer cache (pg_trgm on `question_norm`); `tutor_qa_match()`/`tutor_qa_bump()` RPCs; `is_verified` gates silent reuse.
- **`tutor_messages`** — chat transcript; student RW own, teacher read for owned generations.
- **`mastery_events`** (`0026`) — append-only mastery signals (`engaged`/`correct`/`incorrect`, `source` `tutor`/`quiz`); summarised by `tutor_mastery_summary()`.
- **`tts_usage`** (`0027`) / **`tutor_sketch_usage`** (`0028`) — atomic monthly spend caps (`tutor_tts_reserve`/`tutor_sketch_reserve` only commit if under cap). **`tutor_sketch`** — render-queue + cross-student clip cache keyed on `spec_hash`.
- **`tutor_board`** (`0029`) — one persistent ERE scene graph per `(student, generation)`: `scene_graph jsonb`, `board_hash`, `turn`, `event_seq`. **`tutor_board_event`** — append-only mutation log. **`tutor_tal_cache`** — dedupes a turn `(book, chapter, question_norm, board_hash, ref_hash)`; `0033` added `ref_hash` so "explain what I circled" pointed at different objects doesn't collide.
- Private buckets `tutor-voice`/`tutor-sketch` back these (see below).

> **Board-reset gotcha:** the scene graph *bakes object geometry at place time*, so a KO/prompt upgrade needs a board wipe. `0030` and `0032` are pure data migrations that `truncate` the event log + TAL cache and blank every board to `turn 0`; boards are ephemeral teaching surfaces, so this is non-destructive.

**AI Teaching Assistant (`0034`)** — **`assistant_sessions`** + **`assistant_messages`** (the current chat-tutor path that supersedes "Ask Coach"): per-turn `source_book_id`/`source_chapter`/`source_label` grounding tags, `provider`, `latency`/`tokens jsonb`. ~30-day retention enforced on session open. Student-read RLS; service-role writes.

**Onboarding & analytics (`0037`, `0038`)** — **`user_tour_progress`** (per-user versioned coach-mark seen-state) + **`tour_events`** (Postgres-as-analytics sink, service-role write via `/api/tour/event`). `0038` added the blocking new-joiner profile gate (`profiles.onboarded_at`/`profile`).

**Beta/feedback (`0011`)** — **`artifact_views`** (drives the "seen everything → give feedback" prompt) and **`beta_feedback`** (one submission per teacher, DB-enforced unique).

### Storage buckets

All private; clients get short-lived signed URLs minted server-side after an access check.

| Bucket | Limit | Access model | Migration |
|---|---|---|---|
| `uploads` | 200 MB | folder-per-uid (`(storage.foldername(name))[1] = auth.uid()`) | 0001 |
| `artifacts` | 200 MB | folder-per-uid | 0001 |
| `submissions` | 50 MB | folder-per-uid | 0006 |
| `tutor-voice` | — | **no policies** → service-role only | 0027 |
| `tutor-sketch` | — | **no policies** → service-role only | 0028 |

### RLS model & roles

Roles resolve to five `user_role` values plus two membership-based grants:

- **teacher** — owns books (shared to their school), generations, classes. Adults implicitly teach (ownership-based authoring).
- **student** — reads content shared to them (via enrollment or direct share; `shared_to_me()`), RW their own progress/submissions/tutor rows.
- **parent** — reads exactly their linked children's rows (`is_parent_of()`); since `0035` a full author for their own children (the old `exam_paper`-only trigger was dropped).
- **school_admin** (Principal) — read-only across their whole school.
- **coordinator** — read-only over a grade/subject *slice*, purely by `coordinator_scope` membership (`coordinates_class/student/generation/profile`).
- **platform admin** — SketchCast staff, via the `platform_admins` table + `is_platform_admin()`, orthogonal to school identity.

Three structural techniques run through the policies:

1. **SECURITY DEFINER helpers to prevent policy recursion.** Cross-table checks are wrapped in `security definer` functions (`current_school_id`, `current_role_val`, `shared_to_me`, `owns_class`, `enrolled_in_class`, `teaches_student`, `coordinates_*`, `is_parent_of`, `can_use_book`, `effective_cap`, `current_user_suspended`, …). `0008` exists specifically because the original `0001` classes↔enrollments↔profiles policies referenced each other and Postgres raised *"infinite recursion detected in policy"* — the fix re-expressed each cross-table check as a definer helper.
2. **Column-level GRANT lockdown (`0010`).** RLS can't restrict *columns*, so `revoke update on profiles from authenticated` + `grant update (full_name, username, parent_email, must_reset_password)` means `role`, `school_id`, the cap columns, and `suspended_at` are **not client-writable** — only the service role (invite accept, `/api/coordinators`, console) can set them. This closes a self-escalation hole where any teacher could `update` their own row to `school_admin`.
3. **RESTRICTIVE policies for suspension & takedown (`0015`).** `*_not_suspended` restrictive policies `AND` with every permissive policy across the hot tables, killing data access immediately even on a still-valid access token. `books`/`generations` `removed_at` markers hide *and freeze* taken-down rows (no update/delete → the owner can't clear the marker). `artifacts`/`jobs` inherit invisibility through `0001`'s RLS-filtered subquery policies.

Caps are the fourth pillar: `effective_cap(uid, which)` centralises limits, and `0024` set the current **launch trial default of 1 book / everything else unlimited for everyone** (superseding the old beta 1/1/2), overridable per-user from the console.

### Migration index (grouped by feature)

| Range | Feature | Notes |
|---|---|---|
| `0001` | Foundational schema + RLS | tables, enums, triggers, buckets, `handle_new_user` |
| `0002`–`0004` | Book indexing, grade/subject grouping, branding + covers | |
| `0005`, `0008` | Student identity; **RLS recursion fix** | definer helpers |
| `0006`, `0007` | Progress, submissions, `questions_json` quiz artifact | |
| `0009` | School analytics (coordinator role + leadership reads) | gated `FEATURE_SCHOOL_ANALYTICS` (OFF); `alter type` run-alone |
| `0010` | Invites + **column lockdown** | closes self-escalation |
| `0011`, `0012`, `0016`, `0024` | Caps engine | `0011` beta caps (triggers), `0016` per-user overrides via `effective_cap`, `0024` launch trial default (1 book) |
| `0013` | Per-job Claude usage/cost | |
| `0014`, `0015` | Platform console + suspend/takedown | membership table + audit log |
| `0017`–`0019`, `0035` | Parent portal | `0017` enum (run-alone), `0018` links+guards, `0019` invites, `0035` full-author |
| `0020` | Support agent | issue refs + diagnosis + cross-tenant `book_id` RLS fix |
| `0021` | Book Health Score | |
| `0022`, `0023` | Billing | Stripe (`0022`, live) + Lemon Squeezy/MoR (`0023`); `entitlements` is the gate |
| `0025`–`0033`, `0036` | AI Tutor / ERE board | grounding, QA cache, mastery, voice/sketch caps, persistent board, board resets, OCR cache |
| `0034` | AI Teaching Assistant | sessions/messages; flag OFF pending enablement |
| `0037` | Onboarding tour | flag `NEXT_PUBLIC_FEATURE_TOUR` set true in prod |
| `0038` | **Onboarding profile** gate | `FEATURE_ONBOARDING` **ON** in prod (verified 2026-07-12) |
| `0039` | **Autofix** run ledger | `FEATURE_AUTOFIX` OFF by default |

Feature flags live in `sketchcast-app/src/utils/flags.ts` (server checks authoritative; default OFF, enabled only when the env var equals exactly `"true"`). Their consistent doctrine is *"the migration can be applied inertly; the flag lights the surface"* — with DB triggers/RLS enforcing safety regardless of the flag.

**Files:** all migrations under `C:/Users/Arieb/OneDrive/Desktop/Arieb folder/Edtech/sketchcast-app/supabase/migrations/` (`0001_init.sql` … `0039_autofix.sql`); flags at `C:/Users/Arieb/OneDrive/Desktop/Arieb folder/Edtech/sketchcast-app/src/utils/flags.ts`.

---

## 3. Generation pipeline (the worker)

The worker is the Python service in the `sketchcast` repo (Railway, prod branch `master`, GitHub repo `sketchcast-ai`). It is a single long-running poller that turns a queued row in the `jobs` table into finished artifacts in Supabase storage. Everything expensive — PDF parsing, Claude analysis, narration TTS, video rendering, book indexing — happens here, never in the Next.js app. The app only enqueues jobs and reads the artifacts the worker produces.

Entry point: `worker/run.py` (`python -m worker.run` to poll forever, `--once` to drain a single unit and exit — used in tests). The two other core modules are `worker/process.py` (the actual generation/indexing logic) and `worker/client.py` (a service-role Supabase client plus every DB/storage helper).

### 3.1 The polling worker (`worker/run.py`)

`main()` opens a service-role Supabase client (`db.admin()`), runs a **startup key check** (counts `jobs` with an exact count — a privileged key sees all rows, a mis-configured anon/publishable key sees 0 and logs `KEY CHECK FAILED`), then loops `run_once(sb)` every `WORKER_POLL_SECONDS` (env, default 5).

`run_once` claims work in a deliberate priority order so small, human-in-the-loop tasks never sit behind a multi-minute lesson render:

1. **AI-Tutor sketches** first (`db.claim_next_sketch`) — a student is waiting live; they are monthly-capped so they can't starve the queue. Handled by `worker/tutor_sketch.render_sketch`, which marks its own done/error.
2. **Support diagnoses** next (`db.claim_next_job(sb, job_type="support_diagnose")`) — a reporter is watching an issue status. Runs `support_agent.agent.run_support_job`.
3. **Any other queued job** (`db.claim_next_job(sb)`). Dispatch is by `job["type"]`: `index_book` → `index_book()`; anything else → `process_generation()` (the generation path).

Failure handling in `run_once` is defensive:
- Any exception logs the traceback and calls `db.finish_job(..., error=...)`, which flips both the job and its mirrored `generations` row to `error` (a support job's `generation_id` is the *reported* row, so it is deliberately **not** mirrored to error on an agent crash).
- An `index_book` failure also calls `db.set_book_chapters(book_id, [], "error")` so the dashboard's "Finding chapters…" spinner stops.
- A failed **generation** auto-triggers the support agent (`_auto_file_support_issue`), gated by `SUPPORT_AGENT_ENABLED`: it inserts a `platform_issues` row (category `generation_failed`, `trigger_source="auto"`) and queues a `support_diagnose` job — but never for a support job itself (no recursion) and never twice while an issue is still open for that generation.

### 3.2 Job claiming & the DB/storage client (`worker/client.py`)

`admin()` builds the Supabase client with the **service_role key** (bypasses RLS — server-side only) and generous `ClientOptions` timeouts (`postgrest_client_timeout=60`, `storage_client_timeout=600`) because a real textbook PDF download or rendered-video upload over Railway↔Supabase easily exceeds storage3's stock 20 s.

`claim_next_job` does an optimistic claim: select the oldest `status="queued"` row, then `update(status="processing")` **guarded by `.eq("status","queued")`** so a second worker that raced loses (empty `upd.data` → returns None). The same pattern claims sketches.

Key tables/columns the worker touches: `jobs` (`status`, `progress`, `error`, `usage`, `type`, `generation_id`, `book_id`), `generations` (`status`, `title`, `params`, `kind`, `chapter_ref`, `owner_id`, `book_id`, `removed_at`), `books` (`chapters`, `status`, `grade`, `subject`, `title`, `author`, `cover_path`, `health`, `removed_at`), `artifacts` (`generation_id`, `kind`, `storage_path`), plus `chapter_grounding`, `tutor_qa`, `tutor_sketch`, `platform_issues`. Storage buckets: **`uploads`** (source PDFs), **`artifacts`** (`{owner_id}/{generation_id}/…` decks/videos/docs + `{owner}/covers/…`), **`tutor-sketch`**.

Two economics helpers worth noting: `set_job_usage` persists per-job Claude token/cost totals into `jobs.usage`, **merging additively** (a support run reuses its job id for an inline re-index, so the write must not clobber the earlier spend); `merge_generation_params` records the voice that actually rendered (`params.tts_voice_used`, `tts_voice_downgraded`). Both are best-effort — a deployment whose migration hasn't added the column must not fail the job.

### 3.3 Indexing a book (`index_book` in `process.py`)

Runs once per uploaded PDF so the dashboard can offer a lesson per chapter. It downloads the PDF from `uploads`, runs Agent 1 (`agent1_ingestion.extractor.extract_pdf` + `structurer.structure_book`, **image extraction skipped** — only chapter numbers/titles are needed, which keeps indexing fast), then:

- **Chapter audit** (`agent1_ingestion.chapter_check.audit_chapter_list`) — Claude reads each chapter's opening text, fixes garbled titles, and when at least half the entries look wrong it **escalates to the vision reader** (`vision_chapters.detect_chapters_vision`) and keeps whichever list has fewer mismatches. Best-effort — any failure keeps the heuristic result.
- **Book Health Score** (`agent1_ingestion.book_health.compute_book_health`) → `books.health` (see 3.7).
- **Cover thumbnail** — page 0 rendered via PyMuPDF (`fitz`) to `{owner}/covers/{book_id}.png` in `artifacts`.
- **Metadata detection** — one Claude call turns the (often filename-derived) title + chapter list into `grade`, `subject`, a cleaned book title, and author/publisher. The title is only replaced when the stored one `_looks_like_filename` (junk like `pdfcoffee.com_cambridge-maths-5-...-pdf-free`; there is a regex fallback `_clean_title_fallback`), and author is only filled when currently empty — a teacher-typed title is never clobbered.

Finally it persists `chapters` as `[{num, title, start_page, end_page}]` and sets `books.status="ready"`. **Storing page boundaries is load-bearing**: every later generation reuses this exact split (`known_chapters`) instead of re-detecting, which matters most for scanned books where detection is a vision pass.

### 3.4 Generating content (`process_generation` in `process.py`)

Dispatched on `generations.kind` (default `presentation`). Common front half for **every** kind:

1. `set_generation_status("processing")`; load the generation + book; **abort if `removed_at`** on either (a console takedown racing a queued job must not regenerate taken-down content).
2. In a temp dir, download the PDF and run Agent 1 (`extract_pdf`, `extract_images`, `structure_book`) — passing `known_chapters=book.chapters` so the split is identical to indexing, plus `client`+`pdf_path` to enable the Claude fallback for books the heuristics can't read.
3. `_pick_chapter` selects the chapter by `generations.chapter_ref`.
4. **Scanned-chapter OCR cache** — if the sliced chapter has < 200 chars of text, transcribe its pages once with Claude vision (`vision_chapters.chapter_text_vision`) and cache the result in `chapter_grounding.source_text` (`get/set_chapter_source_text`, keyed `book_id+chapter_num`). Every later generation of that chapter — any kind, any owner — reuses it instead of re-running the minutes-long OCR.
5. **Chapter-content guard** (`chapter_check.verify_chapter_content`) — fails **loud** if the sliced pages don't read as the requested chapter, so a stale/wrong stored boundary never silently ships a lesson about the wrong unit.
6. Agent 2 analysis (`agent2_analysis.analyzer.run_full_analysis`, level `middle_school`) — concepts/difficulty/visuals; at most 2 Claude calls per chapter. The result is persisted to `chapter_grounding` (the AI-Tutor's "curriculum fence").
7. School branding is loaded (`worker.branding.load_branding` → accent/logo/docx template, with defaults).

Progress is written throughout (`db.set_progress` at 10/20/45/… up to 96) so the UI shows real movement, not just "queued".

**`presentation` → narrated deck + write-on video:**
- Agent 3 (`agent3_scripts.script_generator.generate_chapter_scripts_from_analysis`) — Socratic-by-default narration; `narration_style` comes from `generations.params` (default `socratic`).
- Grounding is enriched with the lesson's own narration text, and the tutor answer cache is warmed (`worker.tutor_warm.warm_tutor_cache`, gated `TUTOR_WARM_CACHE`, best-effort).
- Agent 5 (`agent5_slides.slide_generator.generate_episode_slides`) → `episode_{n}_deck.pptx` (`deck_path`). Slides are rendered natively — no AI-image step in the freemium path.
- Agent 6 (`agent6_animation.video_composer.compose_episode_videos`) → per-segment narrated MP4s; `tts_voice` from params, `allow_premium=_elevenlabs_enabled()`.
- Agent 8-render (`agent8_render.renderer.render_final_video`) → one concatenated `lesson.mp4`.
- Uploads: `{base}/deck.pptx` (artifact kind `deck_pptx`) and `{base}/lesson.mp4` (kind `video_mp4`), where `base = {owner_id}/{generation_id}`.

**`worksheet` / `exam_paper` / `activity` / `case_study` / `lesson_plan` → editable `.docx`:**
- `docgen.generate_document(kind, …)` dispatches by name to `docgen/{lesson_plan,activity,exam_paper,worksheet,case_study}.py` (all share one `build(...)` signature and inherit the school's `.docx` template header/footer/logo). Output uploaded to `{base}/{kind}.docx` (artifact kind `docx`).
- For `worksheet`/`exam_paper`, `docgen/questions.py` also emits a normalized `questions.json` (fill_blank/true_false/match are auto-gradable; short/subjective are teacher-graded) uploaded as `{kind}_questions.json` (artifact kind `questions_json`). Purely additive and best-effort — a missing enum value never fails the generation.

The run ends by setting the generation title, attributing Claude spend to `jobs.usage` (`client.session_usage`), and `finish_job` (mirrors `done` to the generation). The shared Claude wrapper is `shared/claude_client.py` (`ClaudeClient`, default model `claude-sonnet-4-6`, per-instance `session_usage` accounting with retry/JSON-parsing).

### 3.5 Text-to-speech (`shared/tts`)

Provider-agnostic, registry-driven. `shared/tts/registry.py` is the single source of selectable voices (`TTSVoice(voice_id, label, provider, tier, ref, style_tags)`): four **free Edge** voices (`edge-aria` is the global default, plus `edge-guy`, `edge-neerja`, `edge-sonia`) and two **premium ElevenLabs** voices (`el-rachel`, `el-adam`). The web voice-picker and the worker both read this list, so they can't drift.

`synthesize(text, out, voice_id, allow_premium, ssml_text, report)` enforces the free/premium gate **server-side**: `resolve_voice` collapses an unknown or premium-without-permission `voice_id` to the free default, so a client can't bypass the gate by sending a premium id. A premium call also checks a local spend cap (`shared/tts/cost.within_cap`) and falls back to the free Edge voice on cap-hit or any ElevenLabs API error — a generation never fails or overspends over TTS. The `report` dict surfaces `{requested, used, provider, downgraded}` so a silent premium→free downgrade is visible in the app (via `merge_generation_params`) instead of only being noticed by listening. Providers live in `shared/tts/providers/{edge,eleven}.py`.

Defense in depth: the worker's own `_elevenlabs_enabled()` gate (in `process.py`) requires **both** the `ELEVENLABS_ENABLED` flag **and** `ELEVENLABS_API_KEY` — premium never runs otherwise, regardless of the requested voice. (This is the crux of the open "el-adam falls back to default" investigation — the worker deployment must have both set.)

### 3.6 The native video engine (`agent6_animation`)

This is the freemium lesson-video renderer — deterministic, low-memory, multilingual, and $0. It replaced an OOM-prone cv2 SpeedPaint + moviepy mux, and then a flat PNG-loop, with a **native object-animation** engine.

- `video_composer.compose_episode_videos` builds **one MP4 per segment**: Edge/ElevenLabs TTS produces the narration MP3, then `native_render.render_native_segment` animates the slide's objects.
- `native_render` draws from the *same canonical layout* as the static slide (`agent5_slides.slide_builder.compose_slide`), so text fidelity is pixel-perfect and the video's final frame is identical to the downloadable deck's slide. The context line and title write on, the divider grows, then each bullet writes on left→right with a pen at the frontier (`_draw_pen`); the finished slide then freezes for the rest of the narration. `_write_speed` sizes the write-on phase to fit *inside* the narration (min/max clamps, `_MIN_HOLD_SECS` dwell), and ffmpeg's `tpad=stop_mode=clone` + an explicit `-t` duration hold the last frame (a silent `anullsrc` track fills clips with no audio). Output is uniform **1280×720, 24 fps, libx264/yuv420p, aac 128k/44.1 kHz** so downstream concat can stream-copy.
- **`RENDER_WORKERS` parallelism**: segments are independent, so they render on a `ThreadPoolExecutor` (default 4 workers, capped by CPU count; set `RENDER_WORKERS=1` to force the old sequential behavior without a redeploy). TTS is network I/O and the renderer shells out to ffmpeg, so threads overlap well and wall-clock drops from *sum-of-segments* toward *slowest-segment*. One crashed segment doesn't sink the rest; results are reassembled in index order for a deterministic concat. `DEBUG_VIDEO=1` burns a segment-type/index label on-frame (off in prod).
- `agent8_render/renderer.py` (`render_final_video`) concatenates the segments with ffmpeg's **concat demuxer**: first a stream-copy (near-instant, flat memory — works because every segment shares codec/timebase), with a `libx264 -preset veryfast -crf 23` re-encode fallback for non-uniform inputs. This deliberately avoids moviepy's in-RAM `concatenate_videoclips`, which OOM-killed the container.

### 3.7 Book Health scoring (`agent1_ingestion/book_health.py`)

`compute_book_health(extraction, chapter_defs)` is a pure, no-I/O function run at index time. It scores two dimensions 0–100 — `text_layer` (machine-readable text coverage / scanned-ness, from `extraction.readability_score`) and `structure` (chapter-detection plausibility) — and blends them (`structure` weighted a touch higher). It returns `{score, band, dimensions, facts, problems, recommendation, note}` stored on `books.health`, so a bad scan is flagged to the teacher **before** it generates failed lessons (prevention ahead of the support agent). It is deliberately honest about scans: a scanned book (no text layer) is read well by the vision path, so it scores "good" with an informational note and is capped at 82 (never "excellent", never "poor"); a single detected unit caps at 66; no chapters / <5 pages are hard caps.

### 3.8 The math microservice (`mathsvc`)

A **second Railway service** — a constrained SymPy FastAPI app (`mathsvc/app.py`) whose only caller is the Next.js AI-tutor/assistant orchestrator. `POST /math` is authenticated with an `X-Math-Token` header compared to `MATH_SVC_TOKEN` via `hmac.compare_digest` (fails **closed** with 503 if the secret is unset, 401 if wrong); `GET /health` is the unauthenticated Railway liveness probe.

Crucially, **no model-generated code ever executes**. The LLM emits a structured tool call `{"op": "<name>", …}` and the service dispatches by name through a hand-written whitelist `OPS` (`mathsvc/ops.py`): `solve`, `solve_system`, `simplify`, `factor`, `expand`, `differentiate`, `integrate`, `evaluate`, `substitute`, `physics_eval`. A hallucinated op name fails closed rather than reaching Python. Inputs are vetted and complexity-bounded in `mathsvc/safety.py` (`run_with_timeout`, `MAX_EXPRS`/`MAX_SUBSTITUTIONS`, a power-tower/expand DoS guard), and every op returns `(result, steps)` where `steps` are short human-readable method strings the tutor narrates. All handled requests return HTTP 200 `{"ok": true|false, …}`; error strings are child-safe and never leak tracebacks, because they may be read aloud to a student.

### 3.9 A note on generation time

There is no fixed "3 minutes". A presentation generation is **minutes** of real work — several Claude calls (extraction fallback, chapter check, analysis, script generation, indexing metadata), per-segment TTS network round-trips, and per-segment ffmpeg encodes plus a final concat. Scanned books add a one-time vision-OCR pass (cached thereafter). Actual wall-clock scales with chapter length, number of segments, whether the book is scanned, and `RENDER_WORKERS`; document (`.docx`) kinds are faster because they skip slide/TTS/video rendering entirely. Any UI copy implying a fixed short duration is an approximation, not a guarantee.

---

## 4. Auth, roles & onboarding

Authentication is handled entirely by **Supabase Auth** (GoTrue). The Next.js app never stores passwords itself; it holds a cookie-based Supabase session and reads a mirror `profiles` row for role/identity. This section covers how a person gets a session (adults vs. students), how their role decides what they see, the blocking first-run profile step, the product tour, and the hierarchical password-recovery path.

### 4.1 Supabase clients & the session middleware

Three client factories, chosen by trust level:

| File | Client | Key | Use |
| --- | --- | --- | --- |
| `src/utils/supabase/client.ts` | browser | anon | Client Components (login/signup forms, OAuth button) |
| `src/utils/supabase/server.ts` | cookie-aware server | anon | Server Components / Route Handlers; `cookies()` is awaited (Next 16) |
| `src/utils/supabase/admin.ts` | `createAdminClient()` | **service role** | Route Handlers only; bypasses RLS. Throws if `SUPABASE_SERVICE_ROLE_KEY` is unset |

`src/utils/supabase/proxy.ts` (`updateSession`, invoked from `src/proxy.ts` — Next.js 16's renamed middleware) runs on every request: it refreshes the auth cookie, then does coarse route-gating — unauthenticated hits to `/dashboard/*` redirect to `/login`, and an authenticated user on `/login` or `/signup` is bounced to `/dashboard`. `/auth/*` handlers pass through untouched. Finer authorization (role capabilities, cross-tenant reads) is enforced per-route via RLS and the service role, not here.

### 4.2 Adult sign-up / sign-in (email + Google)

- **Email/password** — `src/app/signup/page.tsx` calls `supabase.auth.signUp` with `options.data = { full_name, role }` and `emailRedirectTo` → `/auth/confirm`. If email-confirmation is off a session comes back immediately; otherwise the user confirms via `src/app/auth/confirm/route.ts` (handles both the `token_hash`→`verifyOtp` and PKCE `code`→`exchangeCodeForSession` flows, with an open-redirect-safe `next`). Login is `src/app/login/page.tsx` → `signInWithPassword`.
- **Google OAuth** — `src/components/oauth-button.tsx` is provider-agnostic (a `PROVIDERS` map leaves room for Facebook with the same code path) and calls `signInWithOAuth`, returning to `src/app/auth/callback/route.ts`. That handler exchanges the PKCE code, then enforces a **role guardrail**: a fresh Google user is created as `teacher` by the DB trigger (Google never sends a `role`), and if the resolved profile is somehow a `student` it signs them out with "this sign-in is for teachers." It also opportunistically claims any parked Lemon Squeezy purchase for the verified email. OAuth is offered on the login, teacher-signup, and school-signup screens (never on the student path).
- **School setup** — `src/app/schoolsignup/page.tsx` is the public "set up your school" entry (option C): create an account (email or Google), then name the new school at `/schoolsignup/finish` and become its `school_admin`.

### 4.3 Students: username → synthetic email

Students never have a real inbox. `src/utils/student.ts` maps a name-derived ID to a synthetic address under `students.sketchcast.app` (`studentEmail("aisha.khan")` → `aisha.khan@students.sketchcast.app`); `usernameBase()` builds the collision-free stem. The login form (`login/page.tsx`) branches on the presence of `@`: input **with** `@` is used verbatim (adult email), input **without** `@` is passed through `studentEmail()` before `signInWithPassword`. Students are provisioned by a teacher/parent (service-role auth-user creation) with `must_reset_password = true`, so their first sign-in is forced through the password-change flow (§4.6). Because their synthetic address receives no mail, students cannot self-recover — the hierarchical reset is their only recovery route.

### 4.4 Role model & capability-based navigation

`user_role` is a Postgres enum, grown over time: `school_admin | teacher | student` (`0001_init.sql`), `+ coordinator` (`0009_school_analytics.sql`), `+ parent` (`0017_parent_role_enum.sql`). Two hard rules underpin the whole model:

1. **Role is never self-assignable.** `role` and `school_id` are `service_role`-only columns (column-level GRANTs in `0010_invites.sql`); `authenticated` may only edit safe fields (`full_name, username, parent_email, must_reset_password`). Every role change goes through a service-role route (invite accept, onboarding, school setup).
2. **Default is teacher.** The `handle_new_user()` trigger (`0001`, updated in `0012_beta_autoflag.sql`) inserts a `profiles` row on `auth.users` insert, defaulting `role` to `teacher` and flagging every new account `beta_tester = true`.

Navigation is **capability-based, not role-based** — computed server-side in `src/app/dashboard/app-header.tsx` (`tabsFor()` / `labelFor()`):

- **Every adult implicitly teaches.** Teacher access is ownership-based in the DB, so teacher/coordinator/school_admin/parent all get the Library + My Analytics tabs and land on the Library.
- **Coordinator is a grant, not just the enum.** The "School / Teachers / Access" tabs appear when `role === "school_admin"` OR the viewer holds `coordinator_scope` rows (checked via RLS `cs_self_read`, gated by `schoolAnalyticsEnabled()`). School-admins additionally get Invites + Admin.
- **Parent is a grant too.** If the viewer has any `parent_links` rows (RLS `pl_parent_read`, gated by `parentPortalEnabled()`), the My Children + Test Papers tabs appear — a teacher who is also a parent gets both sets. Migration `0035` made parents full authors (dropped the old test-papers-only trigger).
- **Students are exclusive.** `role === "student"` → no tabs; a minor never gains adult capabilities.
- The header label shows the **union** of hats held, e.g. `admin & teacher`, `teacher & coordinator`, or `teacher & parent`.

### 4.5 Blocking new-joiner profile onboarding

Prevents anyone from silently running the app as the defaulted `teacher`. Gated by `onboardingEnabled()` (`FEATURE_ONBOARDING`, `src/utils/flags.ts`); backed by migration `0038_onboarding_profile.sql`, which adds `profiles.onboarded_at timestamptz` (the gate) and `profiles.profile jsonb` (flexible answers), and backfills all pre-existing users to `now()` (with a 5-minute guard so a brand-new signup isn't swept in) so **only new signups** ever see it.

Flow:

1. **Gate** — `src/app/dashboard/layout.tsx` reads `role, onboarded_at`. If the flag is on and `onboarded_at IS NULL` and `role !== "student"`, it `redirect("/onboarding")`. Students are exempt (they have their own `must_reset_password` first-run), and deliberately-provisioned adults (invited teacher/coordinator/admin, school_admin) never reach it because those flows stamp `onboarded_at` at creation. A missing/`null` profile (0038 not applied) falls through untouched.
2. **Form** — `src/app/onboarding/page.tsx` (server, re-checks auth + not-already-onboarded) renders `onboarding-form.tsx`: a Teacher/Parent toggle *seeded* from the signup pick but confirmed here, plus role-specific required fields (teacher: affiliation, school name if school, grade levels, subjects; parent: children count, child grade levels).
3. **Shared pure logic** — `src/utils/onboarding.ts` exports `seedRole`, `missingRequired`, and `homeForRole`. `missingRequired()` runs identically on the client (disables "Continue") and the server (rejects a bypass), so the two gates can never disagree.
4. **Write** — `POST src/app/api/onboarding/route.ts` authenticates via session, **whitelists role to teacher/parent** (a user can never self-assign coordinator/admin here), re-validates with `missingRequired()`, sanitises the jsonb to known keys, then uses the **service role** to write `role, full_name, profile, onboarded_at = now()` (because `role` is service-role-only). Returns the confirmed role; the form redirects to `homeForRole()` (`/dashboard/children` for parents, else `/dashboard`) with a hard refresh so the layout re-reads the now-onboarded profile.

Invite acceptance (`src/app/invite/[token]/accept/route.ts`) explicitly stamps `onboarded_at = now()` so invited users skip this gate — the invite's role already identifies them.

**Prod status: `FEATURE_ONBOARDING` is ON** (verified 2026-07-12; migration 0038 applied).

### 4.6 The onboarding coach-mark tour

A config-driven product tour built on **driver.js**, living under `src/tour/` and mounted once for every dashboard surface by `dashboard/layout.tsx` (`TourProvider`). Gated client-side by `NEXT_PUBLIC_FEATURE_TOUR`; state persisted via migration `0037_onboarding_tour.sql` (`user_tour_progress` — one versioned row per user/tour, RLS self-scoped; `tour_events` — service-role-only analytics sink).

- **Content is data** — `src/tour/definitions.ts` holds five role tours (`teacher`, `student`, `parent`, `school_admin`, `coordinator`), each a list of steps targeting `data-tour="..."` markers on real UI. This is the only file product edits; bumping a tour's `version` re-shows it to everyone.
- **Engine isolation** — `src/tour/engine.ts` wraps driver.js behind a swap-able `TourEngine` interface; `src/tour/logic.ts` holds the pure, unit-tested decisions (`shouldAutoStart` version gate, `resolveSteps` missing-target split).
- **Runtime** — `src/tour/TourProvider.tsx` auto-starts the right tour once the user is on its `homePath` (deferred with a timer for hydration), **skips missing targets gracefully** (never spotlights empty space), respects `prefers-reduced-motion`, and records completed/skipped via `sendBeacon`. A "Take a tour / replay" button in the header drives `replay()`. The server layout resolves role + versioned seen-state and hands it in; everything degrades to "no tour" if signed out or the 0037 tables aren't applied.

**Prod status: `NEXT_PUBLIC_FEATURE_TOUR` is ON** (migration 0037 applied).

### 4.7 Hierarchical password recovery

Two complementary paths, since students have no inbox:

**Self-serve (adults).** `src/app/login/forgot/page.tsx` calls `resetPasswordForEmail` with a redirect to `/auth/confirm?next=/auth/update-password`. Student IDs (no `@`) are detected and pointed at their teacher/parent instead. The response is identical whether or not the email exists (no account enumeration). The recovery link verifies the OTP in `/auth/confirm` (establishing a session), then lands on `src/app/auth/update-password/page.tsx`, which sets the new password and clears `must_reset_password` via the user's own RLS-granted update.

**Adult-resets-account-below (the student recovery route).** `POST src/app/api/reset-password/route.ts` follows a guard → mutate → audit shape:
- The session client only identifies the caller; all cross-tenant reads (target profile, enrollments, parent_links, coordinator_scope grades, platform-staff status) go through the **service role** *after* the caller is known.
- The pure `src/utils/reset-scope.ts` `decideReset()` makes the allow/deny call on plain data (fully unit-tested in `__tests__/reset-scope.test.ts`). Rules (first match wins), after never-allow guards (self, any `school_admin` target, any platform-staff target, and student callers can reset nobody): **teacher** (owns a class the student is enrolled in) → **parent** (`parent_links` row) → **school_admin** (any non-admin member of their own school) → **coordinator** (holds `coordinator_scope` grades matching the target's enrolled grade in the same school — coordinator here is the *grant*, not merely the enum, matching the 0009 RLS grade equality).
- On allow it mints a readable throwaway password with `src/utils/temp-password.ts` (`generateTempPassword()` → e.g. `fern-mint-star38`; ~23 bits, unambiguous alphabet, rejection-sampled), calls `admin.auth.admin.updateUserById`, sets `profiles.must_reset_password = true`, writes a `platform_audit_log` row (`action: "reset_password"`, `detail.via`), and returns the temp password + username **once** (never stored).

The `must_reset_password` flag is the connective tissue: `dashboard/page.tsx` redirects any user carrying it to `/auth/update-password`, forcing a real password before app use — the same mechanism that powers a freshly-provisioned student's first sign-in. Migration `0031_clear_stale_reset_flag.sql` clears stale flags left by earlier flows.

### 4.8 Flag summary (auth-relevant)

| Flag | Scope | Prod (2026-07-12) |
| --- | --- | --- |
| `FEATURE_ONBOARDING` | Blocking new-joiner profile gate (§4.5) | **ON** |
| `NEXT_PUBLIC_FEATURE_TOUR` | Coach-mark tour (§4.6) | **ON** |
| `FEATURE_PARENT_PORTAL` / `NEXT_PUBLIC_FEATURE_PARENT_PORTAL` | Parent role, My Children/Test Papers nav, parent invites | **ON** |
| `FEATURE_SCHOOL_ANALYTICS` | Leadership (School/Teachers/Access) nav + coordinator oversight | gated; server checks authoritative |

Client-facing flags (`NEXT_PUBLIC_*`) only decide what renders; the server-side checks in `src/utils/flags.ts` and the service-role write paths (plus DB column GRANTs and RLS) are always authoritative.

---

## 5. Library & authoring

The library is the teacher's home surface: upload a textbook PDF, let the worker index it into a chapter list, then one-click-generate any of six content types per chapter. It is almost entirely server-rendered by `src/app/dashboard/page.tsx` (a Next.js async server component), with small `"use client"` islands for the interactive controls. All persistence flows through Supabase (Postgres + Storage); the heavy work is handed to the Python worker via DB-trigger-created `jobs` rows (see the worker section).

### 5.1 Uploading a textbook PDF → index

`src/app/dashboard/upload-book.tsx` (client) drives the upload:

1. **Signed upload + progress.** It asks Supabase Storage for a signed upload URL on the private `uploads` bucket at `\`${user.id}/${Date.now()}_${safeName}\`` (filename sanitised to `[a-zA-Z0-9._-]`), then `PUT`s the file over a raw `XMLHttpRequest` so it can surface real upload-progress events (fetch can't) — big scanned textbooks on flaky connections are the top real-world failure, so the transfer gets **one automatic retry** and a live percentage/`Finishing…` button state.
2. **Row insert.** On success it inserts a `books` row with `status: "indexing"`, `owner_id`, `school_id`, `storage_path`, and a title that defaults to `cleanBookTitle(file.name)` when the teacher left the (optional) title/author fields blank. `router.refresh()` re-runs the server component so the new row appears.
3. **Auto-queued index job.** The `on_book_created` trigger (migration `0001_init.sql`) fires `create_index_job_for_book()`, inserting a `jobs` row with `type = 'index_book'`. The client never touches `jobs`.
4. **Worker indexing** (`sketchcast/worker/process.py` → `index_book`): downloads the PDF, extracts + structures the chapter list (Agent 1), then runs a Claude **chapter-audit** pass that fixes garbled titles and, if most entries look wrong, escalates to a vision re-detection (`detect_chapters_vision`) for scanned books. It also computes the Book Health score, renders a page-0 cover thumbnail to `\`${owner_id}/covers/${book_id}.png\`` in the `artifacts` bucket, and Claude-detects `grade` / `subject` / a clean `title` + `author`. Finally `db.set_book_chapters(..., "ready")` writes the `chapters` JSONB (`[{num,title,start_page,end_page}]`) and flips `status` from `indexing` → `ready`. The stored page boundaries are reused verbatim by every later generation so the book always splits identically.

The library polls while any book is `indexing` or any lesson is `queued`/`processing` via `<AutoRefresh active={hasPending} />`; the row shows "Finding chapters…" until `ready`.

### 5.2 The library UI

`page.tsx` loads the teacher's own content (ownership is filtered explicitly with `.eq("owner_id", user.id)` — admins/coordinators can read school-wide rows under RLS, but their Library is their "teacher hat", not the school view). It fetches `books` (with a graceful fallback select that drops the `health` column so a not-yet-applied migration can't break the page), signs cover thumbnails, and fetches all `generations` with their embedded `artifacts` and `jobs(progress,status)`.

Books are grouped **Grade → Subject** (auto-detected; "Other / General" when unknown) and rendered by `book-table.tsx`, a client collapsible table:

- Each row shows the cover (`BookCover`), `cleanBookTitle(title)`, author, a `doneChapters/totalChapters` counter, the health badge, a created date, and delete. A single book auto-expands.
- Expanding a `ready` book lists its chapters; a scanned-PDF warning banner appears when `health.facts.has_text_layer === false`.
- Whole-book affordances: **Assign book** (via `AssignModal`) appears once every chapter's presentation is `done`; **Generate all** (`generate-all-button.tsx`) batch-queues a presentation for every still-pending chapter (with a confirm dialog). An `error` book (chapter detection failed) offers a "Generate full book" fallback with `chapter_ref = null`.
- Legacy whole-book lessons (null/stale `chapter_ref`) surface under an "Other lessons" subsection.

The empty state renders a 3-step "Upload → Generate → Assign" journey graphic.

### 5.3 The six generation_kinds + per-chapter one-click generation

The `generation_kind` enum (migration `0001_init.sql`) defines exactly six kinds: **`presentation`** (narrated lesson = deck + video), **`lesson_plan`** (teacher-only, never assigned to students), **`activity`**, **`worksheet`**, **`exam_paper`**, **`case_study`**.

Per chapter, `chapter-generate.tsx` renders one control row (`ChapterGenerate`):

- **Kinds not yet generated** each get a checkbox; a single `Generate (N)` button inserts one `generations` row per checked kind in a batch. The `on_generation_created` trigger (`create_job_for_generation()`) then creates one `jobs` row per generation (`type = kind`). Document kinds carry `defaultParams(kind)` (from `options-modal.tsx`) so a batch queue uses the same defaults the modal would; `presentation` carries `{ narration_style, tts_voice }` selected from inline dropdowns (`@/utils/narration`) that appear when the Lesson checkbox is ticked.
- **Already-generated kinds** render their `ContentCell` (`content-cell.tsx`) instead: status pill (`queued`/`{progress}%`), or `done` download links, or a `failed` state with retry + report. For a `presentation` this means **▶ Watch** (video) + **⬇ Deck**, plus an **Ask Coach** entry point and Regenerate/Delete/Report; for document kinds a **⬇ Download**.
- **Assign chapter** appears once any student-facing kind is `done` (the lesson plan is deliberately excluded from `studentKinds`).

Individual (non-batch) generation goes through two thin client wrappers that both just insert a `generations` row: `generate-button.tsx` (used directly for `presentation` and whole-book) and `options-modal.tsx` (document kinds — a modal exposing per-kind fields such as exam question-mix counts, worksheet difficulty, lesson-plan duration; `spec.build()` shapes flat fields into the nested `params` the worker expects). There is no authoring API route — the client writes `generations` directly under RLS (`gen_write`), and the trigger + worker do the rest.

### 5.4 Artifacts + signed-URL serving

The worker writes output files to the private `artifacts` bucket and records one `artifacts` row per file. The `artifact_kind` enum covers `deck_pptx`, `video_mp4`, `slide_png`, `pdf`, `docx`, `other` (`0001`) plus **`questions_json`** (added by `0007_questions_artifact.sql` — a structured quiz emitted alongside worksheet/exam `.docx` that powers the in-app quiz player). A `presentation` yields `deck_pptx` + `video_mp4`; document kinds yield `docx` (+ `questions_json` for worksheet/exam).

Serving is always via short-lived **signed URLs** (never public):

- **Teachers** own their artifacts, so `page.tsx` signs each `storage_path` directly with the request-scoped client: `supabase.storage.from("artifacts").createSignedUrl(path, 3600)` (1-hour TTL). Cover thumbnails are signed the same way.
- **Students** don't own the files, and the storage policy only lets the owning teacher sign. So the student branch of `page.tsx` signs through a **service-role admin client** (`createAdminClient()`); if the service key is missing it degrades to `downloadsReady = false` rather than erroring.

Download clicks in `ContentCell` optionally fire `recordArtifactView(...)` (beta view-tracking) via the `onClick` handler.

### 5.5 School branding templates

`branding-card.tsx` (a collapsible `<details>` card) lets a teacher upload their school's Word (`.docx`) and PowerPoint (`.pptx`) templates. Each file is `upsert`ed to `uploads/{uid}/branding/template.{kind}` and the path recorded in the `branding` table (`docx_path` / `pptx_path`, keyed on `owner_id`; table + RLS from `0004_branding.sql`, base row in `0001`). The worker then brands every output from these: new documents open from the `.docx` template; the deck and the video slides adopt the `.pptx` theme, colours and logo. `page.tsx` reads the branding row only to pre-fill the card's "✓ Uploaded" state.

### 5.6 The `cleanBookTitle` display fix

`src/utils/book.ts` exports `cleanBookTitle(raw)`, used wherever a book title is shown (`upload-book.tsx` default, `book-table.tsx` rows). Uploaded PDFs frequently carry junk download-site filenames (e.g. `pdfcoffee.com_cambridge-maths-5-learner-book-pdf-free`) that become the title when no human title was typed. The helper only rewrites strings that **look like a filename/slug** (no spaces, `.pdf` extension, a `domain.tld` head, or a trailing `pdf`/`free` token): it strips the extension, domain head, and trailing junk tokens, collapses `_`/`-` to spaces, and title-cases the result. A real human/indexer-written title (has spaces, no cruft) is returned untouched. This is purely presentational — it does not mutate the stored `title` (the worker's Claude metadata pass does the durable cleanup at index time; see §5.1).

### 5.7 Book-health badge

`book-health-badge.tsx` renders the `books.health` JSONB (column added by `0021_book_health.sql`) as a compact colored chip (`Health {score} · {band}`) that expands to a detail popover: per-dimension bars (text quality, chapters), facts (pages / chapters / text-vs-scanned), problems, and a recommendation. It is pure presentation — the score/band/dimensions are computed by the worker's `compute_book_health` at index time (§5.1). The component no-ops if `health` is null, and `page.tsx` degrades to a health-less select if the column is missing, so the library never breaks on an un-applied migration. The `has_text_layer === false` fact also drives the scanned-PDF warning banner inside the expanded book.

### 5.8 The beta / trial 1-book cap (migration 0024)

`0024_launch_trial_caps.sql` sets the current launch policy: for the ~1-month open trial **every** user gets the full feature set with **no tier/feature gating** — the only limit is a **single uploaded book** (all of whose chapters and every content kind can be generated). It does this by redefining the shared `effective_cap(uid, which)` default to `books → 1`, everything else unlimited (`2147483647`), which **supersedes** the older per-beta-tester defaults from `0011_teacher_beta.sql`. Enforcement is a `BEFORE INSERT/UPDATE` trigger on `books` (`enforce_beta_book_cap`) — it holds against direct API calls and even service-role inserts, and blocks a content-swap update (new `storage_path`/`chapters`) while at the cap, while still letting the worker's `auth.uid() = null` indexing writes through. Lowering the cap never deletes existing books; a per-user `profiles.max_books` override (set from the platform console) lifts individual founder/demo accounts.

The UI mirrors this server truth: `page.tsx` computes `betaBlocked = isBeta && bookList.some(b => b.owner_id === user.id)` (counting only the teacher's **own** books, since the library select also returns school-shared ones). When blocked, `upload-book.tsx` replaces the form with a "Beta is limited to 1 book" card. The complementary **1-chapter** cap (from `0011`, still relevant for flagged beta testers) is reflected in `chapter-generate.tsx`: once any generation pins a `(book, chapter)`, every other chapter renders `betaLocked` with a "Beta: 1 chapter — locked" chip and no new-generation checkboxes; `enforce_beta_generation_cap` enforces the same pin server-side.

---

## 6. Classes, students, assignments & analytics

This is the student ↔ teacher loop: a teacher creates a class, provisions student logins, assigns generated chapter content to the class, and then sees—per student—what is completed, revised, or incomplete, plus scores. On top of that sits a flag-gated leadership layer (admin / principal / coordinator) that rolls the same signals up into an at-risk worklist. The design doc is `sketchcast-app/docs/student-teacher.md`; Phases A–C are shipped.

### Data model (recap)

The assignment primitive predates this subsystem; the key insight is **the assigned set is derived, progress is recorded** — no per-student fan-out at assign time.

- `classes(teacher_id, school_id, name, grade, join_code)` — a teacher's roster.
- `enrollments(class_id, student_id)` — who is in a class.
- `generation_shares(generation_id, class_id, shared_by, due_at)` — a chapter item assigned to a class. **Assigned set = `generation_shares ⋈ enrollments`**, so it auto-adjusts as enrollment changes.
- `student_progress(generation_id, student_id, class_id, status, progress_pct, opened_at, completed_at, revised_at, revision_count)` — `status` is the enum `progress_status` = `assigned | in_progress | completed | revised`; unique on `(generation_id, student_id)`.
- `submissions(generation_id, student_id, mode, answers, file_path, auto_score, max_score, teacher_score, feedback, grade_status, …)` — `mode` = `interactive | file`, `grade_status` = `auto | pending | graded`; unique on `(generation_id, student_id)`.

Migrations 0006 (progress/submissions), 0009/0010 (school analytics RLS + `coordinator_scope` + `analytics_access_log`), 0011/0016 (student-cap triggers) are the relevant ones.

### Class creation & student credential hand-out

The teacher UI is `sketchcast-app/src/app/dashboard/classes-card.tsx` (a collapsible "Classes & students" card). Creating a class is a direct client-side `classes` insert (`teacher_id = auth.uid()`, RLS-scoped), with a case-insensitive duplicate-name guard.

Adding students POSTs to `sketchcast-app/src/app/api/students/route.ts` (`runtime = "nodejs"`), which runs with the **service role** because provisioning bypasses RLS. Per student it:

1. Verifies the caller owns the target class.
2. Enforces the student cap (`profiles.max_students`, else `beta_tester ? 2 : null`) as a friendly pre-check before the DB trigger (0011/0016) would hard-block it.
3. Picks a free `username` via `usernameBase(first,last)` (`first.last`, then `first.last2`, …), generates a 10-char temp password from an unambiguous alphabet (`tempPassword()`), and creates an auth user under a **synthetic email** `studentEmail(username)` — the login is the student ID, not the parent email (siblings can share one parent email).
4. Fills the profile (`username`, `full_name`, `parent_email` for comms only, `must_reset_password = true`, `school_id`, `role = "student"`, `onboarded_at` to skip the 0038 onboarding gate) and inserts the `enrollments` row. If enrollment is refused (cap trigger), it deletes the just-created auth user so no orphan credentials are handed out.

The route returns `{ created, errors }`; the card renders the created `ID / Password / Parent` rows with a "Copy all" button for the teacher to hand to parents. Each roster row also carries a `ResetPasswordButton` (hierarchical reset → new temp password). Students join classes either by provisioning here or by a join code (`classes.join_code`, shown as a chip). `ClassProgress` (loaded on demand under each class) is described below.

### Assigning a chapter to a class

`sketchcast-app/src/app/dashboard/assign-modal.tsx` is the "Assign to a class" control that appears on generated content. It takes one or many `generationIds` (single chapter item or a whole book), a class (with inline class-creation if the teacher has none), and an optional due date, then upserts `generation_shares` rows keyed on `(generation_id, class_id)` with `shared_by = auth.uid()` and `due_at`. Per the locked decision, **assigning a chapter assigns everything student-facing** (lesson video+deck, worksheet, exam, activity, case study); the `lesson_plan` kind is teacher-only and filtered out of the student view.

### Student assigned-only view & view-tracked completion

The student branch of `sketchcast-app/src/app/dashboard/page.tsx` (`role === "student"`) derives the assigned set via RLS: the `shared_to_me(gen)` helper lets a student read only content shared to a class they're enrolled in (plus direct parent-portal shares, where `class_id` is null → grouped under "From your parent"). Artifacts are **signed server-side with the service role** (the storage policy only lets the owning teacher sign directly); if the service key is missing, `downloadsReady = false` and a banner tells the student to wait. Items are grouped by class → chapter, using the book's real chapter titles where available. It signs `video_mp4`, `deck_pptx`, `docx`, and `questions_json` (the interactive quiz).

`sketchcast-app/src/app/dashboard/student-dashboard.tsx` renders the groups; each item is a `sketchcast-app/src/app/dashboard/student-item.tsx`. All progress writes go through the **student's own session** (RLS `sp_student_rw`). The `progress_status` transitions:

- `markOpen()` — opening a not-started item → `in_progress` (sets `opened_at`). Opening an already `completed`/`revised` item → `revised` with `revision_count++` (this is what drives revision hotspots).
- `markComplete()` — lesson video `onEnded` (watched to 100%), or a quiz/file submission → `completed` (`progress_pct = 100`). Completion is measured, never self-reported.

Lessons play in an in-app modal (`▶ Watch`); the Pro+ "🎓 Assistant" button appears when `NEXT_PUBLIC_FEATURE_AI_TUTOR` is set. Worksheets/exams offer three paths: `⬇ Open` the `.docx`, **Take quiz** (interactive), or **Submit file** (upload an answer file to the `submissions` storage bucket under `{studentId}/{genId}/…`, recorded `mode: "file"`, `grade_status: "pending"`). Either submission path calls `markComplete()` — completed = submitted; the grade is a separate layer.

### Interactive quiz + auto-grading + teacher marking

`sketchcast-app/src/app/dashboard/quiz-player.tsx` reads the worker-emitted `questions.json` (artifact kind `questions_json`). Question types: `fill_blank`, `short`, `true_false`, `match`, `subjective`. On submit it **auto-grades the objective types** — `fill_blank` (normalized string equality), `true_false` (boolean equality), `match` (per-pair, with right-hand options sorted deterministically so they don't line up) — accumulating `auto`/`max`. `short` and `subjective` set `needsReview = true`. The result upserts a `submissions` row (`mode: "interactive"`, `answers`, `auto_score`, `max_score`, `grade_status = needsReview ? "pending" : "auto"`).

Teacher marking is `sketchcast-app/src/app/dashboard/grade-list.tsx`, rendered as the "To grade" queue on the analytics page (only rows with `grade_status = "pending"`). For a **file** submission it opens the uploaded file via `/api/submission-url`. For an **interactive** submission it shows `Auto-scored X/Y` and a **"Review answers"** toggle that fetches the signed quiz JSON and renders each question with the student's written answer, marking objective ones ✓/✗ and flagging short/subjective as "• mark this" (with the model `answer_outline`). Saving writes `teacher_score`, optional `feedback`, `grade_status = "graded"`, `graded_by`, `graded_at` (RLS `sub_teacher_grade`) and drops the row from the queue.

### Teacher analytics + revision hotspots

`sketchcast-app/src/app/dashboard/analytics/page.tsx` ("My Analytics") is a server component built from `assigned-set ⋈ student_progress ⋈ submissions`, **pinned to the teacher's own classes/lessons** (a no-op for a plain teacher whose RLS already equals ownership, but it keeps the page personal for admins/coordinators who can read school-wide rows). It renders:

- Metric cards: Classes · Students · Assignments · Completion % · Overdue · To grade. Completion shows `—` (not `0%`) when nothing is assigned yet — no-data ≠ measured zero. Done = `completed | revised | submitted`; overdue = incomplete past `due_at`.
- **By class** completion bars.
- **Most revised** — the revision hotspots: gens ranked by count of `status = "revised"` (top 5), surfaced as "topics students re-open most — often the trickiest ones."
- **To grade** — the `GradeList` queue above; for pending interactive subs it service-role-signs the `questions_json` so the teacher can read written answers.

When `FEATURE_SCHOOL_ANALYTICS` is on, the page also shows a **transparency panel** ("What your school sees about your teaching") computed from the teacher's own data — lessons made, assignments, grading turnaround, backlog — so leadership metrics hold no surprises. The per-class on-demand roster (`✓ completed · ↻ revised · incomplete · overdue`) is `sketchcast-app/src/app/dashboard/class-progress.tsx`, loaded by a click under each class in the Classes card.

### School oversight (`FEATURE_SCHOOL_ANALYTICS`)

The leadership suite under `sketchcast-app/src/app/dashboard/school/**` is gated by `schoolAnalyticsEnabled()` (`sketchcast-app/src/utils/flags.ts`, env `FEATURE_SCHOOL_ANALYTICS`, default OFF; requires migrations 0009/0010). Every page redirects to `/dashboard` when the flag is off or the role is out of scope. **Access is RLS-enforced, not UI-hidden** — the DB policies return only in-scope rows per role:

- **Coordinator is a capability, not an identity.** A teacher granted `coordinator_scope(coordinator_id, school_id, grade, subject)` rows keeps their teacher role and dashboard and additionally sees the coordinator view of that grade/subject slice. Grants are managed **admin-only** via `sketchcast-app/src/app/api/coordinators/route.ts` (`add_scope` / `remove_scope` / `revoke_coordinator`), which verifies the caller is a `school_admin` and the target is in the **same school** (multi-tenant safety) before writing with the service role. The RLS policies key off the scope rows, not the role enum; `revoke` also normalizes any legacy enum-`coordinator` back to `teacher`.

- **`/dashboard/school` (School)** — the **at-risk worklist**, the headline deliverable. It reuses the teacher metric definitions rolled up, then flags students by need-based rules (all tunable constants at the top of the file): low completion (`< 50%` with ≥2 assigned), inactivity (`> 14d` / "never started"), low average score (`< 50%`), declining scores (recent avg `0.15` below earlier), and `≥ 2` overdue. **Coordinators see the named, actionable worklist** (with a "Contact parent" mailto) for their slice; **principals/admins see aggregate counts by grade only** — names are deliberately not profiled school-wide (DPDP-minded; minors' data stays close to the coordinator).

- **`/dashboard/school/teachers` (Teachers)** — Layer B: per-teacher activity (lessons generated, assignments, grading backlog/turnaround) and their students' completion, framed as *support not ranking* — flagged against the cohort's own completion baseline, ordered need-first, no leaderboard.

- **`/dashboard/school/access` (Access)** — a plain-language, read-only "Who can see what" view of the scoping model plus each coordinator's resolved footprint (classes/students/teachers), so leadership can trust the model with minors' data.

- **`/dashboard/school/admin` (Admin, `school_admin` only)** — roster role management, the coordinator→(grade, subject) scope editor (`CoordinatorAdmin`), member password resets, and the **access-audit log**. Every leadership view writes an `analytics_access_log` row (actor, role, school, scope, target kind, detail) as a DPDP trail; the write is wrapped so a logging failure never breaks the page.

---

## 7. Parent portal

The parent portal lets a parent link to their child's account, watch that child's schoolwork read‑only, author content for the child (test papers and — since migration `0035` — every other artifact kind), and get an AI assistant grounded on the child's books. Parents are a distinct billing audience with their own Family plan.

**Feature flag.** Everything is gated by `FEATURE_PARENT_PORTAL` (server, authoritative — `parentPortalEnabled()` in `src/utils/flags.ts`) plus `NEXT_PUBLIC_FEATURE_PARENT_PORTAL` for the client signup role picker. When off, `/api/children` returns 404, the `/dashboard/children` and `/dashboard/test-papers` pages `redirect("/dashboard")`, and the parent option disappears from signup and invites. The **DB guards hold regardless of the flag** — the child cap and link‑sanity triggers live in Postgres.

### 7.1 Role and the `parent_links` grant model

Migration `0017_parent_role_enum.sql` adds `'parent'` to the `user_role` enum (must run alone — `ALTER TYPE … ADD VALUE` has to commit before `0018`/`0019` reference it).

Parenthood is modelled as a **grant, not a role swap** (like coordinator scopes). The core table is `public.parent_links` (`0018_parent_links.sql`):

```
parent_links (id, parent_id, child_id, source 'school'|'self',
              created_by, verified_at, created_at, unique(parent_id,child_id))
```

- **`verified_at`** is set only when the invite email matched the child's `parent_email` on file; an unverified link still grants access but the My Children UI shows an "unverified link · confirm with the school" note (`children/page.tsx`).
- **`source`** is `'self'` for a parent who created the child themselves, `'school'` for an invite‑established link.
- **Writes are service‑role only.** There are RLS `SELECT` policies (`pl_parent_read` = own links; `pl_admin_read` via `admin_school_student`) but **no** insert/update/delete policy for `authenticated`. A parent can never self‑grant access to a minor — links are written only by the invite‑accept route and `/api/children`.
- A `before insert/update` trigger `enforce_parent_link_sanity()` (SECURITY DEFINER, so it fires even on service‑role writes) rejects links whose child isn't a `student` or whose parent is a `student`.

The migration also adds the parent **read** surface via SECURITY‑DEFINER helpers `is_parent_of(stu)` and `parent_child_in_class(cls)`, and additive `SELECT` policies on `profiles`, `enrollments`, `classes`, `generations`, `generation_shares`, `student_progress`, and `submissions` — each scoped to exactly the caller's linked children. Classmates' and other teachers' data are invisible by construction.

**Direct‑to‑child assignment.** `0018` makes `generation_shares.class_id` nullable and adds a `student_id` column with a `num_nonnulls(class_id, student_id) = 1` check (a share targets a class *or* one student). `shared_to_me()` is redefined so a student sees direct shares, `shared_to_my_child()` gives parents read on those generations, and a tightened write policy `shares_direct_parent_all` lets an owner push a generation **directly to their own linked child** (`is_parent_of(student_id)` AND owns the generation).

### 7.2 My Children — read‑only view

`src/app/dashboard/children/page.tsx` is the parent home: one card per linked child. It loads links (`parent_links` + joined child profile) then, in parallel, the RLS‑scoped `enrollments`, `classes`, `generation_shares`, `generations`, `student_progress`, and `submissions`. `itemsFor(childId)` folds these into two lists per child:

- **School work** — everything shared to the child (directly or via an enrolled class) that the parent did *not* assign. Shows label, source ("from class X"), due date (with overdue styling), status (`not started` / `in_progress` / `completed` / `submitted`), and score (`teacher_score ?? auto_score / max_score`). `lesson_plan` kinds are filtered out.
- **From you** — direct shares where `shared_by === user.id` (the parent's own assigned test papers).

Everything here is strictly read‑only reporting; the parent cannot change a child's schoolwork. When `FEATURE_AI_TUTOR` is on, each `presentation` item also renders a `CoachRecap` and an `AskCoachButton` for that child. The page also exposes a `ResetPasswordButton` per child (hierarchical adult‑resets‑child from the password‑recovery subsystem).

### 7.3 Parent authoring — test papers and (since 0035) everything

**Test Papers page** (`src/app/dashboard/test-papers/page.tsx` + `paper-actions.tsx`) is the parent‑friendly authoring surface: upload the child's textbook (same indexing pipeline as teachers, chapter auto‑detection included), generate a test paper per chapter (`GeneratePaperButton` inserts a `generations` row with `kind: "exam_paper"`, `owner_id = user.id`, `school_id: null`), download the `.docx`, and assign it to a child (`AssignChildButton` inserts a `generation_shares` row with `student_id` set; on `23505` it updates the due date instead). Owner signs their own artifact paths via storage RLS.

**Full authoring (migration `0035_parent_full_author.sql`).** Originally `0018`'s `enforce_parent_generation_kind()` trigger raised on any parent generation that wasn't `exam_paper`. The 2026‑07‑11 product decision made **parents full creators for their own children** — `0035` simply `DROP`s that trigger and function. Because authoring was already ownership‑based at the RLS layer (any adult may own books/generations), lifting the one trigger is the entire server‑side change. Per‑generation **caps still apply** via `effective_cap` keyed on the parent's own entitlement.

Consequently the nav (`app-header.tsx`, `tabsFor`) gives a `parent` the full **Library** and **My Analytics** tabs like any adult, *plus* **My Children** and **Test Papers** when they hold links (`hasChildren`). The Library is where a parent now generates every kind; the Test Papers page remains a simplified exam‑paper‑only surface (note: its in‑file comments still say "the only kind the DB allows parents," which is stale post‑`0035` — the restriction is gone, that page's UI just doesn't expose other kinds).

### 7.4 Assistant grounding on children's books

`src/utils/assistant/scope.ts` resolves the AI Teaching Assistant's in‑scope books via a fallback chain in `inScopeBooks(admin, userId)`:

1. a student's assigned lessons' books (`student_progress → generations.book_id`);
2. else an adult's **own** books (`books.owner_id = userId`, cap 12);
3. else — **the parent fallback** — the books their linked children are studying: read `parent_links` filtered to `parent_id = userId`, take those `child_id`s, and pull the books from the children's `student_progress`.

The `admin` client bypasses RLS, so the explicit `parent_id = userId` filter is the guard that keeps grounding to the parent's *own* children. A parent with no uploaded books can therefore ask the assistant about exactly what their child is studying, and nothing else. `scopeTopics` then bounds answers to those books' chapter/topic metadata (Option‑B grounding).

### 7.5 Acquisition — signup, invites, accept

There are two ways to become a parent:

**Self‑serve signup** (`src/app/signup/page.tsx`). When `NEXT_PUBLIC_FEATURE_PARENT_PORTAL` is on, a third role button "parent" appears (strictly less power than the teacher default). The user signs up with `role: "parent"` in metadata. Such a parent then adds children directly via **`AddChild`** (`children/add-child.tsx`) → **`POST /api/children`** (`src/app/api/children/route.ts`): the route (Node runtime, service role) provisions each child as a synthetic student account (username `first.last`, temp password shown once, `must_reset_password: true`, `school_id: null`, `parent_email` = the parent's email) and inserts a `parent_links` row with `source: "self"` and `verified_at = now()`. A friendly pre‑check reads `effective_cap`/`beta_tester`, but the real limit is the `enforce_beta_child_cap()` trigger; if the link insert is refused, the orphan auth user is deleted so the parent isn't handed dangling credentials. Any non‑student adult may call it (a teacher can also be a parent); students get 403.

**School invite** (`0019_parent_invites.sql`). A school admin uses the Invites page (`dashboard/invites/invite-manager.tsx`): pick role "parent", type the parent's email, and select the child(ren) — students whose `parent_email` matches the typed address float to the top as "suggested". This inserts an `invites` row (role widened to allow `parent` by `0019`) plus `invite_children` rows (siblings = several rows); if the child mapping fails the invite is rolled back to stay atomic‑ish. The public invite page (`invite/[token]/page.tsx`, read with the service role since the token is the secret) lets the invitee authenticate as the invited email (`invite-client.tsx`), then **`GET /invite/[token]/accept`** (`accept/route.ts`) redeems it:

- Validates the invite isn't accepted/expired and the signed‑in email matches.
- **Parenthood is a grant that never downgrades an existing adult role** — a teacher who accepts stays a teacher and gains links. A fresh default‑teacher account with zero books/classes and no `school_id` is flipped to `role: "parent"`. A `student` is rejected (a minor can't become a parent). Parents never receive a `school_id` (that would inherit the school library).
- For each mapped child, it re‑validates (still a student of the inviting school) and upserts a `parent_links` row with `source: "school"`, setting `verified_at` only when the child's `parent_email` matches the invite email.
- Sets `onboarded_at` (the invite identifies them, so they skip the `0038` onboarding gate) and redirects to `/dashboard/children`.

### 7.6 Parent billing

Parents have their own commercial track, separate from schools. Schools pay via **Stripe** (MYR); parents/teachers pay via **Lemon Squeezy** (Merchant of Record, USD) — see `src/utils/stripe/plans.ts`. The parent‑facing product is the **Family** plan (`family_monthly` / `family_annual`, tier `"family"`). Its `roles` allow‑list `FAMILY_ROLES = ["parent","teacher","school_admin","coordinator"]` — a personal/home plan aimed at parents but buyable by any adult. Entitlement gating keys on the plan **tier** on the account owner, and the parent's per‑generation and child caps route through `effective_cap` against the parent's **own** entitlement, not a school's.

---

## 8. AI features (Assistant, Tutor, TAL board, ERE)

SketchCast ships four overlapping "AI teacher" subsystems that evolved in layers. They all share one grounding table (`chapter_grounding`, written by the worker at generation time) and one cross-student answer cache (`tutor_qa`), but differ in surface, model provider, and safety model:

| Subsystem | Surface | Provider | Server flag(s) | State (default) |
|---|---|---|---|---|
| **AI Teaching Assistant** | Floating launcher on every page (all roles) | Provider adapter — Gemini free tier / Anthropic | `FEATURE_AI_ASSISTANT` | OFF; the intended *active* student path |
| **AI Tutor "Ask Coach"** | Per-lesson panel (Pro+ differentiator) | Anthropic (Haiku/Sonnet tiered) | `FEATURE_AI_TUTOR` (+ `…_REQUIRE_PROPLUS`) | OFF by default; ON as the free-trial teaser |
| **TAL persistent board** | Whiteboard inside Ask Coach (ERE engine) | Anthropic via ERE gateway | `FEATURE_AI_TUTOR_TAL` | OFF; degrades to text/clip |
| **Phase-2 standalone canvas** | `board.sketchcast.app` iframe, scoped token | (board app; portal mints token) | `FEATURE_AI_TUTOR_CANVAS` | OFF; app repo not yet built |

All flags default OFF (`src/utils/flags.ts`, `=== "true"`); the server-side flag check is authoritative and the routes 404 when off. Client launchers additionally gate on a build-time `NEXT_PUBLIC_*` twin.

### 8.1 AI Teaching Assistant (the current active student path)

The Assistant is a book-first chat tutor that pivoted from, and is meant to replace, "Ask Coach" as the active student path (the TAL board stays preserved behind its own flag). Unlike the chapter-locked tutor it is available to **every role on every page**.

**Launcher & panel.** `src/app/dashboard/assistant-launcher.tsx` renders a floating bottom-right "🎓 Assistant" button, mounted in both `src/app/dashboard/layout.tsx` and `src/app/console/layout.tsx` so it appears everywhere. The panel (`src/app/dashboard/assistant-panel.tsx`) lazy-mounts on open, fires a warm-start `GET /api/assistant` on mount (greeting + book scope + session id, so the first turn skips setup), then streams turns over SSE.

**Route.** `src/app/api/assistant/route.ts` (`runtime = "nodejs"`). Per POST turn: retrieve in-scope books → topic-score → `decideScope` → branch:
- `no_book` / `off_topic` → deterministic warm decline (no model call, instant, $0, un-jailbreakable) via `declineMessage` / `NO_BOOK_MESSAGE`.
- `in_scope` → answer-cache check (`findCached` on `tutor_qa`; served only on near-exact or verified), else a book-first streamed generation. Every turn is logged with latency + token telemetry.

**Option-B grounding** (`src/utils/assistant/scope.ts`). The student's *in-scope books* are the primary source and the boundary is the **curriculum topics** those books cover — not exact sentences, not the whole library. `inScopeBooks` resolves via a fallback chain: a student's assigned-lesson books → an adult's own uploaded books → (for a parent with none) the books their verified linked children study; capped at 12. `scopeTopics` reads `books.chapters` metadata. Retrieval is pure lexical scoring (`scoreTopics`: content-word overlap with light stemming) so the `in_scope`/`off_topic`/`no_book` decision (`decideScope`) is unit-testable with no DB. A follow-up with no topical words stays on the session's `activeTopic`.

**Provider adapter** (`src/utils/assistant/provider.ts`). Everything outside `providers/*` talks only to the `LLMProvider` interface (streaming text + function calling). `assistantProvider()` selects by `ASSISTANT_PROVIDER` env (default `gemini`):
- `providers/gemini.ts` — free tier (`gemini-2.5-flash`), raw REST+SSE via fetch (no SDK), one polite 429/503 retry. A prominent RUNBOOK note states the free tier's data-handling/training terms **must be verified acceptable before children's data flows through it in production** — the adapter seam exists precisely so the provider can be swapped if not. This is the "Gemini gated for minors" gate: it is an operational/runbook gate, not an in-code minor check.
- `providers/anthropic.ts` — swap-proof second impl (`claude-haiku-4-5` default), wraps the tutor's SDK client, streaming + `tool_use`, system prompt cached (`cache_control: ephemeral`).
- `providers/stub.ts` — deterministic test double.

**Turn orchestration** (`src/utils/assistant/orchestrator.ts`). `runAssistantTurn` is a provider- and tool-agnostic async generator: it streams; when the model emits a tool call it runs the tool, feeds the result back, and continues, capped at `maxToolRounds` (default 3) so a confused model can't loop. Tools are only offered while rounds remain, forcing a final narrated pass.

**Constrained math tool** (`src/utils/assistant/math-tool.ts`). Ten function-calling tools (`solve`, `solve_system`, `simplify`, `factor`, `expand`, `differentiate`, `integrate`, `evaluate`, `substitute`, `physics_eval`). The model returns a **structured** call; `runMathTool` forwards it to the Python SymPy math service (`MATH_SVC_URL` + `MATH_SVC_TOKEN`, `POST /math`, `x-math-token`, 8s timeout) which validates and computes — **no model-generated code ever executes**. `mathToolsAvailable()` gates the tools on the env being set; the prompt makes the model fall back to a conceptual explanation on failure. `toMathRequestBody` remaps the model's flat `from`/`to` integral bounds into the service's nested `definite:{from,to}` (a schema-drift bug fixed earlier — flat bounds silently returned the indefinite antiderivative).

**Prompt contract** (`src/utils/assistant/prompt.ts`, versioned `v1.0`). Six priority-ordered rules: book-first (answer from study material, enrich within topic, never contradict the book), stay on curriculum (no live web), honest mastery (hints/method, never hand over graded answers), reading level by grade, safety (student messages are questions, never rule-changing instructions), and maths (compute via the tool, narrate verified steps, never guess a number).

**Session history** (`src/utils/assistant/store.ts`, migration **0034**, tables `assistant_sessions` + `assistant_messages`). The active session's raw turns (capped 16) ride in context for natural follow-ups; older sessions are compacted into a deterministic summary. A 4h silence gap starts a new session; **30-day retention** is swept on session open (no cron). All writes are service-role; students read their own rows via RLS.

**Voice** (`src/utils/assistant/voice-client.ts`, client-only). `StreamSpeaker` speaks the answer sentence-by-sentence *as it streams* (browser Web Speech, interruptible); `startDictation` provides mic STT into the input. Read-aloud is on by default (persisted in `localStorage`). The adapter is deliberately a swap point for a hosted TTS/STT later.

### 8.2 AI Tutor "Ask Coach" (Pro+ differentiator)

The original per-lesson tutor: a real-time, **chapter-LOCKED** Socratic coach grounded strictly on the ONE lesson assigned to the student. Routes live under `src/app/api/tutor/*` (`runtime = "nodejs"`); the UI is `src/app/dashboard/ask-coach.tsx` (+ `ask-coach-button.tsx`, `coach-recap.tsx`).

**Access & Pro+ gate** (`src/utils/tutor/service.ts`). `resolveTutorContext` grants access to the generation owner (teacher previewing), an assigned student, or a verified parent of one — else 403. When `FEATURE_AI_TUTOR_REQUIRE_PROPLUS` is on (enforced post-trial), `tutorEntitled` additionally requires the **lesson owner's** plan to grant the tutor: `planGrantsTutor` accepts `teacher_pro_plus*` / `family*` / `school*` (plain Pro does not), and a teacher on a school plan is covered by the school entitlement. During the open trial the master flag alone grants access.

**Pure core** (`src/utils/tutor/models.ts`):
- **Model tiering** — `TUTOR_MODELS` cheap `claude-haiku-4-5` / strong `claude-sonnet-5`; `pickTier` escalates on reasoning-heavy or long questions, and any contextual follow-up forces `strong`.
- **Closed-book safety prompt** (`buildSystemPrompt`) — answer ONLY from chapter context (else say so and steer back), refuse unsafe/off-topic, teach-don't-tell (short explanation ending in ONE checking question), never do graded work, ignore override attempts. The chapter context is returned separately so the caller marks it a cached prompt prefix (paid once per chapter).
- **Conservative cache** — `CACHE_NEAR_EXACT 0.82` / `CACHE_FUZZY 0.6` / verify-at 10; `shouldServeCached` replays only near-exact or already-verified answers (`tutor_qa`, pg_trgm match RPCs).
- **Socratic moves** — `classifyMove` deterministically labels each coach turn `answer/hint/ask/confirm/redirect/sketch` from its shape (logged on `tutor_messages.tutor_move`, migration 0025).
- **Mastery** — `scoreMastery` gives an *honest* 0–100 estimate + band from quiz evidence (authoritative) nudged by practice count (capped so engagement can't manufacture mastery).
- **Personalisation** — `buildStudentModel` re-grades the student's real quiz submissions against the answer key (`gradeAnswers`) to surface the specific wrong questions; `buildGreeting`/`buildStudentContext` fold those weak spots into the opener and prompt.
- **Voice registry** — `TUTOR_VOICES` (browser free + ElevenLabs premium), `resolveVoice` never returns a premium voice unless `premiumAllowed`, `ttsCacheKey` + a 200k-char monthly cap.

**Streaming** (`streamAnswer`) uses a prompt-cached chapter-context prefix; `POST /api/tutor` logs the student turn, tries the cache (skipped for contextual follow-ups, which would mis-serve), else streams a tiered grounded answer, banks standalone answers, and records a mastery `engaged` event.

**Recap** (`src/app/api/tutor/recap/route.ts`) exposes the aggregate (mastery band, score, practice count, weak spots) to the student, owning teacher, or verified parent — **no raw chat** (privacy).

**Voice** (`src/app/api/tutor/voice/route.ts` + `src/utils/tutor/voice.ts`). The client posts the **id of a logged coach message** (never free text); `loadOwnCoachMessage` is the safety gate — only a real reply that already passed the closed-book fence can ever be synthesised. Free path → browser speaks ($0); premium → ElevenLabs (`eleven_turbo_v2`), cache-first in the `tutor-voice` bucket, then cap-reserved (`tutor_tts_reserve`), with any failure degrading to the browser voice.

**Sketch / "Draw this"** (Phase 2, flag `FEATURE_AI_TUTOR_SKETCH`). `src/app/api/tutor/sketch/route.ts` + `src/utils/tutor/sketch.ts`: the Coach authors ONE grounded slide spec (strict JSON matching the worker's `SlideVisual` contract) which is enqueued to the batch worker for an animated clip render, cached cross-student by `canonicalSpecHash` (`tutor_sketch` table, `tutor-sketch` bucket), monthly-capped at 200 new renders (`tutor_sketch_reserve`); the panel polls for the finished clip. Stale `processing` rows (dead worker) are re-enqueued so students never poll forever.

### 8.3 TAL persistent board + the ERE engine

The board upgrades Ask Coach from stateless clips to a **teacher at a persistent whiteboard that mutates turn to turn**. The tutor emits TAL (never pixels); the ERE engine validates and applies it; the client is a **pure renderer** of the server's authoritative snapshot.

**The ERE engine** (`sketchcast-ere/`, the 4th repo, `@sketchcast/ere`, `ERE_VERSION 0.2.0`). Framework-agnostic TypeScript with zero runtime deps; the host injects grounding, the model, and persistence. Pipeline: `Student → Tutor(LLM) → AI Gateway → TAL → Engine → Renderer → Canvas` — everything left of TAL is probabilistic, everything right is deterministic and trusts nothing. Pieces:
- **TAL v0** (`src/tal/`) — the Teaching-Action Language: JSON, declarative, addressable. Ops include `speak`, `place`, `draw`, `set_state`, `step`, `highlight`, `arrow`, `label`, `move`, `focus`, `group`, plus interaction ops (`ask`/`expect`/`on_event`/`wait_for_student`) declared in the grammar but no-op/auto-advance in Phase 1. `validateTal` does structural + semantic checks against the scene + library.
- **Scene graph** (`src/scene/graph.ts`) — the board's single source of truth, produced as the **fold of an append-only event log**, which makes replay/undo trivial and renderers pure. Provides `readBack` (what's on the board, for the model), `stateHash` (board-state fingerprint for caching), `toJSON` snapshot, and `resolveTarget` for part paths like `h.right_atrium` / `arr[0]`.
- **Knowledge objects** (`src/ko/`) — part-whole, stateful objects + a `PRIMITIVES` kit + a tiered semantic catalog.
- **Interpreter** (`src/interpreter/`) — `BoardSession.runTurn` + a narration-first scheduler (`StubNarrator`).
- **Renderer** (`src/renderer/svg.ts`) — pure `(graph, events) → svg` with stroke draw-on animation; positions are **logical** (anchors/regions/0–100 grid/flow), never pixels — the key to renderer-agnosticism.
- **Starter library** (`src/library/`) — biology, physics, algorithms; golden SVGs + a `VISUAL_QUALITY_STANDARD.md` gate the render quality.
- **AI Gateway** (`src/gateway/gateway.ts`) — `generateTal` builds the closed-book grounding + KO catalog + TAL grammar prompt, calls a model-agnostic `complete`, extracts a balanced JSON object (preferring one containing `"tal"`), validates, and does exactly **one repair pass** handing back the precise validation errors. It never executes a partially-valid program.

**Vendoring.** The engine is copied into the app at `src/ere/` (imported as `@/ere` — the app's only path alias is `@/* → ./src/*`) so Vercel can build without the engine repo. Canonical source + tests live in `sketchcast-ere/`; the sync (`src/ere/VENDORED.md`) copies `src/` and strips `.js` extensions from relative imports (a known build trap).

**In-app board turn** (`src/app/api/tutor/turn/route.ts`, gated on `FEATURE_AI_TUTOR` **and** `FEATURE_AI_TUTOR_TAL`). Load/create the board (`loadOrCreateBoard`, migration **0029**: `tutor_board` / `tutor_board_event` / `tutor_tal_cache` + RLS) → TAL cache lookup keyed on the pre-turn board hash + normalised question + student-reference hash → on miss, `generateTal` with tier (`cheap` on the first draw, `strong` for board-aware follow-ups) → apply via `BoardSession` → persist the mutated scene + this turn's events → return `{ mode: "board", snapshot, events, narrationText }`. **Any** failure returns `{ mode: "text" }` so the client falls back to the chat stream — the board is an enhancement, never a hard dependency. `anthropicComplete` uses a prompt-cached grammar prefix. `src/app/dashboard/tutor-board.tsx` deserialises the snapshot and animates only the newly-drawn objects (reduced-motion → final state, no animation); `ask-coach.tsx` drives it and shows the spoken narration as the transcript line.

**Phase-2 standalone canvas** (`FEATURE_AI_TUTOR_CANVAS`, requires TAL too). The shared board is meant to run in a separate app at `board.sketchcast.app` inside a sandboxed iframe, which cannot send the portal's Supabase cookie. So:
- The cookie-authenticated portal mints a **scoped HMAC board token** (`src/utils/tutor/board-token.ts`, `src/app/api/tutor/board-token/route.ts`): `{sub, gen, scope:"board"}`, 10-min TTL, `BOARD_TOKEN_SECRET`, self-contained (no DB round-trip). The token is handed to the iframe via `postMessage`; the iframe calls `/api/tutor/turn` cross-origin with `Authorization: Bearer <token>`.
- `resolveCaller` accepts the cookie (same-origin) *or* a board token whose `gen` matches the requested lesson. Crucially, the turn route **still re-runs** `resolveTutorContext` + the Pro+ gate on every request, so a leaked/replayed token can never exceed its `(user, generation)` scope. CORS (`boardCors`) echoes **only** the single allowlisted `BOARD_APP_ORIGIN`, never a wildcard, and uses no credentials.
- **Student events** — `parseStudentEvents` validates untrusted iframe input (only `student.select/point/circle/annotate/answer`, count/size-capped), which is fed into the read-back (so the tutor responds to the referenced object), persisted append-only as `actor:'student'`, and folded into the TAL cache key so a different reference is a different cached answer (migration 0033).

Status note: the board-token mint route, cross-origin auth, CORS, and student-event handling on the portal side are built; the standalone `sketchcast-board` Vite app and the portal `CanvasFrame` iframe integration (tasks P2-C/P2-D/P2-E) are not yet built, so in practice the board runs in-app (Phase 1) when `FEATURE_AI_TUTOR_TAL` is on.

---

## 9. Billing & pricing

SketchCast runs **two payment providers behind one provider-agnostic `entitlements` table**. The app never asks a provider "is this user paid?" at request time — it reads the `entitlements` row that the webhooks write, so the provider split is invisible to every downstream feature gate.

| | Stripe | Lemon Squeezy |
|---|---|---|
| Sells to | **Schools** (card payers only) | **Parents / teachers** (B2C) |
| Currency | **MYR** (hard-gated) | **USD** |
| Role | Direct merchant — Aethel Twin Sdn. Bhd. (Malaysia) | **Merchant of Record** — LS is seller of record, handles global VAT/GST/sales tax, pays Aethel Twin a payout |
| Code | `src/utils/stripe/**` | `src/utils/lemonsqueezy/**` |
| Migration | `supabase/migrations/0022_billing.sql` | `supabase/migrations/0023_billing_lemonsqueezy.sql` |

Note (per `stripe/plans.ts` header): most schools actually pay by **bank transfer against a direct invoice**, entirely outside both providers. The `school_*` Stripe plans exist only for schools that choose to pay by card — schools are never forced through Stripe.

Neither provider ever sees card data touch our servers: both use hosted checkout + hosted billing/customer portals, keeping us out of PCI-DSS scope (`stripe/client.ts`, `lemonsqueezy/client.ts`).

### Plan catalogue

The single source of truth is `PLANS` in `src/utils/stripe/plans.ts`. Each `PlanKey` maps to a `provider`, a `PlanTier`, the roles allowed to buy it, and a **`productEnv`** — the *name* of the env var holding that provider's product id (Stripe Price ID or LS Variant ID). Product ids are never hardcoded; `productIdFor(plan)` resolves them from `process.env` at call time (test/live ids swap without code changes).

Eight plan keys, four tiers:

| Tier | Plan keys | Provider | Roles |
|---|---|---|---|
| `teacher_pro` | `teacher_pro_monthly`, `teacher_pro_annual` | LS | teacher, school_admin, coordinator |
| `teacher_pro_plus` | `teacher_pro_plus_monthly`, `teacher_pro_plus_annual` | LS | teacher, school_admin, coordinator |
| `family` | `family_monthly`, `family_annual` | LS | parent + any adult |
| `school` | `school_annual` (subscription), `school_onetime` (one-off, 365-day licence) | Stripe | school_admin |

- **Free** is not a plan row — it is simply the absence of an active entitlement (the free tier's caps are enforced elsewhere as DB triggers).
- **Founding** is not a separate plan/price — it is Teacher Pro bought with the `FOUNDINGTEACHER` discount ($10/mo, price-locked 24 months). It grants the same access as Teacher Pro but is tracked via `subscriptions.is_founding`. `PlanTier` (not the billing cycle) is what capability gating and the founding cohort key on.
- `assertMyrPrice()` hard-gates the **Stripe path only**: checkout re-retrieves the live Price and refuses anything not in MYR. The LS path is USD by design.
- `planKeyForVariant()` is the reverse lookup the LS webhook trusts: the public pricing page's checkout carries no plan key, so the LS **variant id** on the subscription is the authoritative source of which plan was bought (returns `null` for an unmapped variant, which the webhook alerts on rather than guessing).

### Entitlements model + guards

`entitlements` (migration 0022) is **THE single source of truth for paid access**, keyed **per `(user_id, plan_key)`** — one adult may legitimately hold two concurrent plans (e.g. a school_admin who also buys Family), so a per-user key would let one plan's webhook clobber the other's. `school_id` is the school the *plan* applies to: NULL for personal LS plans, the school for `school_*` plans (which keeps personal purchases invisible to school admins via RLS).

`src/utils/stripe/entitlements.ts`:
- `deriveActive(row, now)` — pure, unit-tested: a row reads active only if `active` is true **and** `current_period_end` hasn't passed, so an expired row reads inactive even before the next webhook lands.
- `getEntitlement(userId)` — the one helper the app gates paid features on; returns the first currently-active plan row.
- `getSchoolEntitlement(schoolId)` — any active `school_*` plan bought for the school.

Guards in `src/utils/stripe/guards.ts` are applied server-side in **every** billing/portal/status route (hiding UI is not enforcement):
- `assertAdultRole(role)` — students can never reach checkout/portal; `coordinator` counts as an adult (multi-role model).
- `assertBillingEnabled(school)` — the global kill-switch (`BILLING_ENABLED` env) **plus** a per-school opt-out (`schools.billing_enabled = false`).
- `assertTenantMatch(a, b)` — cross-tenant guard, null-safe.

The billing **caller** is resolved server-side from the Supabase session (`stripe/caller.ts`) — role and school are read from the DB, never trusted from the request body; it also surfaces `emailVerified` (`user.email_confirmed_at`), which the LS claim flow requires.

RLS on all billing tables (0022) is **read-own, write-nothing**: only the service role (webhook/checkout code) writes. `billing_customers` is owner-only; the money tables additionally let a `school_admin` read rows for their own school (matches only non-null `school_id`, i.e. school plans). `webhook_events` has RLS enabled with **no policies at all** (service-role only).

### API routes

`POST /api/billing/checkout` (`src/app/api/billing/checkout/route.ts`) — guards, validates the plan + role, then **dispatches by provider**: LS plans call `createLsCheckout()` (returns a hosted URL; `custom_data = {user_id, plan_key}` is the passthrough LS echoes on every webhook); school plans go through `stripeCheckout()`, which looks up/creates the Stripe Customer (fail-closed on the mapping), re-checks the live price is MYR, and creates a hosted Checkout Session with an idempotency key. Both return only a hosted URL.

`POST /api/billing/portal` — opens the caller's **own** customer portal; dispatches to the Stripe Billing Portal or a **freshly-fetched** LS customer-portal URL (the pre-signed LS URL expires in 24h, so a cached one is never served). Explicit `provider` wins; otherwise the single one they hold; otherwise prefers LS.

`GET /api/billing/status` — the entitlement read for the signed-in adult. Before reading, if the caller's email is verified it runs `claimLsPurchases()` (see below), so a marketing-page buyer gets access the first time the app checks their status.

### Webhooks + claim-on-login

Both receivers (`src/app/api/webhooks/{stripe,lemonsqueezy}/route.ts`) share a hardened pattern: **Node runtime** (raw body + Node crypto), **signature verification on the raw body**, and an **idempotency ledger** (`webhook_events`). The event id is claimed via a unique-PK insert *before* processing; a true duplicate (prior attempt finished, `processed_at` set) acks 200 without reprocessing, while a claimed-but-unfinished row (a crash) is reprocessed. Handler failure leaves the claim open and returns 500 so the provider retries — every handler is idempotent (upserts on stable keys).

**Stripe** (`stripe/webhook-handlers.ts`): handles `checkout.session.completed`, the `customer.subscription.*` family, `invoice.paid`, `invoice.payment_failed`. Security invariant — `verifiedIdentity()` cross-checks the Stripe customer against the stored `billing_customers` mapping and refuses on mismatch, so a forged/mis-metadata'd object can't unlock someone else. Subscription events **re-fetch the live subscription** from Stripe rather than trusting a possibly out-of-order payload (a stale `updated(active)` arriving after `deleted` must not re-grant). `past_due` keeps access (grace). A one-off school payment (`mode: payment`, MYR-asserted) records a `payments` row and opens a 365-day licence window (`ONETIME_LICENCE_DAYS`).

**Lemon Squeezy** (`lemonsqueezy/handlers.ts` + `webhook.ts`): LS has no persistent event id, so `lsEventKey(name, id, updated_at)` builds a stable idempotency key; `verifyLsSignature()` is HMAC-SHA256 (timing-safe). Two identity origins are handled very differently:
- **Authenticated in-app checkout** sets `custom_data.{user_id, plan_key}` → trusted (signature proves it came from a checkout we created).
- **Public pricing-page purchase** carries no custom_data and the buyer may be logged out, so the only signal is the buyer's LS email — which a buyer can type freely. The webhook therefore **NEVER auto-binds** a paid sub onto a pre-existing account. Instead it **parks the subscription as "unclaimed"** (`user_id` NULL, `claim_email` = LS email) and grants **no** entitlement.

Plan key is derived from the **variant id** (trusted), with `custom_data.plan_key` only a cross-checked fast-path. A **monotonicity gate** (`subscriptions.provider_updated_at`) skips stale out-of-order events (LS has no live re-fetch). `cancelled` keeps access until `ends_at`; founding-cohort detection (`orders.ts`) is best-effort and never blocks the grant.

**Claim-on-login** (`lemonsqueezy/claim.ts`): `claimLsPurchases(userId, verifiedEmail)` — called from `/api/billing/status` when `emailVerified` — binds any parked LS subs whose `claim_email` matches the **Supabase-verified** session email (never a request-body value; exact lower-cased match), then writes the entitlement that grants access. Race-safe (only takes a still-unclaimed row) and never throws (must not break sign-in).

### Public `/pricing` page

Lives in the **landing repo** (static, Cloudflare) at `sketchcast.app/pricing`. `pricing.config.js` is the single source of truth: `pricing.html` renders entirely from `window.SKETCHCAST_PRICING`, so no price or link is written twice. Because it's a static site with no runtime env and the LS URLs are **public hosted-checkout links** anyway, the three checkout URLs live directly in `pricing.config.js` (no secrets in this repo). One product URL serves both monthly and annual — the visitor picks the cycle on LS's page (hence one `checkout` per plan, not per cycle). Copy: teacher plans $24/$49 monthly (annual = ×10), Family $9.99/$99. The **Founding** offer is **code-driven, not a special link** — the CTA opens the plain Teacher Pro checkout and the page shows the copyable `FOUNDINGTEACHER` code. **Schools** never see a public price — CTA is a sales-enquiry mailto only.

### Current state (as of 2026-07-12): open free trial, paid checkout NOT live

- **`billingEnabled()`** (`src/utils/flags.ts`) returns `process.env.BILLING_ENABLED === "true"` — **OFF**. `assertBillingEnabled()` therefore rejects checkout/portal/status with 403 ("Billing isn't enabled yet."). No paid checkout is live; the code is fully built and behind the flag.
- The landing page is in **FREE-TRIAL MODE** (`pricing.config.js` → `trial.enabled: true`, `startsAt: 2026-07-07`, `endsAt: 2026-08-07T23:59:59+08:00`). While active, every paid CTA (Teacher Pro / Pro+ / Family / Founding) **bypasses Lemon Squeezy and routes to the app signup** (`app.sketchcast.app/signup`) for a free month, with a live countdown banner. After `endsAt` — or `enabled:false` — the page auto-reverts to real paid checkout with **no redeploy** (`pricing.html` computes `trialActive` client-side from `endsAt`).
- LS keys are gated too: `lemonSqueezyConfigured()` requires `LEMONSQUEEZY_API_KEY` + `STORE_ID` + `WEBHOOK_SECRET`; the checkout route returns a clean "not available yet" (503) if LS isn't set up.
- The trial's in-app limits (1 book, etc.) are enforced **server-side** independently of any of this billing machinery.

Tests: `src/utils/stripe/__tests__/billing.test.ts` and `src/utils/lemonsqueezy/__tests__/lemonsqueezy.test.ts`.

---

## 10. Support agent, issues & autofix

Three subsystems share one spine — the **`platform_issues`** table (introduced by the console in `0014`, extended for content-linked support by `0020`). Everything a user or the worker reports becomes an issue row; a Sonnet-5 **support agent** diagnoses and (safely) self-heals content problems; and a newer **autofix** pipeline lets the founder turn a reported issue into a merged *code* fix, approved from an email link. The chain is: **intake → `platform_issues` → support agent (data-plane fix) → optional autofix (code-plane fix)**.

### 10.1 Issue intake — three doors, one table

All three write `public.platform_issues` (service-role or RLS-scoped inserts); none of them trust client-supplied context.

**a) General tech reports — `POST /api/issues`** (`sketchcast-app/src/app/api/issues/route.ts`)
In-portal "report a problem" for any signed-in role. Gated by `platformConsoleEnabled()` (`FEATURE_PLATFORM_CONSOLE`). It **saves first, emails second** so a Resend failure never loses a report. Category is whitelisted (`video|deck_docs|quiz|upload|login|speed|other`); title/description are length-clamped; context (role, school, user-agent, and the caller's own recent failed-job errors) is derived **server-side** via RLS-scoped reads, never taken from the body. Two abuse guards: **data-minimization for minors** (students get `description = null` and no job-error context) and a **rate limit** of `MAX_OPEN_PER_USER = 5` open reports. On success it fires a founder email (`FEEDBACK_EMAIL_TO`, retried once) with a `/console/issues/{id}` deep-link. `GET` returns the caller's own last 10 (RLS-scoped).

**b) Per-lesson reports — `POST /api/support`** (`sketchcast-app/src/app/api/support/route.ts`)
"Report an issue" on a specific generation. Gated by `supportAgentEnabled()` (`FEATURE_SUPPORT_AGENT`). **Ownership is the tenant gate**: the generation is looked up with `.eq("owner_id", user.id)` — reporting someone else's content 404s, so the agent can only ever be pointed at the reporter's own data (the worker re-checks independently, §10.2). Students are refused (403). It **dedupes** an existing open manual report for the same generation instead of farming another paid diagnosis, caps reports at 5/reporter/hour, then inserts the issue (`trigger_source: "manual"`) and queues a `support_diagnose` job via the **admin client** (jobs inserts are service-role-only by design). `GET?id=` polls the reporter's own issue (status, `agent_action`, user-safe `diagnosis.user_message`, `resolution_note`).

**c) Worker auto-file on failure — `_auto_file_support_issue`** (`sketchcast/worker/run.py`)
When a generation job throws, `run_once`'s except-block calls this (only when `SUPPORT_AGENT_ENABLED` is set on Railway, and never for `support_diagnose`/`index_book` jobs — no recursion). It files a `trigger_source: "auto"`, `category: "generation_failed"` issue for the content **owner**, records the `job_id` and truncated error, then queues a `support_diagnose` job. It is idempotent (skips if an open auto-issue already covers that generation) and wrapped so it can never break the failure path.

Migration **`0020_support_agent.sql`** adds the linking columns (`book_id`, `generation_id`, `job_id`, `trigger_source`, `diagnosis` jsonb, `agent_action`), widens the category CHECK, adds `jobs.issue_id`, and — as an adversarial-review fix — closes a cross-tenant hole by adding `can_use_book()` and tightening the `gen_write` RLS policy so a generation can't reference a foreign `book_id`.

### 10.2 The Sonnet-5 support agent (worker, `sketchcast/support_agent/`)

`worker/run.py` claims `support_diagnose` jobs **before** batch lessons (a reporter is watching the status), then dispatches to `support_agent.agent.run_support_job`. The module's contract (`support_agent/__init__.py`) is: tenant-scoped reads only, no silent student-facing changes, a hard loop cap, and full audit.

**Flow (`agent.py`):** load issue → `assemble_bundle` → Sonnet-5 `diagnose` → one guarded action → update the issue with **user-safe fields only** → write staff detail to `platform_audit_log` → notify the owner when something changed. Spend is attributed in a `finally` even on crashes; an internal failure **escalates honestly** (`status: triaged`, `agent_action: escalated`) rather than faking a fix.

- **Bundle / scope (`bundle.py`):** every read is keyed to the issue's own `generation_id`/`book_id`. `assert_scope` proves the reporter may see **both** the generation *and* the book **independently** (owner, or `school_admin` of the owner's school) — it deliberately never OR-collapses, which would hand the service-role worker a cross-tenant primitive; a `ScopeViolation` refuses the run loudly. The bundle carries generation/book metadata, detected chapters, recent job errors, an `assigned_to_students` flag, and best-effort **source-slice** and **artifact** text (docx/pptx extraction) for wrong-content diagnosis.
- **Diagnose (`diagnose.py`, `DIAGNOSIS_MODEL = "claude-sonnet-5"`):** one structured JSON call over the bundle, classified into a fixed `CATEGORIES`/`ACTIONS` vocabulary (unknown values are coerced to `escalate`). It first **re-runs the chapter-validation gate** (`verify_chapter_content`) on source vs. artifact as concrete `gate_signals`; a **ground-truth override** routes to `reindex_regenerate` at ≥0.85 confidence when the source slice concretely mismatches its title but the artifact is fine — not leaving the deterministic fix to model timidity.
- **Actions (`actions.py`) — guards are hard code, not prompts:**
  - `retry_transient` — requeues only if the generation is actually `error`, **nothing is assigned** to students (re-running overwrites the deterministic storage path), and under `MAX_TRANSIENT_RETRIES = 2`.
  - `reindex_regenerate` — the wrong-chapter fix. Requires `confidence ≥ 0.75` and `_regen_count < MAX_REGENS = 2` per book (counted from immutable `platform_issues` rows so the cap can't be reset). Re-indexes, **verifies** the requested chapter now reads as its title (rolling the book split back if not), then writes a **new** generation row cross-linked to the old one. It **never** touches `generation_shares`: if content is assigned it lands as a `regenerated_pending` item the adult re-assigns; the old artifact is never deleted.
  - `user_fix` — resolves with an actionable message (e.g. valid chapter range, "upload a clearer scan").
  - `escalate` — `status: triaged` + a Resend staff email (`notify_staff`) with a console deep-link; `notify_owner` emails the content owner on a successful fix (both best-effort, skipping student `@students.sketchcast.app` addresses).

**Console surfacing:** `/console/issues` (`page.tsx`) is the triage queue (status filters, active-first); `/console/issues/[id]/page.tsx` shows full context plus an "AI diagnosis" card (root cause, confidence, action taken, user-facing message) with an "auto-triggered" badge — and points staff to the **Audit tab** for the staff-only reasoning/gate signals. `triage-form.tsx` drives manual lifecycle changes.

### 10.3 Autofix — reported issue → merged code fix (flag `FEATURE_AUTOFIX`, OFF)

The newest layer (docs: `sketchcast-app/docs/AUTOFIX.md`) closes the loop from a diagnosis to an actual code change, with the founder's email tap as the only release control. **Kill switch:** `autofixEnabled()` (`FEATURE_AUTOFIX`); when off, every `/api/autofix/*` route 404s and the console button hides. It is **flag OFF / dormant** — it needs migration `0039` plus the GitHub token/secrets before it does anything.

**The loop:**
1. **Dispatch — `POST /api/autofix/dispatch`** (staff-only via `isPlatformAdminRequest()`, else 404). Enforces one active run per issue and a `DAILY_CAP = 20`, inserts an `autofix_runs` row (`status: dispatched`, random `run_key`, `branch: autofix/<key>`), and fires a GitHub `repository_dispatch(autofix)` with a **PII-sanitised brief** (emails/UUIDs/long numbers scrubbed — the repo and its Action logs are public). If `GITHUB_AUTOFIX_TOKEN` is unset the run is recorded but the workflow won't start, and the button says so.
2. **Fix workflow — `.github/workflows/autofix.yml`.** Checks out `main`, cuts the branch, runs **Claude Code** (`anthropics/claude-code-base-action@beta`) with a prompt that reads `AGENTS.md`, makes the *smallest* fix, adds a Vitest test, and avoids auth/billing/migrations unless essential. Then the **quality gates** (`tsc --noEmit`, `eslint`, `vitest run`) set `ci_passed`; a diff step flags **sensitive** paths (`auth|billing|middleware|supabase/migrations|stripe|lemonsqueezy|rls`); it commits, pushes, and **opens a PR (never merges)**, then calls back the app.
3. **Callback — `POST /api/autofix/pr-opened`.** Authenticated by the shared `AUTOFIX_CALLBACK_SECRET` (constant-time compare). Updates the run (`pr_open` or `ci_failed`, PR number/url, `ci_passed`, `sensitive`, summary) and is the **only** place the signed Approve/Reject links are minted (`signDecisionToken`, `src/utils/autofix/token.ts`: HMAC-SHA256, `scope:"autofix"`, 7-day TTL). **The Approve link is withheld entirely when CI is red.** Emails the founder via Resend (`src/utils/autofix/email.ts`).
4. **Decide — `/api/autofix/decide`.** The token *is* the auth (no session). To survive email-scanner **prefetch**, `GET` only renders a confirmation page and never mutates; the real merge/close happens on the **`POST`** form submit. `POST` claims the decision atomically (`update … .is("decided_at", null)`) for true **single-use**. Approve **re-checks CI + PR** (defense in depth) then squash-merges to `main` via `src/utils/autofix/github.ts` → Vercel deploys and the issue is marked `resolved`; a merge conflict un-claims the run so it can be retried. Reject closes the PR, deletes the branch, and sets the issue back to `triaged`. Every branch is audited to `platform_audit_log`.

**Migration `0039_autofix.sql`** creates `autofix_runs` (status enum `dispatched|pr_open|ci_failed|approved|merged|rejected|error`, unique `run_key`, `decided_at` as the single-use guard, `sensitive`/`ci_passed`/`files_changed`), RLS-enabled with **no policies** → service-role only, plus the shared `touch_updated_at` trigger.

**Safety summary:** PR-only (no auto-merge), green-CI gate (Approve refuses a red PR), HMAC-signed single-use links (7-day expiry), GET-confirm/POST-act against prefetch, sensitive-diff flagging, PII-scrubbed public dispatch, a least-privilege repo-scoped GitHub PAT, and the `FEATURE_AUTOFIX` kill switch. The console UI is `src/app/console/issues/[id]/autofix-panel.tsx` (client-gated by `NEXT_PUBLIC_FEATURE_AUTOFIX`, shows run status and hides the button while a run is active).

**Feature-flag status (2026-07-12):** `FEATURE_SUPPORT_AGENT` / `SUPPORT_AGENT_ENABLED` — merged & live in prod (per memory). `FEATURE_AUTOFIX` — **OFF**; the code is shipped but dormant pending migration `0039`, GitHub Actions enablement, the fine-grained PAT, and the `AUTOFIX_TOKEN_SECRET` / `AUTOFIX_CALLBACK_SECRET` secrets described in `docs/AUTOFIX.md`.

---

## 11. Platform console (admin)

The **platform console** at `/console` is SketchCast's internal staff cockpit — the founder's single answer to "how is the platform doing, what is it costing, what's broken, and who do I need to act on?" It is deliberately separate from the school-facing app: its own dark chrome, its own access model, and its own audit trail. Everything it reads and writes goes through the Supabase **service role** (`createAdminClient()`), so it sees across every tenant while the normal RLS boundaries protect ordinary users.

Everything below lives in the app repo (`sketchcast-app`, Next.js/Vercel, `main`). Schema is `supabase/migrations/0014_platform_console.sql`; the ops columns it depends on arrive in later migrations (0015/0016).

### 11.1 Who is staff — the two-tier access model

Platform staff is **not a `user_role`**. A staff member keeps their normal school-side identity (teacher, parent, whatever) and is *additionally* granted console access — the same "grant, don't mutate the enum" doctrine used for coordinators. There are two sources of staff, unioned:

1. **Founder allowlist** — `FOUNDER_EMAILS` (env, comma-separated, lower-cased), defaulting to `muqtadar.quraishi@sketchcast.app`. This is the bootstrap superset: founders exist even on a fresh database with no grant rows, and only founders can mint or revoke other staff.
2. **`platform_admins` grants** — unrevoked rows in the membership table (migration 0014). Soft-revoke (`revoked_at`) preserves audit continuity.

All of this is centralized in `src/utils/platform-admin.ts`:

- `founderEmails()` — parses the env allowlist.
- `platformAdminUser()` (private) — the core check: returns `{ id, email }` if the signed-in user is a founder **or** has an unrevoked `platform_admins` row, else `null`. It **short-circuits to `null` when `FEATURE_PLATFORM_CONSOLE` is off**, so the entire surface stays dark until the flag is flipped.
- `requirePlatformAdmin()` — **page guard**. On non-staff it `redirect("/dashboard")` — a bounce that is indistinguishable from a route that doesn't exist. Used by the console layout and by the sensitive detail pages (user detail, view-as) that also need the founder identity.
- `isPlatformAdminRequest()` — **API-route guard**. Returns the staff user or `null`; every `/api/console/*` handler calls this itself and responds **404 (not 403)** on `null`.

**404-not-403 is a deliberate design choice**: a 403 confirms the console exists and is worth attacking. A 404 leaves the whole subsystem unprobeable. The same principle drives the page redirect (bounce, don't error). A load-bearing subtlety, called out in comments in both the layout and the routes: **Next.js layouts do not guard route handlers.** `ConsoleLayout` guarding the pages does *nothing* for `/api/console/ops` — so each route re-checks with `isPlatformAdminRequest()` independently.

### 11.2 The shell

`src/app/console/layout.tsx` is the staff-only shell. It calls `requirePlatformAdmin()` (bouncing everyone else), then renders `ConsoleHeader` + children + the AI `AssistantLauncher`. `console-header.tsx` is a deliberately distinct **dark band** (`#14181F`) so a founder with two tabs open never confuses "the console" with "the app," plus the tab strip and an `{email} · staff` marker.

Tabs (`console-header.tsx`): **Overview · Issues · Users · Schools · Content · Feedback · Audit**.

### 11.3 Surfaces

All pages are `dynamic = "force-dynamic"` server components reading via the service role.

| Tab | File | What it shows |
|---|---|---|
| **Overview** | `console/page.tsx` | KPI tiles (schools, teachers, students, admins, 7-day signups, books, **job failure rate**, **Claude spend 30d**), a signup→upload→generate→view→feedback **beta funnel**, generations-by-kind×status, and a deduped-by-message **recent job errors** panel. Spend comes from `jobs.usage.cost_usd` (migration 0013); if that column is missing the query degrades to a usage-less select rather than dropping the whole panel. |
| **Issues** | `console/issues/page.tsx` + `[id]/page.tsx` | Triage queue over `platform_issues` (user-reported + support-agent-auto-filed), status-filterable (active/open/in-progress/resolved/all), severity-flagged. Detail page shows full captured context (URL, user-agent, recent job errors), the AI diagnosis block (support-agent columns, migration 0020), the auto-fix panel (migration 0039), and a **triage form**. |
| **Users** | `console/users/page.tsx` + `[id]/page.tsx` | Roster (≤500, searchable across name/username/email/role/school; emails fetched from `auth.users` via the admin auth API). Row → account detail: facts, activity counts, their books, their issue reports, the staff-action trail on that account, and the **ops panel**. |
| **Schools** | `console/schools/page.tsx` | Per-school rollup — teachers/students/classes/lessons-done/open-issues — plus a count of independent (school-less) adult accounts. |
| **Content** | `console/content/page.tsx` | Every book + generation across the platform (≤200 each, searchable), including taken-down ones, each with a takedown/restore button. |
| **Feedback** | `console/feedback/page.tsx` | Beta feedback (`beta_feedback`) — average ratings, 5-bucket distributions, and full submissions. (Moved here from `/dashboard/beta-feedback`, which now redirects.) |
| **Audit** | `console/audit/page.tsx` | The `platform_audit_log`, newest first (≤200), append-only. |

**View-as lens** (`console/users/[id]/view/page.tsx`): a **read-only** rendering of a target's world through the service role — books/lessons/classes/grading-backlog for adults, classes/assigned-work-with-scores for students (never submission bodies). It is explicitly **not** a session swap: nothing is interactive, so staff cannot mutate anything "as" the user. Every open writes a `view_as` audit row (same DPDP posture as the school-analytics access log).

### 11.4 Ops controls

Write actions all funnel through **`POST /api/console/ops`** (`src/app/api/console/ops/route.ts`), driven by client components `ops-controls.tsx` (suspend/caps/staff) and `takedown-button.tsx` (content). The route guards with `isPlatformAdminRequest()` (404 on failure) and audits **every** action.

- **suspend / unsuspend** — sets `profiles.suspended_at` (the RLS cutoff that severs live tokens' data access) *and* applies a Supabase auth ban (`ban_duration` 87600h ≈ 10y / `none`, which blocks new logins). Reversible; deletes nothing. **Footgun guards:** you cannot suspend yourself, and you cannot suspend another staff/founder account ("revoke that first"). If the RLS update succeeds but the auth-ban call throws, it audits the partial state and returns a `warning` rather than pretending success.
- **set_caps** — per-user overrides of `max_books / max_chapters / max_students / max_children` (the beta/parent caps from migrations 0011/0016). Values validated to integer 0–100000 or `null` (= revert to default). Lowering a cap only blocks *new* items — it never deletes.
- **takedown / restore** — soft-deletes a book or generation by stamping `removed_at` / `removed_by`. Content is hidden and frozen for all school-side users but **never destroyed**; fully recoverable.
- **admin_grant / admin_revoke** — `platform_admins` membership, **founders only** (this branch returns **403**, not 404 — the caller is already confirmed staff, so probeability isn't a concern; staff simply cannot mint staff).

**Graceful degradation is a theme.** The ops columns land in later migrations, so the UI checks readiness before offering controls: `ops-controls.tsx` shows a "run migrations 0015/0016" notice instead of failing when `suspended_at`/`max_books` are absent; the content page hides takedown until `removed_at` exists; and detail pages `select("*")` so missing columns degrade rather than throw.

### 11.5 The audit log

`platform_audit_log` (migration 0014) is the append-only spine: `actor_id`, `action` (`issue_status` | `suspend` | `cap_override` | `takedown` | `view_as` | `admin_grant` | …), `target_kind`, `target_id`, and a `detail` jsonb (before/after snapshots for reversible changes; the reporter-invisible resolution note; support-agent reasoning under a `support_agent:` prefix). Both `/api/console/ops` and `/api/console/issues` write here on every mutation, and read-only view-as opens are logged too.

### 11.6 Schema & RLS posture (migration 0014)

Three tables, all **deny-by-default**:

- **`platform_admins`** — membership (`user_id` PK → profiles, `granted_by`, `note`, `revoked_at`). RLS enabled with **no policies** + `revoke all from anon, authenticated` → service-role only. A `SECURITY DEFINER` `is_platform_admin(uid)` helper exists for any DB-side check.
- **`platform_audit_log`** — service-role-only writes (no policies), indexed on `(created_at desc)` and `(target_kind, target_id)`.
- **`platform_issues`** — reporters may **insert** and **read their own** rows (`reporter_id = auth.uid()`); there are deliberately **no UPDATE/DELETE policies** and `revoke update, delete` is applied, so the entire lifecycle (triage/resolve) is service-role-only through `PATCH /api/console/issues`. Includes a snapshot `reporter_role`, category/severity/status CHECK constraints, a `context` jsonb, and a `touch_updated_at` trigger.

The migration is idempotent and meant to be run as one execution in the Supabase SQL editor.

### 11.7 Feature flag

`FEATURE_PLATFORM_CONSOLE` (via `platformConsoleEnabled()` in `src/utils/flags.ts`) gates the whole surface — and because `platformAdminUser()` returns `null` when it's off, even a founder gets bounced/404'd while it's dark. This lets `/console` and in-portal issue reporting ship to prod but stay invisible until migration 0014 is applied and the flag is set to exactly `"true"`. Access is *always* additionally gated per-request by `requirePlatformAdmin()` / `isPlatformAdminRequest()`, so the flag is a kill switch, not the security boundary.

---

## 12. Config, security, QA & operations

This section documents how SketchCast is configured, kept safe, tested, and run: the complete feature-flag surface and its current production state, the secrets inventory (and where each value lives), the security model, the isolated local-dev platform plus the "test local before prod" release discipline, and the known operational caveats/roadmap.

### 12.1 Feature flags

All server flags live in `sketchcast-app/src/utils/flags.ts`. The convention is strict: **default OFF**, and a flag is on only when its env var equals the exact string `"true"`. Every flag that touches a client surface has a matching `NEXT_PUBLIC_*` twin — the public var gates whether the button/panel renders in the browser bundle, but the **server-side `FEATURE_*` check in `flags.ts` (or the route handler) is always authoritative**. Where a flag also has a DB guard (a trigger or a `revoke`), that guard holds regardless of the flag, so flipping a flag can never bypass a data-layer invariant.

| Flag (server) | Client twin | Helper | Purpose | Prod (2026-07-12) |
|---|---|---|---|---|
| `FEATURE_SCHOOL_ANALYTICS` | — | `schoolAnalyticsEnabled()` | Admin/Principal/Coordinator oversight nav + surfaces (needs migration 0009) | **ON** |
| `FEATURE_TEACHER_BETA` | — | `teacherBetaEnabled()` | Capped teacher-beta UI (caps are DB triggers off `profiles.beta_tester`, migration 0011, so they hold regardless) | OFF |
| `FEATURE_PLATFORM_CONSOLE` | — | `platformConsoleEnabled()` | `/console` staff surface + in-portal issue reporting (needs migration 0014) | **ON** |
| `FEATURE_PARENT_PORTAL` | `NEXT_PUBLIC_FEATURE_PARENT_PORTAL` | `parentPortalEnabled()` | Parent role, children links, test papers, invites | **ON** |
| `FEATURE_SUPPORT_AGENT` | `NEXT_PUBLIC_FEATURE_SUPPORT_AGENT` | `supportAgentEnabled()` | "Report an issue" + AI diagnosis of failed jobs (worker side additionally gated by `SUPPORT_AGENT_ENABLED` on Railway) | **ON** |
| `BILLING_ENABLED` | — | `billingEnabled()` | Stripe/LS billing master switch (`src/utils/stripe/guards.ts` enforces server-side) | OFF |
| `FEATURE_AI_TUTOR` | `NEXT_PUBLIC_FEATURE_AI_TUTOR` | `aiTutorEnabled()` | "Ask Coach" tutor | OFF (superseded — see below) |
| `FEATURE_AI_TUTOR_REQUIRE_PROPLUS` | — | `aiTutorRequireProPlus()` | Gate Ask Coach to the `teacher_pro_plus`/family/school entitlement (OFF during open trial) | OFF |
| `FEATURE_AI_TUTOR_SKETCH` | `NEXT_PUBLIC_FEATURE_AI_TUTOR_SKETCH` | `aiTutorSketchEnabled()` | Phase-2 "Draw this" whiteboard clip (needs migration 0028 + sketch worker) | OFF |
| `FEATURE_AI_TUTOR_TAL` | `NEXT_PUBLIC_FEATURE_AI_TUTOR_TAL` | `aiTutorTalEnabled()` | Persistent TAL/ERE teaching board (migration 0029); preserved but off post-pivot | OFF |
| `FEATURE_AI_TUTOR_CANVAS` | `NEXT_PUBLIC_FEATURE_AI_TUTOR_CANVAS` | `aiTutorCanvasEnabled()` | Phase-2 standalone canvas app + scoped board-token/Bearer path (needs `FEATURE_AI_TUTOR_TAL` too) | OFF |
| `FEATURE_AI_ASSISTANT` | `NEXT_PUBLIC_FEATURE_AI_ASSISTANT` | `aiAssistantEnabled()` | Book-first voice chat tutor that **replaces** Ask Coach as the active student path (migration 0034) | **ON** (active tutor path) |
| `FEATURE_ONBOARDING` | — | `onboardingEnabled()` | Blocking new-joiner Teacher/Parent confirmation before app use (migration 0038) | **ON** (verified 2026-07-12) |
| `FEATURE_AUTOFIX` | `NEXT_PUBLIC_FEATURE_AUTOFIX` | `autofixEnabled()` | Automated bug-fix pipeline; a **kill switch** — `/api/autofix/*` 404s when off (migration 0039) | OFF |

Two client flags live **outside** `flags.ts` and are read directly from `process.env` in the component:
- `NEXT_PUBLIC_FEATURE_TOUR` — the driver.js onboarding tour (`src/tour/TourProvider.tsx`). **ON** in prod (user set it 2026-07-12).
- `NEXT_PUBLIC_ELEVENLABS_ENABLED` — a display-only toggle in the app that shows premium-voice options; actual synthesis is gated by the worker's `ELEVENLABS_ENABLED`. **OFF**.

**Tutor-family caveat:** the AI-tutor lineage (`FEATURE_AI_TUTOR*`) was superseded by the AI Teaching Assistant pivot. The current `flags.ts` comment on `aiAssistantEnabled()` states the Assistant "replaces Ask Coach as the active student path (the TAL board stays preserved behind `FEATURE_AI_TUTOR_TAL`, off)." Because flag values are operator-set env vars in Vercel, the tutor-family on/off states above are the reconciled intent — confirm the live values in the Vercel project if operating this subsystem.

### 12.2 Secrets & env-var inventory (and where each lives)

Three deployment targets hold secrets: **Vercel** (the Next.js app), **Railway** (the Python worker + the SymPy `mathsvc` second service), and **GitHub Actions secrets** (autofix only). Canonical templates: `sketchcast-app/.env.example` (Vercel) and `sketchcast/worker/.env.example` (Railway). Nothing real is committed.

| Subsystem | Variables | Lives in |
|---|---|---|
| **Supabase** | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (public); `SUPABASE_SERVICE_ROLE_KEY` (server-only) | Vercel. Worker/mathsvc use `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` on Railway |
| **Email (Resend)** | `RESEND_API_KEY`, `FEEDBACK_EMAIL_TO`, `FOUNDER_EMAILS` (also drives the staff allowlist, §12.3) | Vercel |
| **LLM (Anthropic / Gemini)** | `ANTHROPIC_API_KEY` | Railway worker (generation + support diagnosis); GitHub Actions secret (autofix). The app's Assistant/tutor also needs an LLM provider key at runtime (per `docs/qa/LOCAL-DEV.md`), though it is **not declared in the app `.env.example`** — a gap to close |
| **ElevenLabs (premium TTS)** | app: `NEXT_PUBLIC_ELEVENLABS_ENABLED` (display only). worker: `ELEVENLABS_ENABLED`, `ELEVENLABS_API_KEY`, optional `ELEVENLABS_CHAR_CAP`, `ELEVENLABS_USD_PER_1K_CHARS` | Vercel (toggle) / Railway (actual synthesis + cost caps) |
| **Stripe (schools, MYR)** | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_SCHOOL_ANNUAL`, `STRIPE_PRICE_SCHOOL_ONETIME`; plus `BILLING_ENABLED`, `APP_URL` | Vercel |
| **Lemon Squeezy (parents/teachers, USD, MoR)** | `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_WEBHOOK_SECRET`, and six `LEMONSQUEEZY_VARIANT_*` ids (product×cycle; the webhook maps `variant_id`→`plan_key`) | Vercel |
| **Board token (Phase-2 canvas)** | `BOARD_TOKEN_SECRET` (≥16 chars), `NEXT_PUBLIC_BOARD_URL`, `BOARD_APP_ORIGIN` (CORS override) | Vercel |
| **Autofix / GitHub** | `GITHUB_AUTOFIX_TOKEN` (fine-grained PAT), `GITHUB_AUTOFIX_OWNER`, `AUTOFIX_TOKEN_SECRET`, `AUTOFIX_CALLBACK_SECRET` | Vercel. **GitHub Actions secrets:** `ANTHROPIC_API_KEY`, `AUTOFIX_CALLBACK_SECRET` (same value as Vercel), `AUTOFIX_APP_URL` |
| **Worker misc** | `WORKER_POLL_SECONDS` (default 5), `DEBUG_VIDEO`, `SUPPORT_AGENT_ENABLED` | Railway |

The single most sensitive value is `SUPABASE_SERVICE_ROLE_KEY` — it bypasses RLS and is present on every server target (Vercel server runtime, Railway worker, Railway mathsvc). It is never exposed to the browser (only the `anon` key is `NEXT_PUBLIC_*`).

### 12.3 Security model

**RLS as the primary boundary.** Tenant/role isolation is enforced in Postgres by Row-Level Security defined across the migrations, not in application code. The browser talks to Supabase with the `anon` key plus the user's cookie session, so every read/write is RLS-scoped to the caller's tenant, school slice, and role. `supabase/config.toml` leaves `auto_expose_new_tables` unset, so newly created tables are **not** auto-exposed to the Data API roles unless a migration grants them.

**Service-role writes.** Privileged writes go through the server-only service-role client (`@/utils/supabase/admin`), which bypasses RLS: provisioning, webhook handlers, console ops, the onboarding role write (`/api/onboarding`), and all tutor/assistant internals. The `profiles` table is the sharpest example — `role` and `school_id` are service-role-only columns; `authenticated` may update **only** `full_name, username, parent_email, must_reset_password` (enforced by column-level `GRANT` + trigger). `supabase/seed.sql` re-applies these lockdowns locally so local dev matches prod.

**Signed HMAC tokens** (both self-contained `b64url(payload).b64url(hmac)`, SHA-256, constant-time `timingSafeEqual` verify, never throw on malformed input, and re-check authorization server-side so a leaked token can't exceed its scope):
- `src/utils/tutor/board-token.ts` — scoped to `(sub=userId, gen=generationId)`, **10-min TTL**, for the cross-origin canvas iframe's `Authorization: Bearer` call to `/api/tutor/turn`. The turn route still re-runs `resolveTutorContext` + the Pro+ gate, so the token only works while access actually holds.
- `src/utils/autofix/token.ts` — the email Approve/Reject decision links, scoped to `(run, action)`, **7-day TTL**, made truly single-use by the `autofix_runs.decided_at` column.

**Staff gate** (`src/utils/platform-admin.ts`). Platform staff = the `FOUNDER_EMAILS` allowlist ∪ unrevoked `platform_admins` rows (migration 0014) — not a `user_role`. `requirePlatformAdmin()` (page guard) redirects non-staff to `/dashboard` (indistinguishable from a missing page); `isPlatformAdminRequest()` (API guard) returns the user or null, and callers respond **404, not 403**, so the console's existence isn't probeable. Layouts don't protect route handlers — every `/api/console/*` route self-checks.

**Other guards.** Webhook authenticity is verified per provider (`STRIPE_WEBHOOK_SECRET`, `LEMONSQUEEZY_WEBHOOK_SECRET`, and the autofix Action's `AUTOFIX_CALLBACK_SECRET`). Hierarchical password resets are scope-checked in `src/utils/reset-scope.ts` (`decideReset` returns 403 when the caller doesn't teach/parent the target — no cross-tenant reset). **No PII to the public Action:** autofix dispatches only the user-safe, id/email-scrubbed diagnosis to the (public) GitHub Action, flags any diff touching `auth/billing/migrations/middleware/stripe` as "⚠️ sensitive," and requires a human email approval + green CI before any merge to prod. The autofix GitHub token is least-privilege (fine-grained PAT scoped to the one repo).

### 12.4 Local isolated dev platform + release rule

A fully offline copy of the portal runs against a **local Supabase Docker stack** (Postgres + Auth + Storage + Studio), so nothing is tested against prod. Documented in `docs/qa/LOCAL-DEV.md`.

- **`supabase/config.toml`** — `project_id = "sketchcast"`, API `54321` / db `54322` / Studio `54323` / Inbucket local email `54324`; storage `file_size_limit = 200MiB` (large scanned PDFs); `auth.enable_confirmations = false` and `site_url = http://127.0.0.1:3000`; `analytics.enabled = false` (the Logflare/Vector container is unhealthy on Windows and its failure would roll back `supabase start`).
- **Bring-up:** `npx supabase start` applies every migration `0001→0038` + storage buckets, then runs `supabase/seed.sql`, which replicates Supabase Cloud's default grants and re-applies the security lockdowns (needed because the local CLI otherwise leaves migration-created tables with zero grants).
- **`supabase/seed_demo.mjs`** — seeds a self-contained demo world (Demo Primary School; principal, 2 teachers, 1 parent, 2 students; class 5A; a ready book with `chapter_grounding`; one "done" presentation with **row-only** artifacts + per-student progress). It reads `.env.development.local` (**never** `.env.local`) and **hard-refuses any non-local URL** (regex on `127.0.0.1|localhost|0.0.0.0`), is idempotent, and sets every demo password to `sketchcast` (students sign in with the bare id `demo.s1`/`demo.s2`). `.env.development.local` is loaded ahead of `.env.local`, so `npm run dev` talks to local Supabase while the prod `.env.local` stays intact for diagnostics.
- **npm scripts:** `db:start`, `db:seed`, `db:bootstrap` (start + seed), `db:reset` (wipe + re-migrate + re-seed), `db:status`, `db:stop`.
- **Launch config:** the workspace-root `.claude/launch.json` defines the preview servers the browser tooling starts by name — `web` = `npm --prefix sketchcast-app run dev` (`:3000`) and `landing` = `npx serve sketchcast-landing` (`:3001`). The QA agent starts local with `preview_start({name:"web"})`.

**Release rule (enforced):** *nothing ships to prod until it passes on local first; a prod run is a smoke confirmation, not a substitute.* This is codified in both `docs/qa/QA-PLAN.md` and the agent.

**`qa-frontend` agent** (`.claude/agents/qa-frontend.md`, model `sonnet`). A front-end QA engineer that drives the in-app Browser against a `TARGET` (`prod` = `app.sketchcast.app` / `local` = `localhost:3000`) and reports structured **PASS/FAIL/BLOCKED/SKIPPED** with evidence (accessibility tree, console errors, network status — an uncaught error or failed request is a FAIL even if the page looks fine). Its living catalog is `docs/qa/QA-PLAN.md` (**202 scenarios across 13 areas**, each tagged `requires_login` 🔒 / `requires_secret` 🔑 / `destructive` ⚠️), with a **P0 smoke set** + ten cross-cutting checks (`cc-01`…`cc-10`: console-clean, network-health, broken-links/404, responsive, dark/light, a11y landmarks, security-headers/no-secret-leak, cross-tenant isolation, auth-guard, loading/empty/error states) run on every deploy. It has a **hard safety boundary**: it never types passwords/tokens, creates accounts, enters payment, or clicks irreversible confirms — it verifies those controls are wired and hands the step to the human. Logged-in flows run inside a **human-established session** (the agent can't log in itself).

### 12.5 Known state, caveats & roadmap

- **Billing is dormant (flag off).** `BILLING_ENABLED` is OFF. Stripe (schools, MYR) is merged and live in code but stays off until the Aethel Twin Stripe account is ready; the Lemon Squeezy app path is off pending LS keys + variant ids (migration 0023). The public `/pricing` page (on the Cloudflare landing repo) uses **real LS checkout links directly** and needs no flag — it's the only live purchase surface today.
- **Generation is "minutes," and local playback is stubbed.** Lesson/video/deck generation runs on the Railway worker + `mathsvc` (edge-tts, ffmpeg, models) and takes minutes, not seconds. The local seed inserts a lesson **row with placeholder artifacts**, so the UI shows the lesson but Watch/Deck won't play until the worker is wired to the local DB — a deliberate follow-on, not a bug.
- **Autofix is built and wired end-to-end but dormant.** Flag off; needs `GITHUB_AUTOFIX_TOKEN` + the token/callback secrets + migration 0039, and is awaiting a first live customer issue for its smoke test. Every safety layer (PR-only, green-CI gate, HMAC single-use email approval, least-privilege token, sensitive-diff flag, PII scrub, `FEATURE_AUTOFIX` kill switch) is already in place. Phase 2: auto-trigger on classified code bugs, extend to the worker (`master`) + landing (`main`), and have the agent write the failing test first.
- **Phase-2 board is not built.** The standalone canvas app (`board.sketchcast.app`) and its repo are pending (`FEATURE_AI_TUTOR_CANVAS` off; the scoped board-token auth path exists but is unused). The portal falls back Phase-2 → Phase-1 in-app board → text. Post-Assistant-pivot the TAL board is preserved behind `FEATURE_AI_TUTOR_TAL` (off), and the **AI Teaching Assistant is the active tutor path**.
- **Env drift caveat.** The app `.env.example` omits the Assistant/tutor LLM provider key even though the runtime needs one (per `LOCAL-DEV.md`); worth adding so a fresh Vercel deploy of the Assistant isn't missing a credential.
