# Pipeline invariant: one shared, role-agnostic path for every adult author

Every adult who can upload a book and generate artifacts — **teacher, principal,
coordinator, school_admin, and parent-author** — goes through the **same**
processing pipeline. Any improvement to that pipeline (better chapter detection,
self-heal, faster generation, the stale-job reaper, …) therefore reaches **all**
of them automatically. There is no "teacher pipeline" vs "parent pipeline".

This is not a convention we hope holds — it's structural:

1. **One upload entry point.** The only place a `books` row is created is
   `src/app/dashboard/upload-book.tsx`. All adult roles use it.
2. **DB triggers are the choke point, and they're unconditional.**
   - `create_index_job_for_book` — on **any** `books` insert → `index_book` job.
   - `on_generation_created` — on **any** `generations` insert → a `{kind}` job.
   Neither trigger looks at the owner's role (`supabase/migrations/0001_init.sql`).
3. **The worker never sees the role.** A job row carries only `book_id` /
   `generation_id`. `worker/process.py` (`index_book`, `process_generation`) reads
   `owner_id` (for storage paths + school branding) and `kind` — **never a role**,
   and never branches on one. So the exact same detection + self-heal runs no
   matter who owns the book.

Role only affects *who is allowed in* (RLS / nav / caps) and *which UI they see* —
never *how* their book is indexed or their lesson is generated.

## The guard (so this can't silently regress)

Two regression tests fail the build if someone breaks the invariant:

- **App:** `src/__tests__/pipeline-universal.test.ts` — asserts there is exactly
  one book-upload entry point, and that no generation entry point hand-rolls its
  own `jobs` insert (the trigger owns that, uniformly).
- **Worker:** `tests/test_pipeline_role_agnostic.py` — asserts `process.py` never
  reads/branches on an owner role, and that the universal chapter fixes
  (`heal_chapter_boundaries`, `verify_chapter_content`,
  `relocate_chapter_for_generation`) and the stale-job reaper stay wired.

## If you're adding a feature

- **A new way to upload a book?** Insert a normal `books` row (so the index
  trigger fires and every pipeline fix applies), then add the file to
  `ALLOWED_UPLOADERS` in the app guard test. Do **not** create the `index_book`
  job yourself, and do **not** add a separate/parallel processing path.
- **A new generation kind or entry point?** Insert a `generations` row and let
  `on_generation_created` create the job. Don't insert a `jobs` row by hand.
- **Tempted to branch the worker on role?** Don't. If a genuine per-role
  difference is unavoidable, treat it as a deliberate design change: update this
  doc and the guard test's allowlist so it's explicit and reviewed — never a
  silent divergence that leaves one role on an older, buggier pipeline.

This is exactly why the scanned-book chapter fix (`docs/CHAPTER_HEAL.md`, worker
repo) needed no per-role work: it lives in the shared pipeline, so a teacher, a
principal, and a parent uploading the same messy scan all get the fixed result.
