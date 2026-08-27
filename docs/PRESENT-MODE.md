# Present mode — the classroom whiteboard

Status: **Phase 0 built, not yet run on a panel** (24 Aug 2026).
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

**Configuration.** One variable, and it takes an ADDRESS, not `true`:

    PRESENT_ALLOWED_EMAILS=someone@example.com,another@example.com

Note it is NOT in `.env.example` — `.gitignore` matches `.env*`, so that file is
untracked and anything written there stays on one machine. `src/utils/flags.ts`
is the tracked documentation for this variable.

**Access** — `PRESENT_ALLOWED_EMAILS`, server-only, default empty = nobody.
Never `NEXT_PUBLIC_`. Enforced in three places: the `/present` page (redirect),
every `/api/present/*` route (404, not 403), and RLS (`teacher_id = auth.uid()`).

## Migration 0097 — four tables (Phase 2)

`present_sessions` (one row per period: teacher, class, book, chapter, part,
slot day/period, page_count, pdf_path, recap_draft, recap_body,
recap_published_at) · `present_pages` (session, idx, background jsonb) ·
`present_strokes` (session, seq, page_idx, tool, color, width, pts jsonb,
voided_at; PK (session_id, seq)) · `present_items` (session, seq,
generation_id, kind `video|worksheet|blank`, detail jsonb, opened_at; PK
(session_id, seq)) — what she actually put in front of the class, in order.
Shaped after `tutor_board` / `tutor_board_event`: a session row, a page row, and
two append-only streams. A 40-minute lesson is ~1-3k strokes.

## Phase 0 — what shipped (24 Aug 2026)

| File | What it is |
|---|---|
| `src/board/capabilities.ts` | The runtime probe + tier selection. Phase 1's library arriving early: zero app imports, injectable host, unit-tested |
| `src/board/__tests__/capabilities.test.ts` | 18 tests, incl. the one that matters: a panel that ADVERTISES pressure never reaches Tier A until a stroke proves it varies |
| `src/app/present/probe/page.tsx` | The gated surface. Redirects; not translated (measurement scaffolding, one reader) |
| `src/app/present/probe/probe-client.tsx` | The harness: 4 strategies, latency percentiles, frame health, camera-test instructions, save |
| `src/app/api/present/probe/route.ts` | POST records a run, GET reads them back. 404 on every failure, never 403 |
| `supabase/migrations/0096_present_probe.sql` | One row per run. RLS: own-read only, NO write policy — the route writes under the service role |
| `src/app/preview/board-probe/page.tsx` | Same harness, no gate, `notFound()` in production — how it gets checked without a prod login |
| `src/utils/flags.ts` | `presentAllowed(email)` — `PRESENT_ALLOWED_EMAILS`, empty = nobody |
| `src/utils/__tests__/present-gate.test.ts` | 13 tests on the allowlist — the only thing between an unreleased surface and a live app |

**Measured on a Windows laptop / Chrome 1280x860 (the control, not the answer):**

| Strategy | input→draw p50 | p95 | input→paint p95 |
|---|---|---|---|
| React state | 15.3 ms | 34.1 ms | 58.1 ms |
| Canvas 2D | 7.3 ms | 22.1 ms | 37.5 ms |
| Canvas, desynchronized | 0.6 ms | 0.9 ms | 23.3 ms |
| Desync + prediction | 0.6 ms | 1.0 ms | 27.2 ms |

Directionally what the plan predicted — React state costs roughly a frame, the
desynchronised context is ~25x cheaper to the draw call. **Do not quote these as
a result:** they came off a fast laptop with a mouse, tiny samples, and a dev
server compiling in the background. The harness now marks any percentile taken
from fewer than 50 samples for exactly that reason — the first live run reported
"p50 7.3ms" off SIX points and it looked authoritative.

**Two field notes from wiring it up (27 Aug):**

* `PRESENT_ALLOWED_EMAILS` takes an ADDRESS, not `true`. It was first set to
  `true` by analogy with every other `FEATURE_*` flag — which allowlists an
  account called "true" and locks out everyone, silently. Pinned as a test.
* **The migration was renumbered 0094 → 0096.** Both 0094 (`attribution`) and
  0095 (`refund_when_nothing_was_delivered`) were written and applied to
  production in the days between this one being drafted and applied. Check
  `list_migrations` against the LIVE DB, not just the folder — the two are not
  1:1 (0094 alone is three entries upstream), and the folder already carries a
  pre-existing collision at 0052.

**Adversarial review, 27 Aug** (13 agents, 5 lenses, refutation pass). 25 findings
raised, 8 verified, 3 survived. What was fixed:

| | |
|---|---|
| React pad recorded every `toDraw` TWICE | the other three pass `NaN` on the deferred leg; React spread the sample. Its `n` was 2x the others', so it cleared the MIN_SAMPLES honesty gate on half the drawing. **Verified fixed: 25 moves now give n=25 on both pads, was 50 vs 25** |
| React pad's `pointerdown` timestamp skipped `toHiRes()` | the only such path of five. On an epoch-clock WebView — the Tier C panels this exists to characterise — it produced a finite ~-1.7e12 ms sample that sailed past the NaN guard and destroyed the control's saved mean. The seed is gone entirely: it also timed a draw of ZERO points |
| `shift()` at the sample cap | an O(n) memmove **on the pointer path** — closer to the hot path than anything the review filed. Now an amortised splice |
| stale `rect` on scroll | the page scrolls; a stroke surviving one was offset for its whole length |
| deferred React batch outliving its stroke | drew a line across the pad from the next stroke's origin. Batches are now stroke-scoped |
| inverted pressure sentinels | a device reporting no pressure saved a range of "1 to 0" |
| `observePointer`'s `seen` was optional | omitting it pinned `pressureDistinct` at 0 for ever, making Tier A silently unreachable |
| auto-generated `OPTIONS` | replied 204 + `Allow` to anyone, contradicting this route's own 404-never-403 rule |
| `JSON.parse("null")` | a valid-JSON non-object threw a TypeError -> 500 instead of 400 |
| migration | added `revoke all from anon, authenticated` (0079/0086/0093 pattern), an index on `teacher_id` (it is the sole filter AND the FK — unindexed it taxes account deletion elsewhere), and a `lock_timeout` so DDL on a live DB fails rather than queues |
| the gate | now takes the USER, not an address, so `email_confirmed_at` cannot be forgotten at a call site |

Two claims were correctly REFUTED and are worth recording: the missing `revoke`
was *not* a security hole (0080 and 0083 ship live tables in the same posture,
and RLS holds writes shut regardless — it is a consistency and defence-in-depth
fix), and the 1 Hz summariser's sorting does *not* corrupt `toDraw`, because
`t0` is the newest coalesced timestamp, so a main-thread stall lands in the
coalesced counts rather than in latency.

**0096 IS APPLIED** (production, 27 Aug 2026, ledger version `20260827035459`,
recorded as `present_probe`). Verified after the fact rather than trusted:
table present, RLS on, exactly one policy and it is SELECT-only, three indexes,
`anon`/`authenticated` grants **NONE**, FK `on delete set null`, and the route's
exact insert shape proven by an insert rolled back so the table stayed empty.
Supabase's security advisor raises **nothing** against it (the project's 151
existing lints are all pre-existing and unrelated).

`PRESENT_ALLOWED_EMAILS` is set in Vercel.

**The only thing left before the gate can be called:** run it on real panels —
including the worst one available, which is what defines Tier C.

## Phases (each gated by the one before)

| # | Phase | Gate |
|---|---|---|
| 0 | ✅ BUILT — Latency truth on every device reachable — capability report (recorded, not just shown), 4 draw strategies, pointer-to-paint p50/p95, 240 fps nib-gap check. Run it on the WORST device you can find, not only the best | Tier A hits one frame on the best device to hand; **Tier C is still judged usable on the worst**. If Tier C fails on hardware a school would plausibly own, that changes the product (native shell, or a stated minimum spec), not the schedule |
| 1 | The board as a library — `src/board/`, zero app imports (model, capabilities, ink, render, roll, export-pdf, store) + dev gallery | 500 strokes over 10 pages at 60 fps; model round-trips; two exports identical |
| 2 | Present mode in the app — `/present`, gate, context bar, kit rail + worksheet picker, stage, `present_items`, 0097, `/api/present/*` | A full mock lesson on the panel — including the part's worksheet, THEN a revision worksheet from another chapter, a mid-lesson refresh that loses nothing, and a last-taught pointer that did NOT move because of the revision paper |
| 3 | After the lesson — recap draft/edit/publish, roll to storage, student + absentee visibility | A published note that names the concept; a student account that can open both |
| 4 | One real period — instrument strokes, freezes, pushes, crashes, recap edit distance | Five consecutive periods with no fallback to the old way |

## Going public — the release steps that are easy to miss

The allowlist is a TEMPORARY gate: Present mode is being proven on one account
before it reaches teachers. Two things about that are not obvious from the code.

1. **The probe must not go public with Present mode.** `/present/probe` is a page
   of four canvases and latency percentiles — measurement scaffolding, useful to
   exactly one person for exactly one decision. It currently shares
   `presentAllowed()` with everything Present mode will add, so **the moment
   `PRESENT_ALLOWED_EMAILS` widens to a pilot group, the harness widens with
   it.** When Phase 0 closes: delete `src/app/present/probe/`,
   `src/app/preview/board-probe/`, `src/app/api/present/probe/` and drop the
   `present_probe` table. Keep `src/board/capabilities.ts` — that is the part
   that ships inside the board. Deleting is better than a second flag: a page
   with no users should not survive as a permanent thing to keep gated.
2. **Widening is a change of mechanism, not just of value.** An email allowlist
   is right for one tester and wrong for a cohort — it has no notion of plan,
   school or trial. The step after "my ID" is a per-school config key
   (`schools.config`, as calendar/notices/timetable already do) or a plan gate,
   with `PRESENT_ALLOWED_EMAILS` kept as the staff override. Nothing in the
   schema assumes one user: `present_*` rows are keyed by teacher and confined
   by RLS, and the capture tier is per-device.

Nothing else about Phase 0 is load-bearing for the public release.

## Out of scope

AI drawing on the board (TAL stays parked) · **test papers on the board**
(excluded on principle, not capability) · **generating a worksheet mid-lesson** · any video infrastructure (remote days
run on the school's Zoom via screen share) · student devices · slide-level video
navigation (no cue track exists) · multi-teacher rollout until Phase 4 reports
back.
