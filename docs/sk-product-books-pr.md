# PR #218 — SketchCast books as Library books (paste as the PR description)

## Summary

A bought SketchCast book now appears in the Library like an uploaded book. It lists every chapter, and each chapter carries the **existing catalogue kits** of its topics. The book is taught on the **Classroom Board**, not in SK. Lesson videos **stream from YouTube**, not our storage.

Founder's corrections (2026-10-30):
1. *"why do we need to generate the 10 chapter kits. we already have those generated as part of the catalogue. the video should be pulled from youtube to avoid egress cost."*
2. *"the book doesnt go to SK, it goes to the whitebaord just like a users uploaded text book."*

## What changed

- **No generation.** `scripts/sk-product-kits.ts` only writes `sk_product_kits`.
  - It reads the release bundle's `chapters[].topics` and resolves each slug to the topic's current catalogue kit in the book's language (`catalogue_current_kits()`). It maps that kit's done presentation.
  - Labels are topic titles. A one-topic chapter that reuses an earlier chapter's kit (Biology ch 3 and 7 reuse "cells") is labelled with its own title and notes "Shared with Chapter 1".
  - It is a dry run by default, with `--apply`. It prints before and after, and refuses unresolved topics unless `--allow-missing`.
  - The queue path and `--worker-ready` are removed. The planning is `src/sk/product-kits-plan.ts` (unit-tested).
- **Migration 0175** (not applied; edited): `adopt_product_kit(p_source)` now copies a piece of an APPROVED catalogue kit whose lesson is mapped to a product the caller holds a live grant for.
  - It makes `adopt_catalogue_piece`'s copy: copy flag, no job, no credit, `catalogue_ref`, plus `product_ref`.
  - It is idempotent across both adopt functions.
  - There is no unlock and no allowance. The book grant is the entitlement.
  - Forged `product_ref` is still refused by RESTRICTIVE policies.
- **Importer:** unchanged. The product book keeps its final chapter titles (0-based `num`) and its `chapter_grounding`, and gets no index job.
- **Library card:**
  - "Open in SK" is gone from the card. A student keeps the plain tile, whose "Open in SK" is the student tutor.
  - Per chapter: the kits' chips, **Teach on the board** (`/present?book=&chapter=`, for Board readers) and **Assign chapter**.
  - A chapter with several kits labels each one. Shared kits say so.
  - Adopted copies group by catalogue topic.
- **Classroom Board:**
  - The product book's chapters carry their kits.
  - Picking a chapter, or a `?book=<product book>&chapter=N` deep link, adopts its kit (`adopt_product_kit`, free). A chapter with several kits asks which.
  - The copy plays as a ready-made kit, and autostart waits for it.
  - The "every ready-made kit you can open" listing is kept.
- **YouTube:**
  - `src/utils/catalogue/kit-youtube.ts` finds a kit's watchable ids in `topic_publications`.
  - `/api/present/kit` returns YouTube ids instead of signed MP4s for catalogue copies (`catalogue_ref` / `product_ref`).
  - The stage plays them through the IFrame Player API behind the controller's `VideoLike`, so seek, time, play/pause, ended and error keep working.
  - Library Watch chips for catalogue copies and product chapters open YouTube.
  - Storage is a logged fallback only. Uploaded-book kits are unchanged.
- **SK tutor (`/sk`):** no code change. It now sees the catalogue kits per chapter.

## Known trade-off

YouTube's iframe is cross-origin, so a YouTube lesson cannot be frame-captured. Freeze pauses and says "Could not capture the frame", and "Load slides" is hidden for those lessons. "Load the deck as pages" still works.

## Run order

1. Apply `supabase/migrations/0175_sk_product_books.sql` (one execution).
2. Merge.
3. Re-import the release (Import now, or the daily cron).
4. `node --env-file=.env.local scripts/sk-product-kits.ts cells-structure-function-organisation` (dry run; `--bundle <file>` if S3 is not reachable).
5. `… --apply`.

## Tests

The targeted suites pass:
- `src/sk/knowledge`, `src/utils/my-books`, `src/app/present`;
- `src/app/api/present`, `src/app/api/catalogue`, `src/app/api/my-books`;
- `src/app/dashboard/__tests__`, `src/sk/__tests__`, `catalogue-routes`;
- the 017x migration lints, and the new `kit-youtube` and `youtube-video` tests.

`tsc` shows only the known `@aws-sdk/client-ecs` error. eslint is clean on the changed files.

Docs: `docs/sk-product-books.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
