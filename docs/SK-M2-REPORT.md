# SK spike M2 — the Classroom Board driven by code

Date: 2026-10-28. Branch `spike/sk-m2-board` off `origin/main` `9991ad5`. Plan reference:
*SketchCast SK Assistant — Final Plan* §2.4, §2.5, §5.3, §6 (M2 row), §9.6.
Revision 2 applies the founder's seven corrections (listed at the end).

**Result: PASS, with one measurement still open.**

- Every Board control the plan names can be called from one typed controller.
- Seeks land on target; the browser reports the requested position after every seek.
- `slide(k)` follows the manifest's visual verdict.
- A question set from the kit shows as real board pages.
- The Board's own tests are unchanged and green.
- **Not yet confirmed:** the frame actually on screen (`requestVideoFrameCallback`). The Browser pane in this session does not render frames at all; even `requestAnimationFrame` never fires. The code records the displayed frame wherever a browser does render. The ready-to-run script is at the end of this report.

## What was built

| File | What it is |
|---|---|
| `src/app/present/board-controller.ts` | `createBoardController(ports, sink, opts)`; the `SkActionRecord` / `SkActionSink` / `MemorySkActionSink` audit types; the manifest contract (`ManifestSegment.visual`); `segmentTarget`, `slideTime`, `slidePlan`, `captionCard`. **No network code.** |
| `src/app/present/text-card.ts` | One renderer for text pages (a kit question, or a slide caption): `questionCards`, `layoutCard`, `drawCard`, `cardPng`. Answers stay in a separate in-memory map. |
| `src/board/model.ts` | A new page background `{ kind: "card", card: TextCard }`, with a strict parser. Every other kind is unchanged. |
| `src/app/present/board-session.tsx` | Changes that only add, and change no existing control: <br>• a `BoardIO` seam (the default is byte-for-byte the network calls on main); <br>• optional `controllerRef` / `skSink` props; <br>• card pages drawn on the canvas and exported as images; <br>• "Moving…" while a seek is under way; <br>• on a question page only: previous / next / show-answer buttons in the right rail. |
| `src/app/present/stage.tsx` | An optional `status` prop, shown as a small chip over the video. Nothing renders when it is null. |
| `src/app/api/present/kit/route.ts` | Adds a read-only `questions` signed URL to each **projectable** doc. It uses the same admin signing and 8 h TTL as the video, and the same owner-scoped generations. |
| `src/i18n/messages/*.json` | Ten `present.board` keys, translated into all ten locales. |
| `src/app/dev/sk-board/**` | A dev-only harness: page, `video` route (Range), `questions` route, guard tests. |
| Tests | `board-controller.test.ts` (27), `text-card.test.ts` (8), `board-session-default.test.ts` (4), `dev/sk-board/__tests__/guard.test.ts` (5). |

## Controller API

```ts
play(): Promise<void>          // the ▶ button: stage full, play, records a `video` item (as the button does)
resume(): Promise<void>        // the Resume button: stage full, play, records NO item
pause(): void
seek(t): Promise<number>       // resolves after `seeked` AND the displayed frame (or a 1.5 s give-up); landed currentTime
seekMeasured(t): Promise<SeekResult>   // { target, landed, errorMs, latencyMs, presentedMediaTime, frameErrorMs, frameLatencyMs }
seekSegment(k, "start"|"end", manifest): Promise<SeekResult>
slide(k, manifest): Promise<{ shown: "frame"|"fallback_frame"|"caption"; shownK; reason; seek? }>
freeze(): Promise<boolean>     // tap-to-freeze: frame page on the roll
openWorksheetPage(): boolean
blankPage(): void
pageUp(): void; pageDown(): void
showQuestions(start?): Promise<{ index; total }>   // the unit's real questions, one roll page each
nextQuestion() / prevQuestion(): Promise<{ index; total }>  // revisits wind to the existing page
getState(): { sessionId, t, duration, paused, moving, stageMode, page, pageCount, ended, questions, actions }
endSession(): Promise<boolean>
```

### Audit records: `sk_actions`, kept in memory

Every call, whether it succeeds or fails, produces one record:

```ts
{
  actor_id, action: "board.seek" | …, tier: "immediate", kind: "board",
  params, ok, result?, error?, session_id, generation_id, at: ISO, ms
}
```

The record goes to an `SkActionSink`.

- **Real page:** when no `skSink` is passed, the default is `MemorySkActionSink`, a buffer in the tab. It makes **no network call**; the `sk_actions` migration lands in S0 and needs the founder's go-ahead.
- **Harness:** uses the same in-memory sink.
- **`present_items`:** its route, its kinds (video / worksheet / blank) and the recap are unchanged from main.
- **Two SK moves still write a `present_items` row**, because the buttons they mirror do:
  - `play()` writes `video`;
  - `showQuestions()` writes `worksheet` (once per set).
- A sink that throws never fails the move.

**Segment edges** (measured on the test kit). The worker forces a keyframe at each boundary, 6–26 ms after `start_s`.

| Edge | Target | Why |
|---|---|---|
| `start` | `start_s + 0.03` | lands on the segment's own first frame |
| `end` | `end_s − 0.10` | stays on the completed slide, before the next segment's first frame |
| `slide(k)` | manifest `slide_t` when present (M1 uses `end_s − 0.062`) | |

### `slide(k)` and the visual verdict

| Verdict | What the Board shows |
|---|---|
| `show: "frame"` and status `distinct` / `reused_relevant` | Seek to segment k's `slide_t`, pause, stage full |
| `show: "fallback_frame"` with a valid `fallback_k`, **and** that segment's own verdict is a trusted frame | Seek to the fallback's `slide_t`, pause; returns `shownK = fallback_k` |
| `caption_only`, `unknown`, no verdict, `frame` marked `misleading`, or a fallback that points at a misleading or unknown frame | **No seek.** Push a caption card (heading and points as text). Stage away. |

The rule is applied in the pure function `slidePlan` and tested on every path. A misleading frame can never appear under another segment's heading.

### Question pages

- **Data.** `questions.json` (`RawQuiz`) becomes one `TextCard` per question: prompt, lettered options for mcq, marks, and "Question n of N".
  - match items show the left side in key order and the right side sorted, so the key's order is not shown.
  - Malformed items are skipped.
- **Answers.** They go into an in-memory map keyed `generationId:questionId`. **No answer is ever stored in the page background.** Backgrounds are persisted to `present_pages` (which has no kind check) and exported to the PDF a student can open.
  - A teacher-only **Show answer / Hide answer** toggle draws the answer on screen only.
  - The PDF never contains answers.
- **Board plumbing.** Each question is its own roll page, so pen, highlighter, eraser, undo/redo, page up/down and the store work unchanged.
- **PDF export.** Card pages are exported as **PNG images**, not pdf-lib text. The export's built-in font is WinAnsi-only and would throw on Hindi.
  - Proven: an 8-page roll with Hindi caption and question pages exported to a 132 KB, 8-page PDF.
- **Where the client gets the file:** the `questions` signed URL that `/api/present/kit` now returns for projectable worksheets only.

## Measurements (Browser pane, real kit)

Test kit: `ce611ebb-…` "Inheritance and Variation" (Hindi).

- `lesson.mp4`: 826.56 s, 1280×720 H.264 at 24 fps.
- 18 segments; the manifest is built from `script.json`, including `slide_t`, `slide_heading` and `slide_points`.
- Keyframes: a 10.417 s GOP (88 keyframes), plus one forced at every boundary.
- Questions: the real `worksheet_questions.json` of the same catalogue kit, `c36772f8-…`: 10 items (fill_blank, true_false, short, match).

### Seeks: 10 boundaries, two passes

`currentTime` landed exactly on target in all 20 seeks (error 0 ms). `moving` was true during every seek and false after it.

| k | edge | target s | time to `seeked`, first pass (ms) | time to `seeked`, second pass (ms) | displayed `mediaTime` |
|---|---|---|---|---|---|
| 1 | start | 26.360 | 19.8 | 12.1 | not measurable here |
| 4 | start | 145.450 | 63.7 | 9.8 | not measurable here |
| 9 | start | 416.160 | 51.6 | 11.1 | not measurable here |
| 13 | start | 674.750 | 59.5 | 14.1 | not measurable here |
| 17 | start | 812.540 | 78.6 | 19.3 | not measurable here |
| 1 | end | 56.360 | 223.3 | 227.6 | not measurable here |
| 4 | end | 200.700 | 121.7 | 65.6 | not measurable here |
| 9 | end | 473.280 | 210.7 | 136.5 | not measurable here |
| 13 | end | 721.790 | 176.4 | 1,367.8 | not measurable here |
| 17 | end | 826.450 | 126.8 | 1,704.3 | not measurable here |

- **Earlier fresh-load run (revision 1):** the start seeks took 387–2,653 ms to `seeked`. A seek fetches from the nearest keyframe, up to 10.4 s of video away.
- **"First pass" is not a guaranteed cold cache.** The same file had already been loaded in this browser profile, even though the dev route sends `no-store`.
- **The displayed frame (rVFC) could not be measured.** The tab was brought to the front (`tabs_select`), and `document.visibilityState` is `visible`. Even so, neither `requestVideoFrameCallback` nor `requestAnimationFrame` fires: the hidden pane renders no frames at all. Each seek therefore waited out its 1.5 s frame give-up and recorded `presentedMediaTime: null`.
  - The unit tests prove that this null path reports honestly.
  - Expected visual error is at most one frame (41.7 ms at 24 fps), but this is **unconfirmed** until the script below runs in a visible pane.

### Controls (`window.__skM2.run()`, final code)

| Control | Result | Evidence |
|---|---|---|
| Session open | PASS | |
| `play` | PASS | `video` items 0→1, stage `full` |
| Pause / pause holds | PASS | 0.000 s drift |
| `resume` | PASS | **no item** (video items stayed at 1) |
| `slide` frame (k=2) | PASS | t = `slide_t` = 94.688, paused, stage full |
| `slide` fallback (k=4 → 2) | PASS | `shownK` 2; segment 4's own frame not shown |
| `slide` caption (k=6 misleading, k=8 no verdict) | PASS | +1 page each, stage away, Hindi heading on the card |
| Freeze | PASS | pages +1 |
| Worksheet page / blank page / page up / page down | PASS | |
| Show questions | PASS | question 1/10, +1 page, one `worksheet` item, Show-answer button present |
| Answer toggle | PASS | hidden by default, then shown, then hidden again |
| Next / previous question | PASS | next adds a page; previous winds back; next again reuses the page |
| Session close + PDF | PASS | `close(8)`; PDF 132 KB with **8 pages = 8 roll pages** |
| Every move recorded as an `sk_actions` row | PASS | 39 actions, 39 in the sink, 0 failed |
| No `/api/present/items` call made by SK | PASS | the only `/api` calls were `POST /api/attribution` and 2× `POST /api/present/recap`, all intercepted locally |
| "Moving…" indicator | PASS | `[role=status]` reads "Moving…" during a seek and is gone after it |

### Tests

| Run | Board suites (`src/app/present src/utils/present src/board`) | `tsc --noEmit` |
|---|---|---|
| Before (untouched `9991ad5`) | 6 files, **122/122**, exit 0 | exit 2, 15 errors |
| After revision 2 | 9 files, **161/161** (the 122 originals plus 39 new), exit 0 | exit 2, **the same 15 errors**, identical list |
| Also run | `src/app/dev/sk-board`, `src/i18n` (the locale set checks), `present-kit.test.ts`: 5 files, **117/117**, exit 0 | |

The 15 `tsc` errors were present before this work. They come from packages missing in the local `node_modules` (`opentype.js`, `@aws-sdk/*`, `@anthropic-ai/bedrock-sdk`, `@vercel/oidc-aws-credentials-provider`), plus the implicit-`any` errors those cause. ESLint is clean on every changed file.

**The Board without SK is the Board on main.** `board-session-default.test.ts` checks two things:

- Rendering `BoardSession` with no SK props shows every original control, no SK text, and makes **no** fetch.
- `defaultIO` makes exactly the calls main makes, in URL, method and body:
  - `POST /api/present/sync`, `POST /api/present/items`, `POST /api/present/roll`, `PATCH /api/present/session`;
  - artifacts-bucket signing (8 h) and upserts;
  - the same failure behaviour.

## Production exclusion

| Check | How it is enforced |
|---|---|
| Harness page refuses outside dev | `src/app/dev/sk-board/page.tsx` calls `notFound()` unless `NODE_ENV === "development"` |
| `video` and `questions` routes refuse outside dev | they return 404 unless `NODE_ENV === "development"` |
| Proven under `production` and `test` | `guard.test.ts` runs both, with the paths configured |
| No leaks outside the folder | the same test proves no file outside the folder names `SK_M2_*` or `/dev/sk-board` |

No production build was run here (the orchestrator runs it on an integration branch).

## What the Board still cannot do

- No zoom, pan, laser or spotlight.
- No "play segment k, then stop at its end" yet. It can be built on the controller without changing the Board.
- No drawing from code.
- No unit switch, PDF export or picker items through the controller (one-line ports each).
- Question pages show one question per page. The answer marks nothing; there is no student response capture on the Board.
- The match-question layout is a plain two-list text layout.

## Can a voice-driven S1 build on it unchanged?

**Yes.** Every Board move in §2.4 maps onto this controller:

- `intro` → `play`
- `slide(k)` → `slide`
- `practise` / `walkthrough` → `showQuestions` / `next` / `prev`
- freeze, blank, back → their ports
- end → `endSession`

The audit records already have the `sk_actions` shape. S0's only job for M2 is to create that table and a sink that writes to it; the Board side needs no change.

## The open measurement: script to run in a visible pane

The harness is `http://localhost:<port>/dev/sk-board`. The launch entry is `sk-m2-board`; the port is 3222 when 3221 is taken. Load it fresh, then run in two calls.

Call 1 (cold):

```js
for (let i = 0; i < 300 && !(window.__skBoard && window.__skM2); i++) await new Promise(r => setTimeout(r, 200));
const c = window.__skBoard.controller; await c.resume(); await new Promise(r => setTimeout(r, 500)); c.pause();
window.__cold = await window.__skM2.seeks("cold");
JSON.stringify(window.__cold.map(s => [s.k, s.edge, s.target, s.mediaTime, s.frameErrorMs, s.seekedMs, s.frameMs]))
```

Call 2 (warm):

```js
window.__warm = await window.__skM2.seeks("warm");
JSON.stringify(window.__warm.map(s => [s.k, s.edge, s.target, s.mediaTime, s.frameErrorMs, s.seekedMs, s.frameMs]))
```

In each row:

- `mediaTime` is the first displayed frame's media time.
- `frameErrorMs` is |mediaTime − target|; the pass bar is ≤ 150.
- `frameMs` is the time from the request to the displayed frame.

**`mediaTime: null` means the pane is still not rendering.**

## Revision 2: the founder's corrections

| # | Correction | Status |
|---|---|---|
| 1 | `sk_actions` record type and an in-memory sink; no default posting to `/api/present/items` | done; tested (no fetch, and the controller source names no endpoint) |
| 2 | `play` and `resume` split | done; tested and measured |
| 3 | `state.moving`, the "Moving…" indicator, and displayed-frame measurement | done. The measurement is blocked by the hidden pane; script above. |
| 4 | Visual verdict contract and `slide(k)` | done; all paths tested |
| 5 | Question pages from the real `questions.json`, answers hidden, previous/next | done; tested; exercised with the real kit file |
| 6 | Board identical with no SK props | done; tested |
| 7 | Production exclusion | done; tested |
