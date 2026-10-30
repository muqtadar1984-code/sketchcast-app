# SketchCast books as Library books

Founder, 2026-10-30: *"why dont we list down all the chapters the same way we do for the books uploaded by users? for sketchcast books we wont have parts, we would rather have 1 chapter and 1 kit of artifacts per chapter."* And, about the Classroom Board: *"my books or readymade kits are not showing up here on the board."*

A bought SketchCast book now appears and works like an uploaded book: every chapter, ONE full kit per chapter (no parts), Assign, Open in SK, Download PDF, and the Classroom Board. The Board also lists every ready-made catalogue kit the teacher can open.

## The flow

```
pub_releases (FINAL)
   │  importer (src/sk/knowledge/release.ts → product-book.ts)
   ▼
sk_book_products ──1:1── books (system-owned, sk_product_id, sk_release_id)
                           │  chapters [{num 0-based, title}]
                           │  chapter_grounding: one row per chapter (sections + exercise STEMS)
                           ▼
           master kits = generations of that book, owned by CATALOGUE_OWNER_ID
           (scripts/sk-product-kits.ts: one full single-part kit per chapter)
                           │
     ┌─────────────────────┼──────────────────────────┐
     ▼                     ▼                          ▼
 Library card         Assign / Board              SK tutor (/sk)
 (server reads +      adopt_product_kit() →       sk_product_kits remapped:
  signs the masters    teacher-owned copy          one row per chapter
  after the grant      (book_id null), then the    (release chapter N →
  decision)            normal Assign / session     the chapter's master lesson)
```

**Chapter numbering.** Uploaded books number chapters from 0 (`books.chapters[].num`, `generations.chapter_ref`, `chapter_grounding.chapter_num`) and render `num + 1`. The product book follows that rule: release chapter N is book chapter `num = N − 1`. `sk_product_kits.chapter_ref` and `/sk/<slug>/<chapter>` keep the RELEASE number N.

**Access.** Book access is grants-only (`skAccess`: a live `book_access_grants` row — not revoked, `activated_at ≤ now`, `expires_at` null or later). `has_book_grant(product)` is the same rule in SQL. A licence or subscription never opens a book.

**Master files.** No generations RLS policy is added. A permissive one would also surface master kits in every query that relies on RLS alone (the student dashboard lists "whatever generations I can read"), and no session may sign the system account's storage prefix anyway. As for the catalogue (`/api/catalogue/file`), the server reads the masters with the service role and signs them only after the access decision (`src/utils/my-books/server.ts`). A teacher's adopted copies (`params.product_ref`) point at the same paths. The Library signs them with the service role exactly like catalogue copies (`isCatalogueCopy` in `bookless-kits.tsx`). The Board's kit route already signs with the service role.

## Migration 0175 (`supabase/migrations/0175_sk_product_books.sql`)

| Object | What |
|---|---|
| `books.sk_product_id uuid → sk_book_products(id)` + unique partial index `books_sk_product_uq` | the system book that IS a product |
| `books.sk_release_id bigint` | the final whose chapters it carries |
| trigger `on_book_created` recreated with `WHEN (new.sk_product_id is null)` | a product book never queues `index_book` (it has no PDF). The function body is untouched; the DO block refuses if the live trigger is not the one the repo names |
| `has_book_grant(uuid) → boolean` | STABLE, SECURITY DEFINER, `auth.uid()`, skAccess's book rule |
| policy `books_sk_product_read` (permissive SELECT) | `sk_product_id is not null and removed_at is null and has_book_grant(sk_product_id)` |
| `adopt_product_kit(uuid) → uuid` | SECURITY DEFINER copy of one master piece: grant required, master-only (the book's own owner), idempotent per (owner, source), `book_id`/`chapter_ref` null, title `"<book> — Chapter N: <title> · <piece>"`, `params.product_ref {product_id, release_id, book_id, chapter_ref, source, adopted_at}`, 0129 copy flag (no job, no credit) |
| policies `gen_no_product_ref_insert` / `_update` (RESTRICTIVE) | clients cannot forge `params.product_ref` (0133's lesson) |

Not changed: `books_read`, `books_write`, `chapter_grounding` (service role only), storage, every uploaded book.

## Run order (founder)

1. **Apply 0175** in the SQL editor as one execution. If the DO block raises, stop: the live index trigger differs from the repo.
2. **Re-import the release.** Use Import now (`POST /api/sk/knowledge/import`) or wait for the daily cron. An already-imported final whose product has no book is no longer "unchanged": the importer fetches the bundle and writes the book and its grounding WITHOUT rewriting the knowledge blocks. `CATALOGUE_OWNER_ID` must be set wherever the importer runs (Vercel has it; add it to `.env.local` for the scripts). Without it the book is skipped with a log line.
3. **Deploy the worker prerequisites** (below). Until then, `--apply` refuses.
4. **Dry-run the kits:** `node --env-file=.env.local scripts/sk-product-kits.ts cells-structure-function-organisation`. It prints each chapter (done / queue / running / failed) and the cost.
5. **Apply the kits**, off-peak (20:00–05:00 UTC) with an empty queue: `… --apply --worker-ready`. One kit at a time. It waits for each kit to finish, pauses while anyone else's job is queued or processing, and stops at the first failed lesson. Re-running it queues only the missing or failed chapters.
6. **Dry-run the map:** `… --map`. It prints the BEFORE (the 9 old catalogue kits) and the AFTER (one row per chapter, label = the final chapter title).
7. **Apply the map:** `… --map --apply`. It refuses while any chapter lacks a done kit. It writes the new rows first, then deletes the old ones, so `/sk` never sees an empty map.

### Worker prerequisites (not in this repo)

The script queues exactly the Library's "Generate full kit" rows (`kitRows`), owned by the catalogue account. The worker needs two small changes before those rows can build:

1. **A PDF-less book.** `_book_prelude` always downloads `books.storage_path`. For a book with `sk_product_id` and no `storage_path`, build the chapter from `chapter_grounding.source_text` (one section, `chapter_num` = `chapter_ref`) instead of the PDF.
2. **One part.** The rows carry `params.single_part = true` (and `params.sk_product`). The worker should then analyse the whole chapter as ONE chunk (`chunks_override = [whole chapter]`), as the catalogue kit does with its longer budget. Otherwise `build_chapter_parts` splits at `MAX_PART_WORDS` = 1,950 words, and a ~3k-word chapter becomes a 2-part video. Note the 15,000-char analysis bound: a 3k-word chapter is about 18–20k characters, so scale the char budget as `catalogue/kit.py part_chars_budget()` does.

Other notes:
- The catalogue account is a platform admin, assumed to be on an uncapped tier for `enforce_fair_use`. This is NOT verified. If it is capped, the first `--apply` insert raises and nothing is queued or spent.
- `credit_ledger_write` records its usual rows against that account.
- `params.catalogue` is NOT set, so the job is not routed to the catalogue path.

## Cost

About **$1.5–2.5 per kit**, ≈ $2.1 point estimate (`KIT_COST_USD` in `src/sk/product-kits-plan.ts`). Sources:
- the worker's measured kit (`worker/process.py`: "the Sonnet analysis DOMINATES a kit's cost — $2.08");
- the 2026-10 unit-cost note (≈ $1.5–1.8 on Gemini credits, ≈ $2.2–2.5 on Claude cash).

Biology (10 chapters) ≈ **$15–25**, ≈ $21. Check the console's live average (`src/utils/kit-cost.ts` over `jobs.usage`) before a large batch.

## UI

- **Library → My books.** `my-books-strip.tsx` (now a server component) renders a tile that has chapters as `product-book-card.tsx`:
  - the card shows the cover, title, language, "N chapters", Open in SK and Download PDF;
  - a collapsible list holds every chapter, each with its kit's files or "Lesson kit coming soon";
  - each chapter has **Assign chapter** (`AssignModal` with `prepare` = `adopt_product_kit` over the student pieces) and **Open in SK**;
  - buyers get no Generate, regenerate, delete or edit.
- **Classroom Board.**
  - **Book picker.** SketchCast books are marked "· SketchCast". Picking a chapter calls `POST /api/present/adopt {bookId, chapterNum}`. That adopts the chapter's whole kit and plays the copy as a ready-made kit.
  - **Ready-made picker.** It lists her kits first, then every current catalogue kit she can open but has not copied. Picking one calls `POST /api/present/adopt {catalogueKit}`.
  - **"Can open"** means a topic she unlocked, or any current kit on an unlimited tier (where the unlock is free). A capped tier's locked kit is not offered, and the Board never spends her weekly allowance.
  - A deep link (`?book=&chapter=`) to a SketchCast chapter is not auto-adopted. Pick it from the bar instead.
- **SK tutor.** No code change: `canOpenKit` accepts any done, live, mapped presentation (tested with a master of the product book).

## Rollback

`supabase/migrations/0175_sk_product_books_rollback.sql` drops the policies, both functions, the columns and the WHEN clause (the trigger returns to 0002's form). It keeps:
- the system books, because their master kits reference them;
- teachers' adopted copies, which are their own rows and may already be assigned.

Restore the old SK map by hand if needed: the 0170 seed inserts the nine catalogue kits with `on conflict do nothing`.

Code rollback is a revert of the branch. The importer, Library and Board all tolerate 0175 being absent (42703 → skip / plain tile / pre-0175 book columns).
