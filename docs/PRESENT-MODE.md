# Present mode — the classroom whiteboard

Status: **pre-code, decisions settled** (22 Aug 2026). Nothing here is built.
Full plan (narrative, risks, phase gates): https://claude.ai/code/artifact/3391f463-1692-4861-90cc-1051ecbac012

A whiteboard a teacher drives on a classroom panel. It plays the lesson video,
puts the generated documents on the board, and lets her stop anywhere to write.
Writing is the teacher's — the AI drawing path (TAL) stays parked.

## Decisions settled 22 Aug 2026

1. **Runs on any device.** No target panel. Capabilities are probed at runtime
   and the board picks its own capture tier. Cost: finger drawing is
   first-class and palm rejection loses its best signal, so the tool rail
   carries an explicit **touch draws / touch scrolls** toggle.
2. **The frozen frame lands on the roll.** Freeze pastes the frame in as a page
   background; the live video parks in the corner holding `currentTime`.
3. **The context bar remembers the last part taught to that class** and offers
   the next. Cost: the first lesson with any class is always a manual pick, and
   the pointer must be written at session close (including tab close).
4. **Worksheet only — test papers NEVER project.** A paper the class has
   watched on the board is no longer a test. Exam papers stay in the rail as a
   teacher download; `questions_json` exists for them and we deliberately do
   not use it. Lesson plan / activity / case study are downloads too.
5. **All THREE worksheet flavours reach the board**, not just the part's own —
   she must be able to present extra worksheets she generated. See below.

## The three constraints

1. **Ink latency is the product.** Phase 0 measures it on the real panel before
   anything else is written. A failure changes the product, not the schedule.
2. **The `<video>` element must never unmount.** "Never reloads or loses its
   place" is architecture: one element in one fixed container, moved between
   stage and corner by transform. Conditionally re-parenting it = React unmount
   = a reload in front of the class. Second-order: artifact URLs are signed for
   1 h (`page.tsx` signs at 3600) — a panel woken at 07:00 and taught at 10:40
   already holds a dead URL. Sign at session start, re-sign on `error`.
3. **The roll is the record.** Ink exports to PDF and becomes the students'
   revision note, so annotation over a frozen frame lands ON the roll, not on an
   overlay that dies at resume.

## What the repo already has

| Piece | Where |
|---|---|
| Kits: video / deck / docs / quiz JSON | `generations` + `artifacts` (0001); `worker/process.py:863-1012` |
| Timetable grid + period clock | `timetable_slots`; `src/utils/timetable.ts` |
| Append-only board persistence precedent | `tutor_board` + `tutor_board_event` (0029) |
| Scene graph / event log / SVG renderer | `src/ere/` |
| Quiz with the key stripped server-side | `src/app/api/quiz/logic.ts` — `stripQuiz()` |
| Chapter concepts + narration text | `chapter_grounding` |
| PDF writer | `pdf-lib` (already a dep, used by `page-scanner.tsx`) |
| English as the i18n fallback base | `src/i18n/dictionaries.ts` — ship English-only, translate after |

**ERE does not supply the board.** `renderSvg` builds a whole SVG string and
assigns it to `innerHTML` (`src/ere/renderer/host.ts:24`) — right for ten nodes
a turn, impossible at pen rate — and its coordinate space is one 0–100 logical
screen, not a roll. ERE gives us the persistence model and the future
AI-drawing renderer; the board, viewport, ink pipeline and export are new.

## Gaps found while reading

1. **No class -> book link anywhere in the schema.** Timetable gives class +
   subject; books carry grade + subject. "Ch 4 · Part 2" must be derived and
   remembered. See decision 3.
2. **No timing track on the video** — `deck.pptx` + `lesson.mp4` only. Freeze at
   4:32 works; "jump to slide 6" does not, and is out of scope.
3. **Only `worksheet` and `exam_paper` carry `questions_json`.** Lesson plan,
   activity and case study are `.docx` only — nothing structured to put on a
   board without a worker change.
4. **No PDF export of anything today.**
5. **No per-user feature gate** — the console gates by email *domain*;
   everything else is an env flag or a per-school config key.

## Worksheets beyond the part

`docgen/worksheet.py` writes `questions.json` from the same builder for every
`worksheet` generation, so all three flavours are board-ready as they stand:

| Flavour | Shape in `generations` | Board |
|---|---|---|
| Kit worksheet | `kind=worksheet` · `chapter_ref=N` · `params.part=k` | yes (default) |
| Revision, per chapter (0061) | `kind=worksheet` · `params.revision=true` · `chapter_ref=N` | yes |
| Revision, cumulative | `kind=worksheet` · `params.revision=true` · `chapter_ref=null` · `params.chapters=[…]` | yes |
| Test paper | `kind=exam_paper` | **never** |
| Cumulative exam (0062) | `kind=exam` | **never** (and it has no `questions_json` anyway) |

**The predicate, no special cases:** a generation may reach the board iff
`kind = 'worksheet'` AND it has a `questions_json` artifact. That admits all
three worksheet flavours and excludes both assessment kinds BY KIND, not by
missing data — `exam_paper` has perfectly good structured questions and we are
choosing not to use them.

**UI:** the rail's Worksheet button is a split control — tap for the part's own,
caret for the rest, grouped as *this chapter's other parts* / *this book's other
chapters* / *revision papers* (scope label via the existing `chapterRangeLabel`)
/ *other books*, collapsed. Newest first, big targets, no hover states. Refresh
on open so a worksheet generated during break appears without a reload.

**NOT in v1:** generating a worksheet from inside a live lesson (minutes of wait
plus a credit drawn, with a class watching). Present mode presents; generating
stays a prep-time act.

**Consequence — the session's context and its CONTENT are no longer the same
thing.** The slot says Ch 4 Part 2; the class may have done a term revision over
chapters 1-5. Hence `present_items` (below), which grounds the recap in what was
*shown* rather than what was *scheduled*, makes the coverage record honest, and
protects the autofill: **only the slot's own video or kit worksheet advances the
last-taught pointer.** Revising chapters 1-5 must not claim chapter 5 is taught.

## Architecture

Four layers per page; only the wet-ink layer runs at pen rate.

    chrome     tool rail, push button, period clock      — normal React
    wet ink    stroke in progress                        — desynchronised canvas, no React
    dry ink    committed strokes                         — blitted on pointerup
    content    frozen frame | question | ERE SVG | blank

**The roll** — vertical only, quantised into pages of **1600 x 900 logical
units**: one screen, one 16:9 frame, one landscape PDF page, the same rectangle
three times. Push appends a page and scrolls exactly one page height.

**Any device — one model, three capture tiers.** The stroke model is identical
in all three; only fidelity and the render path differ.

| Tier | When | Capture |
|---|---|---|
| A | pen + coalesced events + desynchronised canvas + pressure that really varies | full rate, pressure width, optional prediction |
| B | touch/mouse + coalesced events + standard canvas | full rate, velocity width, no prediction |
| C | no coalesced events (old WebView) | raw `pointermove`, heavier smoothing |

The probe ships *inside* the board as `capabilities.ts`, not only as a test
page, so an unseen panel self-reports on first run.

**Ink pipeline** — `setPointerCapture` + `touch-action: none`;
`getCoalescedEvents()` on move, draw only the new segment synchronously in the
handler (no rAF hop, no state update); smooth + commit on up. Width from
velocity by default, pressure only when `pointerType === "pen"` and force
actually varies. Palm: pen-preferred once a pen is seen, else contact-size
rejection, one active stroke. Wrap `releasePointerCapture` — it still throws on
some panels.

**Stroke** = `{ id, page, tool, colour, width, pts }` with `pts` a flat
`[x,y,p,...]` array in page units. Never screen pixels.

**Persistence** — local-first: IndexedDB is the truth during the lesson, a
batched flush (~3 s or 20 strokes) mirrors to the server. Erase is an
append-only stroke applied `destination-out`; undo is a tombstone, never a
delete.

**Recap** — one cheap model call grounded on `present_items`, NOT on the
timetable slot: `chapter_grounding` for every distinct chapter actually shown
(capped at 6 so the prompt stays small), plus how far the video ran. NOT the ink
(we cannot read handwriting). One or two sentences, concept language, "played the video" and
"opened the worksheet" banned. Draft -> she edits -> publish. No credit
consumed; rate-limited instead.

**Access** — `PRESENT_ALLOWED_EMAILS`, server-only, default empty = nobody.
Never `NEXT_PUBLIC_`. Enforced in three places: the `/present` page (redirect),
every `/api/present/*` route (404, not 403), and RLS (`teacher_id = auth.uid()`).

## Migration 0094 — four tables

`present_sessions` (one row per period: teacher, class, book, chapter, part,
slot day/period, page_count, pdf_path, recap_draft, recap_body,
recap_published_at) · `present_pages` (session, idx, background jsonb) ·
`present_strokes` (session, seq, page_idx, tool, color, width, pts jsonb,
voided_at; PK (session_id, seq)) · `present_items` (session, seq,
generation_id, kind `video|worksheet|blank`, detail jsonb, opened_at; PK
(session_id, seq)) — what she actually put in front of the class, in order.
Shaped after `tutor_board` / `tutor_board_event`: a session row, a page row, and
two append-only streams. A 40-minute lesson is ~1-3k strokes.

## Phases (each gated by the one before)

| # | Phase | Gate |
|---|---|---|
| 0 | Latency truth on every device reachable — capability report (recorded, not just shown), 4 draw strategies, pointer-to-paint p50/p95, 240 fps nib-gap check. Run it on the WORST device you can find, not only the best | Tier A hits one frame on the best device to hand; **Tier C is still judged usable on the worst**. If Tier C fails on hardware a school would plausibly own, that changes the product (native shell, or a stated minimum spec), not the schedule |
| 1 | The board as a library — `src/board/`, zero app imports (model, capabilities, ink, render, roll, export-pdf, store) + dev gallery | 500 strokes over 10 pages at 60 fps; model round-trips; two exports identical |
| 2 | Present mode in the app — `/present`, gate, context bar, kit rail + worksheet picker, stage, `present_items`, 0094, `/api/present/*` | A full mock lesson on the panel — including the part's worksheet, THEN a revision worksheet from another chapter, a mid-lesson refresh that loses nothing, and a last-taught pointer that did NOT move because of the revision paper |
| 3 | After the lesson — recap draft/edit/publish, roll to storage, student + absentee visibility | A published note that names the concept; a student account that can open both |
| 4 | One real period — instrument strokes, freezes, pushes, crashes, recap edit distance | Five consecutive periods with no fallback to the old way |

## Out of scope

AI drawing on the board (TAL stays parked) · **test papers on the board**
(excluded on principle, not capability) · **generating a worksheet mid-lesson** · any video infrastructure (remote days
run on the school's Zoom via screen share) · student devices · slide-level video
navigation (no cue track exists) · multi-teacher rollout until Phase 4 reports
back.
