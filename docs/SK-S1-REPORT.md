# SK S1 board spike — report and B2 recommendation

Status 2026-10-26: **both options built, run on the same unit (Biology ch.2 U4
"Total magnification"), same narration audio, same cue times, same live aside;
20 interrupt trials and 10 reload trials each; adversarial suite written and
passing.** Two measures still need the founder: the blind quality ratings and a
fronted-tab frame-rate run (the in-app browser pane is a background page and
throttles `requestAnimationFrame`, so its fps numbers are not representative).

Harness: `/dev/sk-spike` (Option E) and `/dev/sk-spike/s` (Option S); both return
404 on a production build. Nothing here touches production paths.

## 1. What each option is

| | **Option E — extend ERE** | **Option S — scene-engine clip + ERE overlay** |
|---|---|---|
| Prepared teaching | The ERE board drawn live in the browser: raster reveal along the worker's drawing order through a stroked SVG mask; handwriting from Caveat glyph outlines (opentype.js); SVG labels, leaders, highlights. Every animation is a **paused Web Animation scrubbed from the audio clock** each frame | The **production video renderer** (`spike/scene_engine`, the engine behind every SketchCast lesson video) renders the segment to an MP4 (1280×720, 24 fps, hand sprite, handwriting face, labels) and exports a **hit map** (every element's world box + the action timeline) |
| Live teaching (aside, highlight, label) | Same board, aside layer | The same ERE overlay machinery, in the clip's world coordinates, placed from the hit map |
| Clock | `<audio>` | `<video>` |
| Code added | `engine.ts` 290 lines (pure, incl. the validator), `runtime.ts` 430 lines, fixture tool 230 lines | `make_option_s.py` 170 lines (scene + hit map), ~40 lines of runtime (S mode) — the overlay is Option E's runtime |

Fixture provenance (both): narration sentences from the approved `ch02-draft.json`
§s5; Edge TTS word marks; the production ink asset `light_microscope`
(`visual_assets` c0cf7bbe…, 10 labelled regions) with its drawing order from the
worker's own tracer; 13 actions cued to word indexes.

## 2. Measured (§5.3 scorecard)

| Measure | Pass mark | Option E | Option S |
|---|---|---|---|
| Speech→drawing drift (first frame of an action vs its cue) | p95 ≤ 120 ms | p50 **17 ms**, p95 38 ms (clean run; n=12) | p50 **16 ms**, p95 **38 ms** (n=14) |
| Pause latency (barge-in → board and voice frozen) | ≤ 150 ms | **1–70 ms** (20 trials; first-run 77 ms) | **1–135 ms** (20 trials; first-run 97 ms) |
| Resume continuity (no redraw, no duplicate stroke) | 20/20 | **20/20** (stroke count 112 → 112 every time; the half-written line continued) | **20/20** (the clip resumes 1.5 s back; the hand freezes mid-stroke and carries on) |
| Reload mid-segment → same board at the last checkpoint | 10/10 | **10/10** | **10/10** |
| Avatar gestures: point lands ≤ 1 s; listen ≤ 300 ms | ≤ 1 s | 0.25–0.9 s, one 1.46 s cross-board miss; listen immediate | 0.18–0.72 s; listen immediate |
| Security suite (adversarial segment data) | 100 % | **15/15** (`__tests__/security.test.ts`, shared gate `validateSegment`) | same gate |
| Frame rate while drawing | ≥ 50 desktop / ≥ 30 phone | avg 27–32, min 2 in the hidden pane — **not valid** | avg 26–30, min 2–21 in the hidden pane — **not valid** |
| Visual quality (blind, vs the existing video) | founder ≥ 4/5 | ⏳ founder | ⏳ founder |
| "Feels like a teacher" | founder ≥ 4/5 | ⏳ founder | ⏳ founder |
| Authoring cost for U4 | recorded | ≈ 2 h (script, cues, layout ×2) | ≈ 1 h on top of E's fixture (scene, hit map, one layout fix) + **38 s render** |
| Bytes per unit (excluding the shared 1.3 MB audio) | recorded | 0.7 MB (asset PNG) + 16 KB JSON | **1.9 MB** MP4 (≈1.4 MB/min at 720p) + 3 KB hit map |

Evidence: `docs/sk-s1/optionE-*.jpg`, `docs/sk-s1/optionS-*.jpg`.

Drift note: in both options the figure is frame cadence, not sync. Option E's
board is scrubbed from the audio clock, so a frame stall delays voice and
drawing together; Option S's sync is baked into the clip. Neither can drift
apart in the way the current ERE board does (CSS keyframes + stub narrator).

## 3. What the spike taught us

1. **Pause / interrupt / resume are solved the same way in both:** one media
   clock, everything else derived from it. For E that is scrubbing paused Web
   Animations; for S it is the video element itself. This removes the current
   ERE board's biggest limitation and is independent of which renderer draws the
   prepared material.
2. **The production ink assets work on the board unchanged.** Revealing along
   the worker's drawing order with a stroked mask (E) or through the renderer (S)
   — no re-rendering of the 1,529 ink assets is needed.
3. **Option S is production quality today; Option E is close but not equal.**
   S has the hand sprite, the renderer's handwriting face and ink style the
   founder already rated "90 %"; E traces glyph outlines (not pen strokes) and
   has no hand. Closing that gap in E is real work (a stroke font or pen-path
   data, a hand sprite in SVG, the renderer's label layout rules).
4. **Both first renders put the working column over a label.** Layout must come
   from measured label extents in the package builder (B3), not hand placement.
5. **The hit map is enough for the overlay and the avatar**: the aside circled
   the eyepiece exactly where the clip drew it, and the hand points at hit-map
   boxes for lines the video wrote.
6. **S costs server CPU per segment (38 s per 82 s of lesson) and ~1.4 MB/min of
   egress; E costs neither** but needs the renderer work above. At 10 h of
   prepared teaching per activation, S is ≈ 0.85 GB per student-activation of
   CloudFront egress (≈ $0.07 at list price) — small, but it is why lesson media
   goes on S3 + CloudFront rather than Supabase storage.
7. **Re-routing granularity:** S segments are atomic (you can seek, not
   re-time or re-style elements); E can re-time and re-style per element. The
   teaching graph re-routes between *assets*, not inside one, so this matters
   less than it first seems — but it caps how adaptive a prepared segment can be.
8. **Translations:** S re-renders a clip per language (38 s CPU each, labels are
   written by the engine so no art changes); E re-labels in the browser from the
   same assets.

## 4. Go/no-go and the B2 recommendation

**GO for B2, on the combination the plan allowed (§5.3 "a combination is
allowed; one board, one event model"):**

- **Prepared segments: Option S.** The scene engine renders each teaching asset
  to a clip + hit map. Zero new renderer code, production quality on day one,
  the cheapest authoring, and every future renderer improvement reaches the
  tutor automatically.
- **Live teaching: Option E's runtime as the overlay.** Asides, highlights,
  labels, student pointing/circling, and the avatar run on the scrubbed ERE
  overlay in the clip's world coordinates, placed from the hit map. This is the
  code that exists in `runtime.ts` today.
- **One board model:** the hit map *is* the scene graph for a prepared segment;
  overlay events append to the same event log; a checkpoint is `{segment, t}`.

Conditions attached to the GO:
1. The founder's blind ratings must reach ≥ 4/5 for Option S's clip and for the
   combined interrupt experience; if S is rated below E on "feels like a
   teacher", revisit (E-only with the renderer work in §3.3 becomes the path).
2. A fronted-tab frame-rate run on the founder's desktop and one Android phone
   must meet ≥ 50 / ≥ 30 fps with the overlay active.
3. B3 (the package builder) places the working column from measured label
   extents and renders per language; segment media goes on S3 + CloudFront.
4. TAL v0.2's `write` / `erase` / `math` / `reveal` ops are still built for the
   overlay (live drawings need them); the prepared-segment path does not block
   on them.

**Not chosen:** E-only (quality gap and the largest new-code surface) and
S-only (no live drawing without the overlay — and the overlay is E).

## 5. Known gaps carried into B2

- E's handwriting is outline tracing; a stroke font or pen-path data would be
  truer if E ever draws prepared material.
- The avatar is a stub; the 2D SK character (B6a) replaces it, driven by Polly
  visemes (B3) instead of the word-mark mouth.
- fps and the two founder ratings are the only unmeasured §5.3 rows.
- The dev harness exposes `window.__skRuntime` and writes a checkpoint to
  `localStorage`; neither pattern ships (B4 keeps the cursor server-side).
