# SK B4 — the teacher loop (POC): what exists, what is stubbed, how to try it

Status 2026-10-27: **draft PR against `feat/sk-s1-spike`.** The whole loop is
behind `FEATURE_SK` (server, authoritative) and `NEXT_PUBLIC_FEATURE_SK`
(the student page); with both unset nothing in production changes. Session
state is in memory behind a `SessionStore` interface — the `sk_sessions` /
`sk_events` / `item_attempts` tables are a later step (plan §10) and the store
contract is written so that step replaces one class, not the routes.

Plan: `SketchCast SK AI Tutor - Architecture and Implementation Plan 2026-10-26.md`
(§3 teaching graph + ladder, §4 state machine, §7 interfaces, §10 data model,
B4 row). Contracts: `docs/SK-CONTRACTS.md` (§1.3 SpeechProvider, §3 manifests,
§4 routes, §5 event ids).

## 1. What exists

### Pure modules, `src/sk/` (every one unit-tested, no network)

| Module | What it is | Pinned by |
|---|---|---|
| `types.ts` | Graph / asset / cursor / bookmark / mastery / command / intent types; the **closed command set** `repeat, slower, erase, continue, skip, goto, practise, return, explain_again` | — |
| `state.ts` | The §4 machine as one `transition(state, event)` function over 19 states in three phases (GUIDE / TEACH / ASSESS); bookmark stack (push before the cursor moves, pop on return, cap 20); cursor `{graphVersion, unitKey, assetId, segmentId, t}`; rewind 1.5 s on RESUMING; a hint bumps `attemptNo` and clears `independent`; an event the state does not accept is **refused, never applied** | `__tests__/state.test.ts` (18) |
| `router.ts` | Intent router. Layer 1: deterministic regexes for the closed set (and "I know this", "go back to the microscope" → return, "skip this bit" → segment vs "skip" → unit-with-check, titles/numbers → unit keys). Layer 2: a **Haiku 5.5 proposal through the existing `LLMProvider`** with one strict tool (`classify_utterance`, closed enums, `additionalProperties:false`), used only when Layer 1 has nothing; the proposal is **validated by code** (`parseProposal`) — unknown command or unit ⇒ refused ⇒ default `question`. Regex hits never call the model | `router.test.ts` (16) |
| `planner.ts` | The deterministic route planner: `next / skip / goto / practise / check_me / return / explain_again`; prerequisites **warn, never block** ("X uses Y's idea; quick check first?" + a suggested 2-item check); **skip counts only through a 2-item check** (without it: moves on, "records no mastery" in the reasons); validated assets first (visual alt after a failed check); the **safe-generation ladder** as `ladder()` returning `{rung, basis, reasons}` — rung 1 approved demo for the same objective, rung 2 live drawing from validated figures (refused when the request needs unverified content), rung 3 grounded words | `planner.test.ts` (14) |
| `store.ts` | `SessionStore` interface + `InMemorySessionStore`: sessions; append-only events unique on `(sessionId, eventId)` with a **claim protocol** (`new / stored / inflight`) so a repeat replays and a concurrent duplicate waits; attempts unique on `(sessionId, itemId, attemptNo)` (`DuplicateAttemptError`); `withEvent()` wraps non-streaming work | `store.test.ts` (7) |
| `grade.ts` | `gradeItem()` on the quiz's `scoreQuiz` (mcq / true_false / fill_blank incl. numeric reading / match one-per-pair); option letters and spoken true/false coerced; short answers → `needs_review`; `independent` = attempt 1, no hint; hints stop at 3 attempts; `rule_version` `sk-b4.1` | `grade-aside-graph.test.ts` |
| `aside.ts` | `validateAside()` — the gate for a model's live drawing: runs `validateSegment` over a synthetic segment (ids, text, numbers, duplicate ids against the base actions) **plus** live rules: ops ⊆ {label, highlight, write}, every target resolves to a placed asset region or a hit-map id, ≤ 12 actions, ≤ 20 s. Refused whole or passed whole | 15 refusal cases |
| `teacher.ts` | The question path: `answerQuestion()` = **one Sonnet 5.5 call** via the provider; system prompt = SK rules + the unit's narration (the Anthropic adapter marks the system block `cache_control: ephemeral`, so questions on one unit reuse the cached prefix); text streams; an optional single `draw_aside` tool call is gated by `validateAside` before it becomes a `tal` event | `loop.test.ts` |
| `graph.ts` | Strict `parseGraph()` for contracts §3.1 **and** the B3 packager's shape (`product`, `{ref, asset_key}` figures, relative segment paths resolved against a base URI, no objective id yet → keyed on the graph position); `startCursor`, `resolveUnitKey` | `grade-aside-graph.test.ts` |
| `items.ts` | `ItemBank` seam + **stand-in** items for U4 (server-only; the graph carries ids only); `stripItem()` built field by field so no key leaves the server | — |
| `loop.ts` | The loop itself, everything injected: `openSession` (new → PAUSED at the first unit; resume recovers a mid-turn state), `runCommand`, `runTurn` (SSE events), `submitAnswer`, `sessionView` | `loop.test.ts` (14), `routes.test.ts` (10) |
| `speech/provider.ts`, `speech/browser.ts` | The `SpeechProvider` seam (contracts §1.3) and the **browser adapter** (speechSynthesis; `marks.words = []`, never fabricated) | — |
| `board/engine.ts`, `board/runtime.ts` | The S1 board runtime, **moved from the dev page** (which still imports it). Added: a generic hit-map asset table (`mic` for the fixture, `ill` for the packager), `seek / setRate / pauseForTurn / answering / resumeAfterTurn / holdAfterTurn / clearLiveAside / playLiveAside`, and `checkpointKey: null` so B4 keeps the cursor server-side (the dev harness still uses localStorage) | `board/__tests__` (the S1 suites, unchanged) |

### Routes, `src/app/api/sk/` (contracts §4; cookie auth; `FEATURE_SK` → 404 before auth; every mutation idempotent on `eventId`)

| Route | Body → response |
|---|---|
| `POST /api/sk/session` | `{eventId, productId, chapter, resume?}` → the session view (`sessionId, graphVersion, state, phase, cursor, bookmarks, rate, mastery, unit, asset, openCheck, access`). Event keyed on the student so a double-click opens one session |
| `GET /api/sk/session/:id` | the same view (owner only) — reconnect = re-render from this |
| `POST /api/sk/turn` | `{eventId, sessionId, utterance{text, modality, transcriptConfirmed?}, cursor}` → **SSE** `meta{intent, …}` → `text`* → `tal`? → `done{latency, usage, board, decision, view}`. The first run's full event list is stored; a repeat **replays it** (`done.replayed: true`) — no second model call, no second state change. Client disconnect aborts the model call |
| `POST /api/sk/command` | `{eventId, sessionId, command, args?, cursor?}` → view + `speech` + `board` (`play / pause / seek / erase_aside`) |
| `POST /api/sk/answer` | `{eventId, sessionId, itemId, attemptNo, response, modality, transcriptConfirmed}` → `{outcome, score, max, feedback, hintAvailable, independent, hint?, check?, speech, view}`; a spoken answer without confirmation returns `{kind:"confirm", transcript}` (CONFIRM_TRANSCRIPT) |

What a turn does (plan §4, pinned in `loop.test.ts`): PRESENTING/PAUSED → barge-in
→ router → **command** applied in place → **route** through the planner (bookmark
pushed; a check opens CHECK → ASKING → AWAITING with the stripped item in the
view) → **question** answered by Sonnet, aside gated, RESUMING rewinds 1.5 s →
PRESENTING. While a check is open, text is an **answer** unless it reads as a
question (then SK says "let's finish this question first"); commands and routes
still work. Grading walks GRADING → FEEDBACK → HINT→AWAITING | NEXT → (ASKING |
check closed → mastery updated → the planner picks what follows: pass → next unit;
failed skip → the unit from the top; failed unit check → visual re-explanation;
practice → back to the bookmark).

### Student page, `src/app/sk/[product]/[chapter]/`

Behind `NEXT_PUBLIC_FEATURE_SK`. Opens/resumes the session, loads the cursor's
asset (segment manifest → clip + hit map + rig + font), mounts the runtime in
**Option S** mode (the S1 decision: clip as the clock, ERE overlay from the hit
map), seeks to the server's cursor, and renders everything else **from the
session view**. Buttons for the closed command set; a text box for questions /
spoken-style commands / typed answers (SSE); a question card for the open check
(mcq buttons, true/false, fill-blank). SK's lines are spoken by the browser voice
through the `SpeechProvider` seam; a validated `tal` program is drawn on the
aside layer by `playLiveAside`. Space pauses the clip and focuses the box
(push-to-talk stand-in).

### Teaching graphs on this build (`public/sk-s1/`)

1. **`ch02/graph.json` — the B3 packager's real Chapter 2** (6 units s1–s6,
   one explain/main clip + hit map each, ≈ 4.8 min, 6.2 MB), copied from the
   worker session's output on 2026-10-27 01:07 (s2 and s4 are the re-rendered
   label layout). Only `segment.json`, `clip.mp4` and `hitmap.json` per unit
   are copied; `plan/scene/audio.words` stay in the worker. Media belongs on
   S3 + CloudFront (S1 report §3.6) — it is in `public/` only for the POC.
   → `/sk/cells-structure-function-organisation/2`
2. **`graph-ch2.json` — the one-unit stand-in** (U4 → the S1 fixture) **with
   check and practice items**, kept because the packager does not emit items
   yet (its `checks.item_indexes` point into the draft's exercises, which live
   in the worker). This is the graph that exercises grading end to end.
   → `/sk/sk-poc-biology/2`

## 2. What is stubbed or deferred

- **Generation (ladder rungs 1–3) is a decision, not a segment.** The planner
  returns `{kind:"generate", rung, basis, reasons}`, SK says the rung's line,
  the decision is logged in the event — nothing is generated. Rung 1 replay of
  an existing demo, rung 2 TAL from validated parts, rung 3 grounded text with
  source refs need the retrieval provider (B4's FTS adapter, not in this PR).
- **Items.** Five stand-in U4 items in `src/sk/items.ts` (+ hints). B1 wires
  `topic_questions` → `teaching_objective_id`; the packager then emits
  `check`/`practice` assets with real ids and `ItemBank` gets a Supabase
  implementation. Match items are graded but the student page has no match UI.
- **Short answers** return `needs_review` (no LLM partial credit yet).
- **Speech.** Browser speechSynthesis only; no Polly, no viseme marks, no STT.
  Spoken modality is modelled (CONFIRM_TRANSCRIPT) but the page types.
- **Persistence.** In-memory store: sessions vanish on a server restart and
  are per-instance (Vercel functions would not share them). The tables and a
  Supabase `SessionStore` are the next step; the interface is final enough that
  the routes do not change.
- **Access.** `access: {source:"dev-flag"}`; grants / licences (§11) later.
- **Cursor ticks.** The server learns `t` from the cursor sent with each turn,
  command and answer (trusted only for the asset it believes is playing); no
  periodic checkpoint POST yet, so a reload after a long silent stretch resumes
  at the last interaction. Segment end does not yet call the planner from the
  client (the student presses Skip/Check me/next).
- **Onboarding (GUIDE)** is modelled and skippable; no UI.
- **Load test** (B4 row: 20 → 100 sessions) not run.
- **Retrieval provider** (contracts §1.2) not built; the teacher's grounding is
  the unit's own narration.

## 3. How to try it locally

```bash
# in the worktree (needs node_modules; the main checkout's has no .bin)
printf 'NEXT_PUBLIC_SUPABASE_URL=…\nNEXT_PUBLIC_SUPABASE_ANON_KEY=…\nFEATURE_SK=true\nNEXT_PUBLIC_FEATURE_SK=true\n' > .env.local
# optional: ANTHROPIC_API_KEY (or CLAUDE_BACKEND=bedrock + AWS creds) for the router/teacher models;
#           SK_ROUTER_MODEL / SK_TEACHER_MODEL override claude-haiku-5-5 / claude-sonnet-5-5
node node_modules/next/dist/bin/next dev --webpack -p 3214
```

Sign in (any account), then open `http://localhost:3214/sk/cells-structure-function-organisation/2`
(the real chapter) or `/sk/sk-poc-biology/2` (grading). Press **Play**; type
`slower`, `repeat`, `skip this bit`, `go to unit 3`, `explain it more simply`,
`check me`, a question; with a check open, type `b` / `400` / `false`. The log
panel shows intent, latency, aside acceptance/refusal and the planner's decision.
Without a Claude key the regex layer still routes every command; questions get
"I can't answer questions right now" and the lesson continues.

Tests: `npx vitest run src/sk src/app/api/sk` (108 tests, ~1.5 s of test time).
`npx tsc --noEmit` is clean. `npx eslint` on the changed paths is clean; the
repo-wide run has 7 pre-existing errors in `scripts/seed-school.ts`,
`src/app/dashboard/school/timetable/settings-panel.tsx` and
`src/app/library/pinterest/posting/page.tsx` (untouched here). The full suite
has two pre-existing failures in `migration-0107-caps.test.ts` (also failing on
the base branch `b724286`).

## 4. Open questions for the founder

1. **Skip without the check.** Today "skip" opens the 2-item check; the student
   can decline by sending `skip` with `withCheck:false` (no button yet). Should
   declining be offered at all, or is the check the only way past a unit?
2. **Who counts an assisted pass?** A check passed after a hint marks the unit
   `mastered` with `independent:false`. Dashboards must show the two apart
   (plan §10); is an assisted pass enough to unlock the next unit, or should
   the prerequisite warning keep firing until an independent pass?
3. **Questions during a check.** SK now deflects ("finish this one first").
   Alternatively allow one grounded answer that never reveals the key. Which?
4. **Barge-in modality.** Push-to-talk (Space) + typing for the POC. B6's mic/VAD
   decides whether a spoken utterance should pause the clip before or after the
   router classifies it (latency vs. false pauses).
5. **Where the media lives.** 6.2 MB of clips are in `public/` for this POC; the
   S1 report recommends S3 + CloudFront. Confirm before B3 renders the rest.
6. **Check items for the packager's graph.** B1's item mapping is the gate for
   mastery on the real chapter; until then the real graph teaches but never
   checks. Is that acceptable for the first classroom trial, or should the
   stand-in items be mapped onto s5 (magnification) as a bridge?
7. **Teacher prompt budget.** One Sonnet 5.5 call, ≤ 700 output tokens, the
   unit narration (~750 chars) as the cached prefix. Measured latency and cost
   per question are the load test's job (B4 row); no figures yet.
