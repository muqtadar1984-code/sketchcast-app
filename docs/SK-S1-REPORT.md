# SK S1 board spike — report (interim)

Status 2026-10-26: **Option E built and measured on the U4 unit; Option S not yet built.**
No go/no-go is called until both options have been run on the founder's machine
and a mid-range Android phone (plan §5.3). Nothing here is production code: the
harness lives at `/dev/sk-spike`, which returns 404 on a production build.

## What was built

| Piece | Where | Notes |
|---|---|---|
| U4 fixture | `tools/sk-s1/make_fixture.py` → `public/sk-s1/u4/` | Narration = sentences from `ch02-draft.json` §s5 (no invented science); Edge TTS with **exact word marks** (free); the production ink asset `light_microscope` (visual_assets `c0cf7bbe…`, 10 labelled regions) with its drawing order from the worker's own `scene_engine.trace.drawing_order`; cues pinned to word indexes (183 words), resolved to absolute ms — what ERE's `schedule()` hands a renderer |
| Option E engine | `src/app/dev/sk-spike/engine.ts` (+6 unit tests) | Pure: asset→board mapping, trace sampling with pen lifts, checkpoint rule, handwriting glyph schedule |
| Option E runtime | `src/app/dev/sk-spike/runtime.ts` | One clock (`<audio>`); every board animation is a **paused Web Animation scrubbed from the audio each frame**; DOM via `createElementNS`/`textContent` only; raster reveal = SVG mask stroked along the drawing-order path (`pathLength=1`, dashoffset), finished by a whole-ink step; handwriting = Caveat glyph outlines (opentype.js) traced then filled; labels with leaders; highlight circle/strike; aside layer; checkpoint to `localStorage`; avatar stub (mouth from word marks; point/write/listen gestures) |
| Harness | `src/app/dev/sk-spike/page.tsx`, `player.tsx` | Play/Pause/Interrupt(Space)/Reload/Measurements (JSON download); `window.__skRuntime` for scripted runs |

## Measured (Option E, 2026-10-26, in-app browser pane — a *background* page, so fps/frame-gap numbers are NOT representative; re-run fronted on the founder's machine)

| §5.3 measure | Pass mark | Run 1 (interrupt) | Run 2 (reload) | Verdict so far |
|---|---|---|---|---|
| Speech→drawing drift (first frame of each action vs its word cue) | p95 ≤ 120 ms | **p50 17 ms**; one 1.7 s outlier = a frame stall in the hidden pane (sync is exact by construction: the board is scrubbed from the audio clock, so a stall delays *both*) | p50 23 ms | ✅ provisional; needs a fronted-tab run |
| Pause latency after barge-in | ≤ 150 ms | **77 ms** (key → audio paused + board frozen) | — | ✅ |
| Resume continuity | no redraw/duplicate stroke, 20/20 | **1/1: strokes 112 → 112, unfinished "10 × 40 = 400" continued from the rewind point** | — | ✅ 1/20 trials done |
| Reload recovery | same board + position, 10/10 | — | **1/1: saved 20 066 ms → resumed at checkpoint 18 500 ms, microscope fully drawn, labels pending** | ✅ 1/10 trials done |
| Visual quality | founder blind ≥ 4/5 vs the existing video | not rated | screenshot in PR | ⏳ founder |
| Avatar gestures | point lands ≤ 1 s; listen ≤ 300 ms; founder ≥ 4/5 | point 0.25–0.9 s; listen pose immediate; one 1.46 s (hand had to cross the board) | — | ⏳ founder rating; 1 miss on the ≤1 s rule |
| Frame rate | ≥ 50 desktop / ≥ 30 phone while drawing | avg 32, min 2 — **hidden-pane throttling; not valid** | avg 30, min 4 | ⏳ re-measure fronted |
| Security suite | 100 % | **not yet written** | | ⏳ |
| Authoring cost | hours per unit | fixture + cues ≈ 2 h for U4 (script, 13 actions, layout iteration) | | recorded |

Screenshots (PR): microscope revealing at 7 s; interrupt at 36 s with the eyepiece circled and SK pointing; end state with all seven lines written and the result circled.

## What Option E taught us already

1. **Scrubbing paused Web Animations from the audio clock removes the sync problem** that the current ERE board has (CSS keyframes + stub narrator). Pause/seek/resume cost nothing extra. This is the single most important finding.
2. **The production ink assets reveal well** along the worker's drawing order with a stroked mask; no re-rendering of the 1,529 ink assets is needed for the board.
3. **Handwriting via glyph outlines reads as writing** at board scale, but it is outline tracing, not pen strokes. A stroke (centre-line) font would be truer; parked.
4. **Layout needs a rule, not hand placement**: the first run wrote "10 × 40 = 400" over the eyepiece label. The package builder (B3) must place the working column from the labels' measured extents.
5. The avatar stub is enough to judge gesture timing; the 2D character design (B6a) is independent.

## Still to do in S1

- Option S: scene-engine clip for U4 (worker renders WebM/MP4 + a per-frame hit map) with an ERE overlay for the aside; same harness, same measures.
- 20 interrupt trials and 10 reload trials per option; fronted-tab fps on desktop and one Android phone.
- Adversarial/security suite (script in labels, `javascript:` hrefs, entity bombs, bidi, huge coordinates, 10k-node programs) against the runtime's element builder.
- Founder blind ratings (quality, "feels like a teacher").
- Then the §5.3 decision and the B2 recommendation.
