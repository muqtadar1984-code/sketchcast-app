> **Retired in S3 (slice E), 2026-10-29:** the packager clip path this report describes (`public/sk-s1`, the dev player, `SpikeRuntime`, `sk-student.tsx`) was deleted; the student tutor plays kit artifacts. Kept as history.

# SK B2 — board player on the six Chapter 2 units: report

Status 2026-10-27: **the board runtime (`src/sk/board`, B4's home for the S1
spike) plays all six prepared Chapter 2 units from the B3 packager in Option S
mode with the Option E overlay for live teaching, on ONE board model and ONE
event model; every §5.3 mark that can be measured without the founder is
measured on all six units and passes.** Dev route only (`/dev/sk-player`,
404 in production); nothing in production changed; no flag flipped. Draft PR
on `feat/sk-b4-loop`.

Harness: `/dev/sk-player?unit=s1..s6` (`&auto=interrupt:20` / `&auto=reload:10`
run the trial series). Evidence: `docs/sk-b2/*.jpg` (composited clip frame +
overlay), `docs/sk-b2/measurements/*.json` (one summary per unit and series,
with the per-trial raw lists).

## 1. What B2 built (on top of B4's `src/sk/board`)

| Piece | Where | What it does |
|---|---|---|
| Hit-map gate | `board/engine.ts` `validateHitMap` | The renderer's export is DATA: world size bounded, every box numeric and **clamped into the world** (corners ordered), element/asset/region names allow-listed tokens (no `.`, no bidi/controls), verbs from the scene engine's set, every timeline target an element the map declares, counts bounded (2000 elements, 200 regions, 2000 timeline entries). Returns a normalised copy; refuses whole on the first violation |
| Hardened manifest gate | `board/engine.ts` `validateSegment` | Audio / clip / hit-map URIs must be local paths (no scheme, no `..`); gesture kinds allow-listed (`point write listen think idle`); `voice_gender` enum; checkpoints numeric and bounded. The 15 S1 adversarial cases and B4's aside gate still pass |
| DOM allow-list | `board/dom.ts` | The only way a node reaches the board: `createElementNS` + `textContent`; tags `svg g defs mask rect path ellipse circle line text image` only (no `foreignObject`/`script`/`a`/`use`/`style`); attributes from a fixed list with per-attribute value checks (no `on*`, no `style`, no `href`; `url()` only as an internal mask ref; colours, ids, keywords, geometry strings validated); image sources through `setImageHref` = site-local path only. Pure `assertTag/assertAttr/assertImageHref` are unit-tested |
| Avatar | `board/avatar.ts` | `RigAvatar` (A for female voices, B for male) and the stub behind one `AvatarLike`; gestures from the manifest: **point** aims the forearm at the hit-map box, **write** follows the live pen (distance measured), **listen** turns the head on barge-in (latency measured); the avatar is animated while paused too, so the listen pose lands during the listening window |
| Replay safety | `board/events.ts` `CommandLog` + `runtime.command()` | A command with a repeated event id returns the stored outcome and runs nothing twice; async commands hand the SAME in-flight promise to the repeat. The client half of contracts §5 (B4's `store.ts` is the server half) |
| Runtime | `board/runtime.ts` | B4's surface unchanged (`seek setRate pauseForTurn answering resumeAfterTurn holdAfterTurn clearLiveAside playLiveAside`, `checkpointKey: null`), plus `interruptWith(aside)`: pause → listen → the live aside on the overlay, clocked by the answer's audio when there is one (word marks drive the mouth) or wall time → resume at the **exact** pause point with no redraw (the overlay is cleared, no stroke node created, the clip is seeked and the `seeked` position checked); reload restore records board match (hit-map elements drawn at the checkpoint) and seek exactness; live-overlay drift measured; speech URIs must be local |
| Dev harness | `src/app/dev/sk-player/` | Loads graph → unit → `segment.json` + `hitmap.json` through both gates; per-unit live aside built from the hit map at the moment of the barge-in and passed through B4's `validateAside`; every ask is sent TWICE with one event id; auto trial runner survives reloads (sessionStorage); snapshot + measurements route writes `docs/sk-b2/` |
| Tests | `board/__tests__/` | `hitmap.test.ts` (6 real maps + U4 pass; 20 adversarial/clamping cases), `dom.test.ts` (allow-lists), `events.test.ts` (replay), `ch02.test.ts` (six units through both gates, every gesture target resolves, the harness asides pass the aside gate, the hardened manifest cases); plus B4's `engine.test.ts` and `security.test.ts` unchanged. `npx vitest run src/sk` → 146 passing |

Fixtures: `public/sk-s1/ch02/` as B4 copied them from the packager (graph +
six `segment.json` / `hitmap.json` / `clip.mp4`). Not copied again.

## 2. Measured (§5.3), all six units, fronted Browser pane

Method. Each unit: 20 barge-ins at random moments (1.5–3.5 s apart) with the
unit's live aside; the clip loops when it ends. 10 reloads at random moments
2.5–6.5 s into playback, restored from the last checkpoint ≤ the saved cursor.
Pause latency = barge-in command → first animation frame with the clip paused.
Drift (clip timeline) = first frame an action was seen − its scheduled start,
consecutive playback frames only (a seek never counts); drift (live overlay) =
the same on the live clock for the aside's actions. Point arrive = cue → the
forearm settles on the target. Write hand→pen = perpendicular distance from
the pen to the elbow→fingertip ray while the overlay writes (a cut-out forearm
rotates about a fixed elbow, so it AIMS at the pen; `writeReachPx` in the JSON
is the straight-line reach, ≈ 900–1100 px by construction). Listen pose =
barge-in → head tilt lands. fps = animation frames per second while playing,
**valid only with the Browser pane fronted** (it was, for every run below; a
hidden pane throttles `requestAnimationFrame`, which is what S1 saw).

Machine: the founder's Windows 11 desktop, Claude desktop app's Chromium 152
pane, 1280×720 clip world; the same machine S1 used. No phone run yet.

| Unit | Title | Pause latency ms p50 / p95 / max | Drift ms, clip timeline p50 / p95 / max | Drift ms, live overlay p50 / p95 / max | Interrupt → resume, no redraw | Reload → same board | Replays ignored | Point arrive ms p50 / p95 / max | Write hand→pen px p50 / p95 / max | Listen pose ms p50 / p95 / max | fps avg / min |
|---|---|---|---|---|---|---|---|---|---|---|---|
| s1 | Too small to see | 14 / 17 / 17 (n=20) | 19 / 19 / 19 (n=7) | 8 / 11 / 11 (n=40) | **20/20** | **10/10** same, 10/10 exact | 20 | 32 / 200 / 200 (n=22) | 2 / 57 / 243 (n=2160) | 134 / 148 / 148 (n=20) | 61 / 53 (n=120) |
| s2 | Parts of a light microscope | 9 / 18 / 18 (n=20) | 17 / 19 / 19 (n=10) | 9 / 17 / 17 (n=39) | **20/20** | **10/10** same, 10/10 exact | 20 | 162 / 183 / 183 (n=13) | — | 123 / 144 / 144 (n=20) | 60 / 15 (n=259) |
| s3 | Using the microscope safely and focusing | 12 / 19 / 19 (n=20) | 11 / 16 / 16 (n=5) | 5 / 15 / 16 (n=40) | **20/20** | **10/10** same, 10/10 exact | 20 | 176 / 183 / 183 (n=20) | 4 / 72 / 206 (n=2163) | 129 / 142 / 142 (n=20) | 61 / 56 (n=121) |
| s4 | Making a temporary slide | 14 / 17 / 17 (n=20) | 16 / 16 / 16 (n=10) | 6 / 15 / 17 (n=40) | **20/20** | **10/10** same, 10/10 exact | 20 | 0 / 204 / 216 (n=26) | 1 / 15 / 42 (n=2141) | 131 / 242 / 242 (n=20) | 60 / 39 (n=124) |
| s5 | Magnification and actual size | 14 / 17 / 17 (n=20) | 14 / 17 / 17 (n=7) | 7 / 16 / 16 (n=40) | **20/20** | **10/10** same, 10/10 exact | 20 | 192 / 198 / 200 (n=22) | 5 / 94 / 261 (n=2144) | 131 / 148 / 148 (n=20) | 61 / 50 (n=122) |
| s6 | Drawing what you see | 10 / 16 / 16 (n=20) | 11 / 15 / 15 (n=7) | 7 / 10 / 11 (n=40) | **20/20** | **10/10** same, 10/10 exact | 20 | 163 / 166 / 190 (n=22) | 3 / 66 / 181 (n=2158) | 124 / 145 / 145 (n=20) | 61 / 43 (n=121) |

All six units together: pause latency p50 **12 ms**, p95 **17 ms**, max 19 ms
(n=120); drift on the clip timeline p50 **14 ms**, p95 **19 ms** (n=46); drift
on the live overlay p50 **7 ms**, p95 **15 ms** (n=239); point arrives p50
163 ms, p95 197 ms, max 216 ms (n=125); listen pose p50 130 ms, p95 147 ms,
one 242 ms (n=120); fps avg 60.4 (n=867 one-second samples; min 15 was a
single second during s2's long spoken asides, every other unit's minimum is
39–56); interrupt → resume without redraw **120/120**; reload → same board at
the checkpoint with an exact seek **60/60**; replayed commands ignored
**120/120** (every ask was sent twice with one event id).

Notes per unit. s2's write hand→pen is "—" because its live aside (the S1
spoken aside re-targeted to the packager's `ill`) draws a circle and a label,
no handwriting, so there is no live pen to follow. s4's point p50 is 0 ms
because its pointing cues repeat the same target (the arm is already there).
Drift n per unit = the clip's timeline entries seen in consecutive frames
(seeks are excluded by design).

Evidence: `docs/sk-b2/<unit>-ask.jpg` (mid-answer: the overlay's circle and
note over the paused clip, SK pointing), `<unit>-play.jpg` (mid-clip),
`<unit>-end.jpg`; `docs/sk-b2/measurements/<unit>-interrupt.json` and
`<unit>-reload.json`.

## 3. §5.3 verdict per mark

| Measure | Pass mark | B2 on six units | Verdict |
|---|---|---|---|
| Speech-to-drawing drift | p95 ≤ 120 ms over a 3-minute segment | Clip timeline p95 19 ms (n=46); live overlay p95 15 ms (n=239). Note: the segments are 47–57 s, not 3 min; drift here is frame cadence by construction (the clip carries sync; the overlay is scrubbed from its clock) | **Pass** (on the segments that exist) |
| Pause latency after confirmed speech | ≤ 150 ms | p50 12 ms, p95 17 ms, max 19 ms (n=120) | **Pass** |
| Resume continuity | No visible redraw or duplicate stroke in 20/20 | 20/20 on every unit (120/120): overlay stroke count unchanged, clip seeked back to the exact pause point (`seeked` within 40 ms, in fact ≤ 1 ms) | **Pass** |
| Reload recovery | Same board and position in 10/10 | 10/10 on every unit (60/60): hit-map elements drawn at the checkpoint identical before and after, seek landed exactly | **Pass** |
| Visual quality | Blind founder rating ≥ 4/5 | Not measurable here — the clips are the production renderer's output (S1's Option S) | ⏳ founder |
| Avatar: pointing lands within 1 s of the cue, 20/20 | ≤ 1 s | p95 197 ms, max 216 ms (n=125) | **Pass** |
| Avatar: writing hand within 40 px of the pen | ≤ 40 px | Aim (pen-to-pointing-ray) p50 1–5 px, p95 15–94 px, max 42–261 px per unit; straight-line reach ≈ 900–1100 px by construction (fixed elbow) | **Pass on aim at p50, miss at p95 on 4 of 5 units; the reach reading cannot pass with a rotating-forearm cut-out** — see §5 |
| Avatar: listening pose within 300 ms of barge-in | ≤ 300 ms | p50 130 ms, p95 147 ms, max 242 ms (n=120) | **Pass** |
| Avatar: "feels like a teacher" | founder ≥ 4/5 | — | ⏳ founder |
| Frame rate | ≥ 50 fps desktop, ≥ 30 phone, while drawing | avg 60 (fronted pane; every unit's avg 60–61); per-second minima 39–56 except one 15 on s2 | **Pass** desktop; phone **not run** |
| Security suite | 100 % | 146/146 (`npx vitest run src/sk`): S1's 15 adversarial cases, hit-map suite (20), DOM allow-list suite, replay suite, six units through both gates | **Pass** |
| Authoring cost | recorded | Zero per unit here: the packager produced all six (B3 records its own time); the harness asides took ≈ 20 min for the set | recorded |

Decision rule (§5.3): the combination S-for-prepared + E-for-live passes every
measurable mark on all six units with one board and one event model. The two
founder ratings and the phone run are the open rows, as after S1.

## 4. What the six units taught

1. **The packager's hit maps are a usable scene graph.** All six validate
   unchanged; every manifest gesture targets something its map resolves
   (`ch02.test.ts` pins this); asides placed from them land on the pixels the
   clip drew (`docs/sk-b2/s2-ask.jpg`: the circle sits on the eyepiece region
   the renderer exported; `s4-ask.jpg`: the iodine drop).
2. **Two packager quirks, documented not loosened:** s2's hit-map timeline
   puts a2–l4 all at 21 138 ms although `scene.json` draws them at 9–21 s
   (`gestures_for` derives from the timeline, so the pointing cues bunch up);
   s2's `board_plan` has a `w2` ("Coarse first, then fine") the scene never
   placed. Neither fails validation; both belong to B3.
3. **Resume without redraw is exact by construction in S mode:** the overlay
   is the only thing drawn live, it is cleared on resume, and the clip is
   seeked back to the pause point (`seekExact` true in 120/120 trials). No
   stroke node is created on resume (strokes before = after in 120/120).
4. **Autoplay after a reload works in this pane** (the runtime's `playAsync`
   succeeded on every one of the 60 reloads), so reload recovery was measured
   without a click; a production page still needs the click.
5. **A hot reload of the runtime module mid-series remounts the runtime and
   restarts the harness** — the s1 interrupt series was re-run clean at the end
   for that reason; nothing to fix in the player.

## 5. Known gaps carried forward

- Blind quality ratings (clip vs video; "feels like a teacher") and the phone
  run remain the founder's (unchanged from S1).
- The write-hand mark is met as "aims within 40 px"; a hand that travels to
  the pen needs a rig with a translating arm (B6b parts sheet).
- Live asides here are canned per unit; B4's teacher turn supplies the real
  program and the spoken answer (`playLiveAside(program, speech)`).
- The dev route writes under `docs/sk-b2/` only in dev; the snapshot composites
  the clip frame and the SVG overlay (label text falls back to sans-serif in
  the composite; the live page uses Caveat).
- `window.__skRuntime` and the localStorage cursor are harness-only (B4 keeps
  the cursor server-side with `checkpointKey: null`).
