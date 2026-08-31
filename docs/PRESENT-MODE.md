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

~~Four stacked layers; only the wet-ink layer runs at pen rate.~~

**CORRECTED 27 Aug 2026 by the first run on real hardware. The stacked-layer
model is impossible.** It was:

    chrome     tool rail, push button, period clock      — normal React
    wet ink    stroke in progress                        — desynchronised canvas, no React
    dry ink    committed strokes                         — blitted on pointerup
    content    frozen frame | question | ERE SVG | blank

**A DESYNCHRONISED CANVAS CANNOT BE A TRANSPARENT OVERLAY.** To deliver its
latency, Chrome may promote the canvas to a low-latency overlay (a
DirectComposition swap chain on Windows), and an overlay is not blended with
the page behind it: every transparent pixel presents as BLACK. The bitmap lies
about this — `getContextAttributes()` reports `alpha: true` and a virgin pixel
reads `[0,0,0,0]` — so it is invisible to every check except looking at the
screen.

It is GPU/driver dependent, which is what makes it dangerous. It did NOT
reproduce in the dev browser. On the founder's Chrome 151 it turned both
desynchronised probe pads into black rectangles: one showing only the grey
antialiased fringe of a near-black stroke, the other showing nothing whatsoever
because a second desynchronised canvas stacked above it was opaque.

The desynchronised context is also the one worth having — 0.8ms input-to-draw
against 4.5ms plain and 6.4ms through React state. So the board keeps it and
changes shape around it:

**ONE opaque canvas.** Content, committed ink and the live stroke all go into
the same bitmap, bottom to top, and nothing is stacked above it:

    chrome        tool rail, push button, clock     — normal React, DOM, beside the canvas
    ─ one desynchronised, opaque canvas ────────────────────────────────
      wet ink     the live stroke + predicted lead
      dry ink     committed strokes
      content     frozen frame | question | ERE SVG | paper
    ─ offscreen (normal canvas, never displayed) ───────────────────────
      content + dry ink, kept to restore regions the wet stroke dirtied

Erasing the live stroke or the predicted lead is then a dirty-rect blit from the
offscreen backing store rather than a `clearRect` on a transparent layer. That
is more machinery than stacked canvases, and it is the only shape compatible
with a low-latency canvas.

Two rules fall out of this, and they hold on every platform, so the board follows
them rather than feature-detecting:

* **A desynchronised canvas must be opaque, by declaration and by paint.**
  Create it `alpha: false`, fill it with paper across the whole BITMAP (device
  pixels — filling in CSS pixels leaves a sub-pixel fringe when the bitmap size
  rounds up), and never `clearRect` it: clear it to paper.
* **Never stack another DESYNCHRONISED canvas above one** — this is the hard
  rule, and breaking it is what turned the prediction pad black. A transparent
  overlay on top is opaque, and it wins.
* **Prefer not to stack anything above one at all** — this is the soft rule, and
  it costs latency rather than correctness. A normal DOM element over a promoted
  canvas does not turn black; Chromium's occlusion handling either declines the
  promotion or makes it an underlay with the overlapping region punched through.
  So an overlapping toast or popover is safe to render and merely risks giving
  back the 3.7ms the promotion bought. Keep the tool rail beside the canvas, put
  content that belongs to the page into the bitmap, and treat anything that must
  float over the ink as a latency trade made on purpose.

  This distinction matters for Phase 2: the parked corner video, a worksheet
  popover and a confirm dialog are all ordinary DOM over the stage, and none of
  them is forbidden.

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

**First real run, 27 Aug** (laptop + mouse, so it does NOT move the Phase 0 gate).
Well-sampled and it settled the strategy question: input-to-draw p50 of **0.8ms
desynchronised** vs 4.5ms plain canvas vs 6.4ms through React state, and React
costs about a full frame end-to-end (23.1ms paint vs ~9.8ms). Two things to read
carefully in any run: a pad's percentiles mean nothing below n=50 (the UI marks
them), and **input-to-paint is not comparable across the desynchronised
boundary** — `afterPaint` is rAF-based and pinned to the compositor's frame
cadence, which is exactly what a desynchronised canvas is allowed to escape.
Compare input-to-draw across all four; compare input-to-paint only among the
non-desync pads.

The tier logic validated itself on that run: every static capability was green,
including `desynchronized`, but `pressureDistinct: 1` with min == max == 0.5 (a
mouse) correctly held it at Tier B with velocity width. A capability-only check
would have picked pressure-varied width on a device with no pressure sensor.

**And the screenshots caught what no number could** — see the corrected layer
model above. The winning strategy was rendering black.

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
| 1 | ✅ **DONE** — the board as a library: `src/board/` = capabilities · model · ink · render · roll · export-pdf · store, zero app imports, driven from `/preview/board` | ✅ **PASSED.** 500 strokes / 10 pages: repaint p50 **1.9ms**, p95 **3.6ms** against a 16.7ms frame. Model round-trips byte-identically; two exports are byte-identical |
| 2 | Present mode in the app — **BUILT** — 0097 applied, context resolver, `/present` with the bar, kit rail + worksheet picker, the stage, the session API (`session` / `sync` / `items`), and the board assembled behind it. ⚠️ **The gate below is UNRUN** — it needs a signed-in teacher and a panel. Access is now the PLAN (Pro / Pro+ / school), not the email allowlist. | A full mock lesson on the panel — including the part's worksheet, THEN a revision worksheet from another chapter, a mid-lesson refresh that loses nothing, and a last-taught pointer that did NOT move because of the revision paper |
| 3 | **BUILT** — after the lesson: recap draft/edit/publish (`/api/present/recap`), the roll exported and uploaded (`/api/present/roll`), and `/present/recap/[id]` for a student or parent. 0099 applied; all ten locales translated; reachable from a Board tab. ⚠️ **The gate below is UNRUN** — it needs a class, a student account and a published lesson. | A published note that names the concept; a student account that can open both |
| 4 | One real period — instrument strokes, freezes, pushes, crashes, recap edit distance | Five consecutive periods with no fallback to the old way |

## Phase 1 — done, and what it settled

`src/board/` is `capabilities` + `model` + `ink` + `render` + `roll` +
`export-pdf` + `store`, with `/preview/board` driving all of it from OUTSIDE the
library — which is the test of whether the boundary holds, not a demo.

**The gate passed with room to spare.** 500 strokes over 10 pages: a full page
repaint — what runs after every stroke ends — is p50 1.9ms and p95 3.6ms against
a 16.7ms frame, about four and a half times under budget. The worst single
sample was 25.3ms, one frame dropped right after a page wind, which is the cost
of a cold repaint rather than a steady-state problem. **The page-quantised design
is what buys this**: repaint is bounded by one page's fifty strokes, not by how
long the lesson ran, so the number does not grow through the period.

The store is local-first: the log is the truth and the roll is its fold, the same
shape as the server's `present_strokes` table, so client and server reconcile by
folding one sequence rather than diffing two snapshots. A failed flush KEEPS its
records and retries oldest-first — dropping them would let the local board and
the server disagree silently, and nobody would find out until a student opened a
lesson with holes in it. IndexedDB missing (private window, old WebView) falls
back to memory and reports `durable === false`, so a host can say the board will
not survive a reload rather than implying it will.

Three things the build settled that the plan had not:

* **The third number in a point is a WIDTH MULTIPLIER, not raw pressure**,
  resolved at capture time. Store the raw signal and a roll drawn on a
  pressureless panel carries 0.5 at every point and can never be re-rendered as
  it looked, and every renderer needs to know what drew it.
* **Redo needs its own stack.** Deriving it by scanning for the last voided
  stroke finds the one latest in APPEND order, not the one most recently voided:
  undo c, undo b, redo brought back c and left b voided.
* **One page is visible at a time, and the roll winds between them.** A
  half-visible page on a projector is worse than useless, memory stays constant
  however long the lesson ran, and the visible page is always the low-latency
  canvas. The slide is blitted INSIDE the one canvas, because nothing may be
  stacked above a desynchronised one.

**Export is VECTOR, and byte-identical across two runs** — the gate. Ink is
curves in the roll, so it is curves in the PDF: a two-page board with three
strokes is 3.8 KB and 18 paths, where a raster export would be hundreds of KB
and turn to mush the moment a student zoomed in. Byte-identity needed fixed
metadata: PDF writers stamp the current time into /CreationDate, which would make
every export of an unchanged board a different file. The first export pays for
pdf-lib's dynamic import (seconds, cold), so `warmExport()` exists for a host to
call when the lesson opens rather than at the bell.

And one rule worth carrying into every later animation: **never gate input on an
animation completing.** The first version refused strokes during the page slide;
`requestAnimationFrame` does not run in a hidden or non-compositing tab, so the
slide never finished and the board became permanently un-drawable. A pointerdown
now lands the slide and takes the stroke.

## Phase 2 so far

Migration **0097** is APPLIED (production, 27 Aug) — five tables: `present_sessions`,
`present_pages`, `present_strokes`, `present_items`, `present_last_taught`.
Student visibility is deliberately absent; every policy is the teacher reading
her own rows, and the roll reaches students in Phase 3 against a PUBLISHED recap
rather than a live board.

Two things the context bar settled:

* **The resolver runs on the CLIENT.** Vercel is UTC and the classroom is not; a
  period is a local-time fact, and the panel's own clock is the classroom's.
  A server-rendered "Period 3" would be wrong by eight hours in Malaysia.
* **The bar reports its own confidence** — `slot` (the timetable named this class
  and subject), `period` (a period is running but she teaches nothing in it), or
  `none` (no timetable, outside hours, or a non-teaching day). A guess must not
  look like a fact, and `none` is the permanent state of every independent
  teacher, so it has to look deliberate rather than broken.

**The kit rail shows what it will not do, and why.** A test paper appears in the
rail marked download-only rather than being hidden: she generated it, she knows
it exists, and a rail that silently omitted it would read as a bug and send her
looking for something that was working as intended. The note says "a paper the
class has watched is no longer a test", which teaches the rule once instead of
hiding it for ever. A lesson plan is also download-only, for a different reason —
no structured text to put on a board — and says so separately.

**Present mode signs artifact URLs for EIGHT hours, not one.** Every other
surface uses 3600s and is right to: a Library link is clicked seconds after it is
made. A classroom panel is woken at 07:00 and Period 6 is at 13:15, so a one-hour
URL would have expired by mid-morning and the video would fail in front of a
class with nothing on screen to say why. This is the "panel woken early" case the
plan flagged, and the fix is the TTL rather than a retry.

**The stage is one `<video>`, rendered unconditionally.** Not behind `src &&`,
not behind a mode check — only the style of its fixed container changes. The
moment a video is conditionally rendered into a different parent, React unmounts
it and it reloads from zero in front of the class. `away` translates it
off-screen at zero opacity rather than using `display: none`, because a browser
is within its rights to deprioritise or unload media that is not displayed.
Verified in `/preview/stage`: the same DOM node, and exactly one video, across
full -> corner -> away -> full.

**Freeze-frame needs CORS, and CORS needs the attribute.** Capturing a frame is
`drawImage(video)` into a canvas, and a canvas that has drawn a CROSS-ORIGIN
video is tainted — `toBlob` throws SecurityError. Checked against a real signed
URL rather than assumed: the artifacts bucket answers
`access-control-allow-origin: *` and honours Range (206). But the browser only
makes it a CORS request if `crossOrigin` is on the element BEFORE it loads, so
the attribute is in the JSX; assigning it after `src` has no effect. Verified end
to end: a 640x360 JPEG blob out of a real clip.

The resolver also owns `advancesPointer`, the rule the schema is shaped around:
only the slot's OWN video or kit worksheet may move `present_last_taught`.
A break belongs to the period AFTER it, because a teacher opening the board
during the interval is setting up for the next lesson; after the last period the
answer is null rather than the last period of the day, because pre-filling a
finished period would have her confirm something simply wrong.

**The pointer decision is made on the SERVER, at close.** The client knows what
it showed; the server decides what that means, reading `present_items` and
applying `advancesPointer`. A rule enforced in a browser holds only until
somebody writes a second client, and this is the rule the whole schema is shaped
around. Closing is idempotent: a panel that loses its network at the bell retries,
and the second attempt must neither fail nor advance the pointer twice.

**A void carries the sequence of the stroke it voids.** A stroke has two numbers
— the id the board minted and the seq the log assigned — and only the store knows
both. The first version of the sync route parsed one out of the other, which
works right up until the id format changes; the store now carries the link, and
rebuilds it on open so a stroke drawn before a reload can still be undone in a
way the server can match. A void with no target — possible when two devices'
logs merge — is dropped rather than guessed at.

## Phase 2's gate is UNRUN

The plan's gate is "a full mock lesson on the panel — including the part's
worksheet, THEN a revision worksheet from another chapter, a mid-lesson refresh
that loses nothing, and a last-taught pointer that did NOT move because of the
revision paper." None of that has been run: it needs a signed-in teacher, real
kits and a panel, and the pieces have only been verified individually —
element identity in `/preview/stage`, the roll and its export in
`/preview/board`, the resolver and the kit rules in unit tests, and every gate
by an unauthenticated request. **Phase 2 is built, not proven.**

## Phase 3 so far — what it settled

**The reader's right to a recap is not a property of the reader.** `presentAllowed()`
answers one question — may this account drive a board — about one operator-listed
address. A student is never on that list, has no email at all (student accounts
sign in with an ID), and adding one would hand them `/api/present/kit` and its
eight-hour signed URLs to every artifact the teacher owns. So the allowlist is
checked against the lesson's **author**, and the reader's right is three facts
ANDed (`src/utils/present/audience.ts`, unit-tested):

* the AUTHOR is allowlisted — the same shape the AI Tutor already uses, where the
  entitlement belongs to the lesson's owner rather than to the student asking;
* `recap_published_at` is set, and `recap_body` is served — never `recap_draft`,
  never the live ink of an open session;
* the reader is enrolled in the session's class, is a verified parent of someone
  who is, is the teacher, or is leadership of the session's school.

**0099 grants a student nothing, on purpose.** 0097 said student visibility would
arrive "through a later migration"; this is that migration and it still leaves
`revoke all ... from anon, authenticated` in place. An RLS policy filters ROWS,
not columns, and `recap_draft` sits in the same row as `recap_body` — so the
grant that let a student read the published note would also hand them the
sentence she deleted. The reader is served through the service role instead, with
every check RLS would have done done in code. That is the same doctrine as
`ownedSession()`, for the same reason: the service role is a key, not a policy.

**The ban is CHECKED, not requested.** "never 'played the video'" lives in the
prompt *and* in `cleanRecap()`, which names each rule broken so the one retry can
be told what to fix. Prompt compliance has already failed silently twice in this
product — a Gemini kit shipped SSML inside a field documented as clean text
because nothing checked. A second violation gets the fallback sentence, which is
built from the grounding and is a real sentence rather than an apology: she has
thirty seconds between periods and "drafting failed, try again" spends all of
them.

**The recap is grounded on `present_items`, and in practice on `source_text`.**
Measured on 2026-08-29: of 244 `chapter_grounding` rows, 235 carry `source_text`,
25 carry a title or concepts, 23 carry narration. So the book's own contents page
supplies the chapter name and the index-time text supplies the evidence; the
concepts path is real but rare. A recap that had required `concepts` would have
produced nothing on the founder's own book.

**A frozen frame is uploaded and the page stores its PATH.** This was a hole
under Phase 2 rather than a Phase 3 feature: `URL.createObjectURL` is meaningless
outside the tab that made it, so a page background holding one survived until the
panel closed and not one second longer — gone from a reload, gone from the PDF
(which never passed `image` at all), gone from anything a student could open. The
model already said `src` may be "a blob/object URL or a storage path", so the
durable value goes straight in and `board-session.tsx` resolves it: from the
local capture during the lesson, from a signed URL afterwards.

**Two more Phase 2 gaps closed by necessity.** `RollView` had no way to report a
page, so `BoardStore.addPage()` had zero call sites and `present_pages` was empty
for every session — a rebuilt roll would have been her annotations floating on
blank paper. And `voidStroke()` had zero call sites, so every stroke she undid
was still live on the server. Undos are now reconciled **at close**, as one
authoritative set, because the log has no un-void record and streaming each undo
would leave a tombstone for a stroke she brought back.

**The upload does not go through a route.** The board exports the PDF in the
browser and uploads it straight to the artifacts bucket with the teacher's own
session — the bucket carries exactly one policy,
`(storage.foldername(name))[1] = auth.uid()::text`, so she may write under her own
uid folder and nowhere else. `/api/present/roll` exists only to RECORD the path,
which it derives itself from the session row and confirms in storage before
writing, so `pdf_path` can never point at a file that failed to arrive. A
client-supplied path would be a client-supplied claim.

**The class is now pickable.** The bar took the class from the timetable, which
an independent teacher does not have — and a session with no class has nobody to
publish to. That refusal is enforced server-side (`checkPublish` →
`no-audience`), so the picker is what stops her meeting it at the bell with the
note already written. The warning is shown *before* she starts, not after.

**Three smaller things fixed in passing**, all inside this feature: `/api/present/{session,items,sync,kit}` had no `OPTIONS` handler, so Next answered 204 with an `Allow` header to any unauthenticated caller — an existence disclosure the probe route already guarded against; the kit route sorted multi-part videos by path string, and ICU collation puts `.` after `_`, so `lesson.mp4` (Part 1) sorted *behind* `lesson_part2.mp4`; and `checkPublish` refuses a body on an open session, so a note can never describe a lesson still being taught.

## Phase 3's gate is UNRUN

"A published note that names the concept; a student account that can open both."
Untestable on the founder's account as it stands: there is no school, no class,
no enrolled student, so `class_id` is null on every session and `checkPublish`
refuses — correctly. Running the gate means creating a class, adding one student
through `/api/students`, teaching a lesson with that class picked on the bar, and
opening `/present/recap/{id}` signed in as the student. **Phase 3 is built, not
proven** — the same status Phase 2 is still in.

**And the translation gap now matters.** The rest of Present mode is English-only
because it is behind a one-account allowlist. `/present/recap/[id]` is the first
Present surface with a real audience, and that audience is Malaysian and includes
RTL readers. It is a release blocker for widening the allowlist, not a nicety.

## The gate is the PLAN, since 29 Aug 2026

Founder's rule, verbatim: *"this board needs to be provided to every teacher,
regardless of school affiliation or not. the only gate for individual teachers
should be pro or pro+ subscription. schools get this by default."*

This is the "widening is a change of mechanism, not just of value" step the
section below used to describe as future work. `PRESENT_ALLOWED_EMAILS` was
right for proving a feature in front of one real class and wrong for a cohort:
an allowlist has no notion of plan, school or trial, and it cannot answer "has
this teacher paid".

**`plan_tier(uuid)` is the plan, and it is not re-derived.** The taxonomy already
lives in one SECURITY DEFINER function that resolves, in precedence order: a
school plan held by the school, the buyer's own plan, the launch promo, then
`trial`. `utils/present/access.ts` takes its answer and admits
`school | pro | pro_plus`.

**"Schools get this by default" means the school's PLAN, not the school FIELD.**
`plan_tier` returns `'school'` only when the account's school holds an *active*
school entitlement. A `profiles.school_id` with nothing paid behind it is a
person who was invited to a school, not a customer — reading it as entitlement
would have handed the board to 38 unbilled accounts.

**A plan is not a role, and here that is load-bearing rather than tidy.**
`plan_tier` returns `'school'` for *every* member of a paying school, students
included — it answers "what is bought for this account", which is a different
question from "may this account teach". Without the role check, the pupils of a
paying school could open their teacher's whiteboard. The check is a DENY list
(`student`, `parent`) rather than an allow list of teaching roles, because
"coordinator" is a scope grant in this schema and a real coordinator's
`profiles.role` is `teacher` — an allow list would have excluded every one of
them.

**`plan_tier` is EXECUTE-able by `service_role` only.** `authenticated` and
`anon` were never granted it, so every gate that consults it needs the admin
client, and a deployment without a service key fails closed to the override.

**The refusal is a sentence on `/present` and a bare 404 in the API.** A signed-in
teacher who followed a link we gave them deserves "the classroom board comes with
Pro, Pro+ and every school plan"; a stranger probing `/api/present/*` gets 404,
because a session id must never become an oracle for which lessons exist.

**A lapsed plan takes the published notes with it.** `authorAllowed()` asks the
entitlement question at READ time, so a teacher who stops paying stops publishing
to her class. That is intended: notes that outlived the plan would be a surface
nobody could switch off, and keying on a per-note flag would leave rows to go
stale.

### Measured the day it shipped

`0` accounts gain access. Every one of the 78 teachers resolves to `trial` or
`family`; neither of the two schools holds an active school plan; the single
active entitlement in the system is one `family_monthly`. **The gate is correct
and currently inert** — it will admit its first teacher on the first Pro
subscription, and its first school on the first school plan. The founder's own
account is `trial`, which is why the override was kept rather than deleted.

### Translated into all ten locales, 29 Aug 2026

132 keys under `present.*` plus `nav.tabs.board`, in every one of the ten
locales. The message-catalogue suite passes all 58 assertions on it: coverage,
placeholders, no empty values, no bidi controls, the identical-prose ratio, and
both Jawi checks (70% of Jawi values carry a Jawi-only letter; exactly one value
matches Arabic, the `{n} / {total}` format string). No key went onto
`PENDING_TRANSLATION` — the round shipped with the feature.

**The pure modules stopped composing prose, and that was the actual work.**
`kit.ts` built an English `label` from a generation kind, `"Part 1 of 4"`,
`"Chapter 4 · Part 2"`, `"This part"`, and a sentence explaining why a test paper
only downloads. `audience.ts` and `access.ts` each carried a map of refusal
sentences. All of it ran on the server and reached a page that now renders in ten
languages. They return **places, kinds and reason codes**; `app/present/words.ts`
is the one file that turns them into words, shared by the pre-lesson rail and the
running board so two renderings of the same unit cannot disagree about whether it
is "Part 2" or "Part 2 of 4".

The API routes send `reason` codes and the UI renders `present.publish.<reason>`;
the English `error` survives only as the fallback for a code the build has never
seen. Sorting moved with the labels: the rail sorted docs by LABEL, which would
have reordered itself per language, and now sorts by kind.

**The recap draft is generated in her language.** It is the one piece of prose
this product WRITES rather than displays, so `fallbackRecap` composes from words
handed in and the prompt carries a "write in {language}" rule. ⚠️ **The
banned-machinery check is English regexes**, so in another language it is weaker
than it looks — "lembaran kerja" is not "worksheet". It is not nothing: the
prompt rule applies in any language, untranslated English machinery words are
still caught, and the note is a draft she reads before publishing. Extending the
ban per locale is the honest next step.

**Two things the translators found that the English had wrong.** The Malay
translator read `board-session.tsx` and discovered that "PUSH" — the roll
metaphor — appends a blank page; eight of the nine had rendered it as "send",
because nothing on the button says which. It is "NEW PAGE" now, in all ten. And
"Blank board" in the left rail calls exactly the same thing with the same
argument: **two controls, one behaviour**, which is a product call still open.

⚠️ **Arabic has dual and plural forms a flat `{n}` template cannot express**, so
"{n} parts" reads naturally for 3–10 and slightly off for 2 and 11+. Only ICU
plural categories would fix it; this catalogue has none, and the house pattern is
a `...One`/`...Many` pair, used wherever the count is one-versus-many.

### The way in

`/present` had no nav entry at all — URL-only while it was secret, which made
"provided to every teacher" untrue in practice. There is a **Board** tab now,
**teacher hat only**: the board is a surface you stand at, and a principal in
Leadership mode is not teaching a period. It is gated on the same entitlement as
the page itself, because a tab leading somewhere you would be turned away from is
an invitation to be refused on every page load.

## What the allowlist still does

`PRESENT_ALLOWED_EMAILS` was kept, not deleted, for two reasons.

1. **Staff reach the board without buying it.** The founder's account resolves to
   `trial`; without the override, shipping the plan gate would have locked the
   only person testing the feature out of it.
2. **The probe stays behind it, alone.** `/present/probe`,
   `/api/present/probe` and `/preview/board-probe` are a four-canvas latency
   harness useful to exactly one person. The danger this section used to warn
   about — "the moment `PRESENT_ALLOWED_EMAILS` widens to a pilot group, the
   harness widens with it" — is now gone *by construction*, because the board no
   longer reads that variable. **So the probe no longer has to be deleted to stay
   private**, and it can survive until the Phase 0 panel gate has actually been
   run. Delete it when that gate closes, not before. Keep
   `src/board/capabilities.ts` either way — that ships inside the real board.

## Out of scope

AI drawing on the board (TAL stays parked) · **test papers on the board**
(excluded on principle, not capability) · **generating a worksheet mid-lesson** · any video infrastructure (remote days
run on the school's Zoom via screen share) · student devices · slide-level video
navigation (no cue track exists) · multi-teacher rollout until Phase 4 reports
back.
