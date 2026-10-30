# SketchCast books as Library books

Founder, 2026-10-30: *"why dont we list down all the chapters the same way we do for the books uploaded by users? for sketchcast books we wont have parts, we would rather have 1 chapter and 1 kit of artifacts per chapter."* And, about the Classroom Board: *"my books or readymade kits are not showing up here on the board."*

Corrections the same day:
1. *"why do we need to generate the 10 chapter kits. we already have those generated as part of the catalogue. the video should be pulled from youtube to avoid egress cost."*
2. *"the book doesnt go to SK, it goes to the whitebaord just like a users uploaded text book."*

So a bought SketchCast book appears and works like an uploaded book. It lists every chapter, and each chapter's kits are the EXISTING catalogue kits of the chapter's topics. Nothing is generated. The book is taught on the Classroom Board, not in SK. Lesson videos stream from YouTube.

## The flow

```
pub_releases (FINAL) + bundle.json (chapters[].topics, chapters[].videos)
   │  importer (src/sk/knowledge/release.ts → product-book.ts)
   ▼
sk_book_products ──1:1── books (system-owned, sk_product_id, sk_release_id)
                           │  chapters [{num 0-based, title}]
                           │  chapter_grounding: one row per chapter (SK's knowledge)
                           │
   scripts/sk-product-kits.ts --apply (founder)
   bundle topics → topics.slug → catalogue_current_kits() → topic_kits → presentation
                           ▼
              sk_product_kits (0170): product × release chapter → catalogue kit lesson
                           │
     ┌─────────────────────┼──────────────────────────────┐
     ▼                     ▼                              ▼
 Library card         Classroom Board                 SK tutor (/sk)
 (server reads the    book picker / ?book=&chapter=   unchanged: kitForChapter /
  map + kits, signs   → adopt_product_kit() →         canOpenKit read the map,
  the documents;      her copy of the catalogue kit   now the catalogue kits
  Watch = YouTube)    → plays it as a ready-made kit  per chapter
                      (video from YouTube)
```

**Chapter numbering.** Uploaded books number chapters from 0 (`books.chapters[].num`, `generations.chapter_ref`, `chapter_grounding.chapter_num`) and render `num + 1`. The product book follows that rule: release chapter N is book chapter `num = N − 1`. `sk_product_kits.chapter_ref`, `/sk/<slug>/<chapter>` and the Library's "Chapter N" use the RELEASE number N. The Board's `?chapter=` is the 0-based `num`, as for uploaded books.

**Access.** Book access is grants-only (`skAccess`: a live `book_access_grants` row — not revoked, `activated_at ≤ now`, `expires_at` null or later). `has_book_grant(product)` is the same rule in SQL. A licence or subscription never opens a book. The book grant IS the entitlement to the mapped catalogue kits: no topic unlock and no weekly catalogue allowance is needed or spent.

**Catalogue files.** No generations RLS policy is added. The server reads the mapped kits with the service role and signs the documents only after the access decision (`src/utils/my-books/server.ts`), as `/api/catalogue/file` does. A teacher's adopted copies point at the same paths, and the Library signs them with the service role like any catalogue copy (`isCatalogueCopy` in `bookless-kits.tsx`).

## Biology's map

From the release bundle's `chapters[].topics`:

| Ch | Kits (topic order) |
|---|---|
| 1 | cells |
| 2 | using-a-microscope… |
| 3 | cells (labelled with chapter 3's title, "Shared with Chapter 1") |
| 4 | plant-and-animal-cells-compared |
| 5 | specialised-cells |
| 6 | states-of-matter…, diffusion-in-living-cells |
| 7 | cells (chapter 7's title, "Shared with Chapter 1") |
| 8 | blood…, the-human-respiratory-system, transport-in-plants |
| 9 | inheritance-and-variation |
| 10 | six review topics |

**Label rule** (`src/sk/product-kits-plan.ts`): a row's label is the topic's title. The exception is a ONE-topic chapter whose kit an earlier chapter already maps (ch 3, 7): that row gets the chapter's own title. In a several-topic chapter (ch 10) a shared kit keeps its topic title, so the kits stay distinguishable. The Library computes "Shared with Chapter N" from the map. A topic listed twice in one chapter maps once.

## Migration 0175 (`supabase/migrations/0175_sk_product_books.sql`, NOT applied)

| Object | What |
|---|---|
| `books.sk_product_id uuid → sk_book_products(id)` + unique partial index `books_sk_product_uq` | the system book that IS a product |
| `books.sk_release_id bigint` | the final whose chapters it carries |
| trigger `on_book_created` recreated with `WHEN (new.sk_product_id is null)` | a product book never queues `index_book` (it has no PDF). The function body is untouched. The DO block refuses if the live trigger is not the one the repo names |
| `has_book_grant(uuid) → boolean` | STABLE, SECURITY DEFINER, `auth.uid()`, skAccess's book rule |
| policy `books_sk_product_read` (permissive SELECT) | `sk_product_id is not null and removed_at is null and has_book_grant(sk_product_id)` |
| `adopt_product_kit(uuid) → uuid` | SECURITY DEFINER. The source must be a piece (the presentation or a non-blank `doc_generation_ids` slot) of an APPROVED `topic_kits` row whose presentation is mapped in `sk_product_kits` to a product the caller holds a live grant for. That is one lookup with one answer for "not mapped" and "not yours" (42501). The source must be done, not removed, not withdrawn. Students and suspended accounts are refused. It makes `adopt_catalogue_piece`'s copy: same storage paths, status done, `book_id`/`chapter_ref` null, the 0129 copy flag (no job, no credit), title = the source's. It writes `params.catalogue_ref` (0132's shape) AND `params.product_ref {product_id, release_id, book_id, chapter_ref, topic_kit_id, source, adopted_at}`. It is idempotent per (owner, source) across BOTH adopt functions, and logs a `catalogue_events` `adopt` row with `via: book`. It never calls `catalogue_has_access`, `unlock_catalogue_kit` or the allowance |
| policies `gen_no_product_ref_insert` / `_update` (RESTRICTIVE) | clients cannot forge `params.product_ref` (0133's lesson; `catalogue_ref` is already refused by 0133) |

Not changed: `books_read`, `books_write`, `chapter_grounding` (service role only), `sk_product_kits` (service role only), storage, the catalogue's unlock rules, every uploaded book.

## Run order (founder)

1. **Apply 0175** in the SQL editor as one execution. If the DO block raises, stop: the live index trigger differs from the repo.
2. **Merge** the PR (deploys the importer, Library, Board and stage).
3. **Re-import the release.** Use Import now (`POST /api/sk/knowledge/import`) or wait for the daily cron. An already-imported final whose product has no book is no longer "unchanged": the importer fetches the bundle and writes the book and its grounding WITHOUT rewriting the knowledge blocks. `CATALOGUE_OWNER_ID` must be set wherever the importer runs (Vercel has it). Without it the book is skipped with a log line.
4. **Dry-run the map:** `node --env-file=.env.local scripts/sk-product-kits.ts cells-structure-function-organisation`. It reads the product's live release and its bundle. The bundle comes from S3 with your default AWS credentials, or pass `--bundle <bundle.json>`. It prints:
   - BEFORE: the product's rows now, which are the nine 0170 seed rows;
   - AFTER: one row per (chapter, kit), with slug, shared-with and YouTube ids;
   - UNRESOLVED topics, with the reason (`unknown_topic`, `no_current_kit`, `no_lesson`, `lesson_not_ready`);
   - per chapter, the bundle's `videos` beside the resolved kits' YouTube ids.
5. **Apply the map:** `… --apply`. It refuses while a topic is unresolved unless you pass `--allow-missing`. It writes the new rows first, deletes the product's other rows (so `/sk` never sees an empty map), then re-reads and prints the live map. `--map` is still accepted. `--worker-ready` / `--any-hour` are gone.

No generation, no queue, no cost. No worker change is needed.

## Video from YouTube

**Where the id comes from.** `topic_publications` holds one row per `(topic_kit_id, part, channel_language)`, written by the topic catalogue → YouTube pipeline. `src/utils/catalogue/kit-youtube.ts` reads it with the service role. A part is watchable when it meets all of these:
- `youtube_video_id` is well-formed;
- `superseded_by` is null;
- `privacy` is `public` or `unlisted`;
- `youtube_missing_since` is null.

The result is one id per part, in part order. A copy finds its kit through `params.catalogue_ref.topic_kit_id` (or `product_ref.topic_kit_id`). A mapped lesson finds its kit through `topic_kits.presentation_generation_id`. The bundle's `chapters[].videos` (`video:<id>`) is only a cross-check, printed by the script.

**Rule** (`videoSource` / `lessonVideo`): use YouTube when it covers EVERY stored part. Otherwise use the stored MP4 and log it (`[present]` / `[library]` / `[sk-library]` "no watchable YouTube video for catalogue kit …"). Uploaded-book kits always use their own storage videos.

Where it applies:
- **Library, SketchCast book card:** the lesson's Watch chip opens the YouTube watch page.
- **Library, ready-made kits (bookless-kits):** every catalogue copy's Watch chip is its YouTube link (`dashboard/page.tsx`).
- **Classroom Board:** `/api/present/kit` answers a catalogue copy's unit with `video.youtube` (ids) and signs NO MP4. The stage (`stage.tsx`) plays `youtubeId` through the YouTube IFrame Player API (`https://www.youtube.com/iframe_api`, loaded once). `youtube-video.ts` wraps the player in the controller's `VideoLike` interface:
  - `currentTime` get and set (`seekTo` with an asynchronous `seeked` once the player is near the target, or after 3 s);
  - `duration`, `paused`, `play`/`pause`;
  - `ended` and `error` events.

  Segment seeks, SK's position reads and the recorded ink times work unchanged. There is no CSP in this app (`next.config.ts` is empty, `src/proxy.ts` sets no headers, `vercel.json` has only crons), so the iframe and script load.
- **Not possible on YouTube:** capturing a frame. The iframe is cross-origin. `freeze()` pauses and returns null, and the Board says "Could not capture the frame." "Load slides" (which captures the video's slide frames) is hidden for a YouTube lesson. "Load the deck as pages" still works.

## UI

- **Library → My books** (`my-books-strip.tsx`, `product-book-card.tsx`), for a teacher or parent holding the book:
  - The card shows the cover, title, language, "N chapters", "By SketchCast" and Download PDF.
  - Every chapter is listed with its kits' files. A chapter with several kits labels each one with its topic. A shared kit says "Shared with Chapter N". A chapter with no kit shows "Lesson kit coming soon".
  - Per chapter: **Teach on the board** (`/present?book=<id>&chapter=<num>`, shown when the reader passes the Board gate) and **Assign chapter**. Assign uses `AssignModal` with `prepare` = `adopt_product_kit` over the student pieces of every kit of the chapter.
  - There is no "Open in SK", and no Generate, regenerate, delete or edit.
  - A **student** keeps the plain tile with its "Open in SK", which is the student tutor.
  - A parent viewing a child's book also keeps the plain tile.
- **Library → ready-made kits:** a book's adopted copies group by catalogue topic, so several kits of one chapter stay apart.
- **Classroom Board:**
  - **Book picker:** SketchCast books are marked "· SketchCast" and carry each chapter's kits.
  - **Picking a chapter, or a `?book=&chapter=` deep link:** the chapter is pending. No book rail loads and Start waits.
    - A chapter with one kit adopts it by itself.
    - A chapter with several kits shows "Choose the kit".
    - The adopt is `POST /api/present/adopt {bookId, chapterNum, kit}`. The copy plays as a ready-made kit, and `autostart=1` starts once the copy exists.
  - **Ready-made picker:** unchanged. It lists her kits first, then every current catalogue kit she can open but has not copied.
- **SK tutor:** no code change. `canOpenKit` / `kitForChapter` read the map. A kit shared by several chapters answers from its first chapter (tested).

## Rollback

`supabase/migrations/0175_sk_product_books_rollback.sql` drops the policies, both functions, the columns and the WHEN clause (the trigger returns to 0002's form). It keeps:
- the system books and their grounding;
- teachers' adopted copies, which are their own rows and may already be assigned;
- the `sk_product_kits` rows.

Restore the old SK map by hand if needed: the 0170 seed inserts the nine catalogue kits with `on conflict do nothing`.

Code rollback is a revert of the branch. The importer, Library and Board all tolerate 0175 being absent (42703 → skip / plain tile / pre-0175 book columns).

## Known limits / follow-ups

- The student `/sk` kit tutor and the student kit player (assigned copies) still sign the stored MP4. They were not in this change's scope.
- A catalogue topic that is not CURRENT (for example its English video is not public, or its bank is `none`) does not resolve. The script reports it, and `--allow-missing` maps the rest.
