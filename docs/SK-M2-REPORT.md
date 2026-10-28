# SK spike M2 — the Classroom Board driven by code

Date: 2026-10-28. Branch `spike/sk-m2-board` off `origin/main` `9991ad5`. Plan reference:
*SketchCast SK Assistant — Final Plan* §2.4, §2.5, §5.3, §6 (M2 row), §9.6.

**Result: PASS.** Every existing Board control the plan names is callable from one function
object. Five segment boundaries (both edges) land within 150 ms. The Board's own tests show no
regressions. One gap blocks shipping the move log as specified: `present_items` rejects
`kind = 'sk_move'` (details below).

## What was built

| File | What it is |
|---|---|
| `src/app/present/board-controller.ts` | `createBoardController(ports, logger, opts)`: the typed `BoardController`, `segmentTarget()`, and `itemsRouteLogger()` |
| `src/app/present/board-session.tsx` | Two additive changes and no visual change. (1) A `BoardIO` network seam: the default is byte-for-byte the old fetch/storage calls, and a host may inject its own. (2) Optional `controllerRef` and `moveLogger` props, registered with `useImperativeHandle`. `freeze()` and `end()` now return a boolean (the buttons ignore it). `playVideo` now awaits `play()`. |
| `src/app/present/__tests__/board-controller.test.ts` | 18 unit tests with a fake video that seeks asynchronously and snaps to 24 fps frames |
| `src/app/dev/sk-board/{page,harness-client}.tsx`, `video/route.ts` | A dev-only harness. It mounts the **real** `BoardSession` (stage, roll, store, wrap-up) with an in-memory `BoardIO`, a local mp4 streamed with Range support, and `window.__skBoard` / `window.__skM2.run()`. It returns `notFound()` / 404 unless `NODE_ENV === "development"`. It also intercepts every `/api/*` fetch on the page, answers it locally with 404 and records it, so nothing reaches a server. |

## Controller API

```ts
type BoardController = {
  play(): Promise<void>;                 // the ▶ button: stage -> full, play, record the video item
  pause(): void;
  seek(t: number): Promise<number>;      // resolves on `seeked`, returns the landed currentTime
  seekMeasured(t: number): Promise<SeekResult>;            // { landed, target, errorMs, latencyMs }
  seekSegment(k, edge: "start" | "end", manifest): Promise<SeekResult>;
  freeze(): Promise<boolean>;            // tap-to-freeze: pause, capture, frame page on the roll
  openWorksheetPage(): boolean;          // the unit's first projectable worksheet as a page
  blankPage(): void;
  pageUp(): void; pageDown(): void;      // clamp at the ends
  getState(): BoardState;                // sessionId, t, duration, paused, stageMode, page, pageCount, ended, moves[]
  endSession(): Promise<boolean>;        // End lesson: tombstones, PDF, close; later moves refuse
};
```

The ports call the **same callbacks the buttons call** (`playVideo`, `freeze`, `openWorksheet`,
`push`, `goTo`, `end`), so a move made by voice and a move made by a finger run the same code.
Every call, successful or not, appends
`{ kind: "sk_move", move, args, ok, result?, error?, at, ms }` through the injected logger. A
logger that throws or rejects never fails the move it records.

**Segment edges.** `start` = `start_s + 0.03 s`; `end` = `end_s − 0.10 s`. Both values are
measured, not guessed. On the test kit every segment boundary is a keyframe, but each one sits
**6–26 ms after** its `start_s` (the stream's first pts is 0.023 s). Aiming at `start_s` exactly
therefore shows the *previous* segment's last frame, and aiming at `end_s` shows the *next*
segment's first frame. `slide(k)` needs `end`.

## Measurements

Kit: `ce611ebb-4481-424a-b545-a7086e2cea30` ("Inheritance and Variation"), `lesson.mp4`
826.56 s, 1280×720 H.264 at 24 fps, 18 script segments (the boundaries are cumulative
`clip_duration_seconds` from `script.json`, total 826.55 s). Keyframe interval: **10.417 s GOP**
(88 keyframes), plus a forced keyframe at every segment boundary. Browser: the Claude Browser pane
(Chromium), dev server `next dev --webpack`, video served from localhost with Range.

### Seeks (final run, video already loaded)

| k | edge | target s | landed s | error ms | time to `seeked` ms |
|---|---|---|---|---|---|
| 1 | start | 26.360 | 26.360 | 0 | 5 |
| 4 | start | 145.450 | 145.450 | 0 | 92 |
| 9 | start | 416.160 | 416.160 | 0 | 132 |
| 13 | start | 674.750 | 674.750 | 0 | 84 |
| 17 | start | 812.540 | 812.540 | 0 | 144 |
| 1 | end | 56.360 | 56.360 | 0 | 203 |
| 4 | end | 200.700 | 200.700 | 0 | 251 |
| 9 | end | 473.280 | 473.280 | 0 | 342 |
| 13 | end | 721.790 | 721.790 | 0 | 401 |
| 17 | end | 826.450 | 826.450 | 0 | 219 |
| — | time | 123.456 | 123.456 | 0 | 239 |
| — | time, while playing | 300.000 | 300.0005 | 0.5 | 465 |

**Reading the error column honestly.** Chromium reports the requested position as `currentTime`
after a paused seek, so "landed − target" is 0 by construction. The frame actually *shown* is the
one whose display interval contains the target, so the true visual error is **at most one frame
(41.7 ms at 24 fps)**. That is inside the 150 ms bar with room to spare, and the edge offsets above
make that frame the right one. A presented-frame check (`requestVideoFrameCallback.mediaTime`)
could not run, because the Browser pane was hidden and does not composite video. That check is the
one to add on a real panel.

**Latency.** The table above is a warm run: 5–465 ms to `seeked`, median about 210 ms. On a
**cold** load (a fresh page, segments never buffered) the same five start seeks took **387–2,653
ms**, and one warm repeat spiked to 1.5 s. A seek is a network range fetch from the nearest
keyframe, up to 10.4 s of GOP away. Over the artifacts bucket on school Wi-Fi it will be slower than
over localhost. S1 must show "moving to slide k…" rather than assume the jump is instant.
Shortening the GOP in the worker (for example `-g 48`) would cut both the decode and the fetch.

### Other controls (both runs, real Board in the harness)

| Control | Result | Evidence |
|---|---|---|
| session open | PASS | session id present, 1 page, not ended |
| play | PASS | t 0 → 0.70 s, stage `full` (element muted by the harness; autoplay policy refuses unmuted scripted play) |
| pause / pause holds | PASS | paused, 0.000 s drift over 500 ms |
| resume | PASS | t 0.70 → 1.52 |
| freeze → roll page +1 | PASS | pages 1 → 2, stage `corner`, frame JPEG (~80 KB) "uploaded" to the sink at the real `framePath` |
| worksheet page push | PASS | pages 2 → 3, stage `away`, `worksheet` item recorded |
| blank page | PASS | pages 3 → 4, wound to page 4 |
| page up / page down | PASS | 4 → 3 → 4 |
| session close | PASS | `close(4)` called once; roll PDF (~82 KB) built and "uploaded"; `recordRoll` called; the wrap-up mounted |
| every move logged as `sk_move` | PASS | 25 moves, 25 in the sink, 0 failed |
| no network | PASS | the only `/api` calls were `POST /api/attribution` (site-wide) and 2× `POST /api/present/recap` (wrap-up), all answered locally |

### Tests

| Run | Board suites (`src/app/present src/utils/present src/board`) | `tsc --noEmit` |
|---|---|---|
| Before (untouched `9991ad5`) | 6 files, **122/122 pass**, exit 0 | exit 2, **15 errors** |
| After | 7 files, **140/140 pass** (122 + 18 new), exit 0 | exit 2, **the same 15 errors**, identical list |

All 15 `tsc` errors were already there before the change. They are packages missing from the
local `node_modules` (`opentype.js`, `@aws-sdk/*`, `@anthropic-ai/bedrock-sdk`,
`@vercel/oidc-aws-credentials-provider`), plus the implicit-`any` errors those cause. None of them
are in a file this spike touches. ESLint is clean on every changed file.

## Findings that matter for S1

1. **`sk_move` cannot be logged to `present_items` today.** Both the route's `KINDS` set
   (`video | worksheet | blank`) and the live constraint `present_items_kind_check` reject it.
   `itemsRouteLogger` is wired, but a post to it would answer 400. Before S1 there are two options.
   One is to widen the check (a migration) and add the kind to the route. The other is to log to
   the plan's own audit table (§2.5, `kind: "board"`). Prefer the audit table: `present_items`
   feeds the recap and the class pointer, so a stream of seeks there would be noise in exactly
   the evidence the recap reads.
2. **`play()` = the ▶ button, so it records a `video` item every time.** Three plays produced three
   `video` items. The Board's own "Resume video" button does not record one. S1 should map
   "carry on" to a resume port (or de-duplicate the item per unit) so the recap is not inflated.
3. **Scripted play needs a gesture or `muted`.** On a real panel the teacher's first tap
   (Start the board) is the gesture, so this probably does not bite. A voice-only start should
   still be tested.
4. **Seek latency, not accuracy, is the risk** (see above).
5. `pageCount` is read from the roll itself, because the Board's `where` state follows push by
   one render. The controller already handles this.

## What the Board cannot do (no port exists to call)

- **No slide deck.** The Board shows the video, frame pages, worksheet title pages and blank
  pages. `slide(k)` is only possible as "seek to the end frame of segment k and pause", which is
  §5.3's design. There is no deck renderer and no slide-image page.
- **No zoom or pan** on the stage or on a page, and **no laser pointer or spotlight**.
- **No reveal/step-through** of worksheet questions. A worksheet page is one `question`
  background holding the doc's *label*, not its questions. `practise(n)` and `walkthrough` need a
  new page kind that carries real item text.
- **No unit switch from code beyond the first unit.** `openUnit(key)` exists but is not exposed.
  Exposing it is a one-line port.
- **No programmatic ink or annotation** (strokes come only from pointer events), **no undo/redo or
  tool select** through the controller (they exist on `RollHandle` and are trivially portable),
  **no export-PDF port**, and **no picker items** (other worksheets or revision papers).
- **No "play to the end of segment k and pause".** The video plays to the end. `segment(k)` needs
  a `timeupdate` / `requestVideoFrameCallback` stop at `end_s − ε`. It can be built on this
  controller without touching the Board.
- **No stage-mode control** other than what play, freeze and worksheet imply.

## Can a voice-driven S1 build on it unchanged?

**Yes for the Board surface, with one change elsewhere.** Every move in §2.4 that maps to a Board
control (`intro`, `slide(k)`, `freeze`, `blank`, `back`, page navigation, end) works through this
controller as it stands. The missing moves (`segment(k)`'s stop at the end, and `practise(n)`) are
additions on top of the controller, not changes to it. The one change S1 cannot avoid is **where
`sk_move` is logged** (finding 1). As shipped, the real page's default logger would be refused by
the database. That is a migration, or the audit table, and it is outside the Board.

## Running the harness

```
# .env.local in the worktree (git-ignored):
SK_M2_VIDEO_PATH=<dir>\lesson.mp4
SK_M2_MANIFEST_PATH=<dir>\manifest.json      # { "segments": [{ "start_s", "end_s" }] }
node node_modules/next/dist/bin/next dev --webpack -p 3221
# open http://localhost:3221/dev/sk-board, then in the console:
await window.__skM2.run()          # the full sequence above; the result also renders on the page
window.__skBoard.controller        # drive moves by hand
```
