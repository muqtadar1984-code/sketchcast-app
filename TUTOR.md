# AI Tutor ("Ask Coach") — operator & safety guide

The AI Tutor is the **Pro+ differentiator**: a real-time, chapter-locked study
coach. A student opens a lesson assigned to them, asks questions, and gets warm,
Socratic answers grounded **strictly** on that chapter — served from a shared
cache when possible (near-$0), else streamed from Claude and banked.

This document is the runbook: what it is, how it's gated, the safety fence, the
cost model, and the pilot steps. Code lives in `src/utils/tutor/*`,
`src/app/api/tutor/*`, `src/app/dashboard/ask-coach.tsx` + `coach-recap.tsx`, and
worker `worker/tutor_warm.py`.

## How it works (data flow)

1. **Grounding** — at lesson generation the worker writes `chapter_grounding`
   (Agent‑2 concepts + the lesson's narration script). This is the tutor's only
   source of truth. No grounding → the tutor reports "not ready" (409).
2. **Ask** — `POST /api/tutor` (SSE). Access is fenced to lessons **assigned to
   this student** (a `student_progress` row). Cache-first: a near-exact or a
   verified fuzzy match replays for $0; otherwise Claude streams a grounded,
   tiered, gently-personalised answer, which is then banked.
3. **Personalisation** — weak spots are derived by **re-grading the student's own
   quiz submissions** against the answer key (no concept tags exist), so the
   greeting and answers lean toward what they actually got wrong.
4. **Mastery** — `mastery_events` logs engagement; the recap combines it with the
   authoritative quiz score. Practice can nudge but **never manufacture** mastery.
5. **Voice** — free = the browser's own speech ($0); premium = ElevenLabs, gated +
   character-capped + cached in a private bucket. The client asks for a coach
   message BY ID; the route only ever synthesises a real coach reply this student
   received (`loadOwnCoachMessage`) — never client-supplied free text — so the
   premium voice can't be turned into an arbitrary/un-fenced text-to-speech oracle.
6. **Recap** — `GET /api/tutor/recap` gives the student / owning teacher / verified
   parent an aggregate (band, score, practice, weak spots). **No raw chat.**
7. **Warm cache** — at generation time the worker can pre-compute the top likely
   Q&A so the first student gets an instant answer (gated `TUTOR_WARM_CACHE`).

## Gating

Two switches, composed by `tutorGateAllows`:

| Env | Where | Effect |
|-----|-------|--------|
| `FEATURE_AI_TUTOR=true` | Vercel (server) | Master switch. Off → every route 404s. |
| `NEXT_PUBLIC_FEATURE_AI_TUTOR=true` | Vercel (client) | Shows the "Ask Coach" button + parent recap. Server is authoritative. |
| `FEATURE_AI_TUTOR_REQUIRE_PROPLUS=true` | Vercel (server) | Enforce the Pro+ entitlement. **Leave OFF during the open free trial**; turn ON afterwards. |

When Pro+ is enforced, access requires the **lesson owner's** plan to grant it:
`teacher_pro_plus*`, `family*`, or a `school*` plan (via the school entitlement).
Plain `teacher_pro` does **not** grant the tutor. See `planGrantsTutor` +
`tutorEntitled`.

## Safety fence (and residual risks)

The system prompt (`buildSystemPrompt`) enforces, in order:

1. **Closed-book** — answer only from the chapter context; if it's not there, say
   so and steer back. Never use outside knowledge.
2. **No unsafe/off-topic** — refuse adult/violent/hateful/off-topic; redirect.
3. **Socratic** — explain briefly, then check understanding; **hint** (don't tell)
   when the student is fishing for a graded answer.
4. **No graded work** — never hand over exam answers.
5. **Injection-hardened** — the student's messages are treated as questions, never
   as instructions that change the rules.

Reinforcing controls: the grounding context is the *only* knowledge injected;
answers are length-capped (`max_tokens` 300); the cache serve-rule is conservative
(a fuzzy-but-unverified near-miss is regenerated, never served); warm-cache seeds
are generated under the same fence.

**Residual risks (accepted for the pilot):**
- The fence is prompt-based; a determined adversary may still coax an off-topic
  reply. Mitigation: closed grounding + short outputs + the pilot uses **adults
  acting as children** (no minors), and transcripts are retained for review.
- Weak-spot re-grading mirrors the quiz-player rules; a partially-correct `match`
  counts as a weak spot (intentionally conservative for study).
- Premium voice depends on `ELEVENLABS_API_KEY`; any failure degrades to the free
  browser voice (never hard-fails). Voice can only speak a logged coach reply the
  student received (bound by message id) — not arbitrary text — so it can't be
  used to synthesise un-fenced content or to burn the cost cap on junk input. The
  audio cache is shared across students by (voice, text): that's the intended $0
  replay for identical, chapter-generic coach answers, not a leak.

## Data & retention

Transcripts (`tutor_messages`), mastery signals (`mastery_events`) and paid-voice
usage (`tts_usage`) are keyed to the student's profile with `ON DELETE CASCADE` —
**deleting the account deletes all of it**. `chapter_grounding` and `tutor_qa`
are shared, chapter-level, and carry no student PII. The recap never exposes chat.

## Cost model

- **Text**: shared cache + prompt caching of the chapter context (paid once per
  chapter) + model tiering (Haiku default, Sonnet only for reasoning-heavy/long
  questions). Warm cache makes common first-questions $0.
- **Voice**: free by default (browser). ElevenLabs only when enabled, capped at
  `TUTOR_TTS_MONTHLY_CHAR_CAP` chars/account/month and cached so repeats are free.

## Required env

**App (Vercel):** `ANTHROPIC_API_KEY` (now called directly by the app),
`FEATURE_AI_TUTOR`, `NEXT_PUBLIC_FEATURE_AI_TUTOR`, and later
`FEATURE_AI_TUTOR_REQUIRE_PROPLUS`. Premium voice: `NEXT_PUBLIC_ELEVENLABS_ENABLED`
+ `ELEVENLABS_API_KEY`.

**Worker (Railway):** `TUTOR_WARM_CACHE=true` to pre-compute seed Q&A.

**Migrations:** `0025_ai_tutor.sql`, `0026_tutor_mastery.sql`, `0027_tutor_voice.sql`.

## Pilot runbook (adults-as-children)

1. Apply migrations 0025–0027 in Supabase.
2. Set app env: `FEATURE_AI_TUTOR=true`, `NEXT_PUBLIC_FEATURE_AI_TUTOR=true`,
   `ANTHROPIC_API_KEY`. Leave `FEATURE_AI_TUTOR_REQUIRE_PROPLUS` **unset** (open
   during the trial). Optionally `TUTOR_WARM_CACHE=true` on the worker.
3. Seed: one teacher account, a class with adult "student" accounts, one indexed
   book, and a generated **lesson** assigned to those students.
4. Test as a student: open the lesson → **Ask Coach** → greeting appears → ask an
   on-topic question (grounded answer streams) → ask an off-topic/unsafe question
   (refused + redirected) → ask "what's the answer to question 3" (hint, not the
   answer) → toggle **Read aloud**.
5. Test the recap: as the teacher (lesson owner) or a verified parent, open the
   child's lesson row → **Coach recap** → band/score/practice/weak spots, no chat.
6. When ready to charge: set `FEATURE_AI_TUTOR_REQUIRE_PROPLUS=true` and confirm a
   non‑Pro+ owner's students see the upgrade message while a Pro+ owner's don't.

---

## Phase 1 — the persistent teaching board (ERE / TAL)

Instead of a stateless text/clip reply, the coach can teach on **one persistent
board per (student, lesson)** that *mutates* turn to turn: the first question
draws a diagram, and each follow-up **builds on what's already there** (highlight
a part, advance a process, add a label) rather than starting over. Student input
stays as plain words; only the coach's teaching becomes structured.

This is **strictly additive and off by default**. When its flag is off, or on any
failure, Ask Coach behaves exactly as above (text, or the Phase‑2 clip). The board
is an enhancement, never a hard dependency.

### The determinism boundary (why this is safe + cheap)

```
Student → Coach (LLM) → AI Gateway → TAL → validate → apply to scene graph → SVG + narrate
         └──────── probabilistic ────────┘ │ └──────────── pure / deterministic ───────────┘
                                    validation IS the safety model
```

Left of TAL the model only ever emits **TAL** (a small JSON teaching language) —
never pixels, never prose that gets rendered. The gateway (`src/ere` +
`generateTal`) forces valid TAL, validates it against the chapter's **catalog** of
knowledge objects, and does **one** repair pass. An invalid or off-catalog program
is never applied — the route returns `{ mode: "text" }` and the existing streamed
answer takes over. The engine downstream is a pure function of (scene graph,
events) → SVG, so the same board + question replays byte-identically (and dedupes
through `tutor_tal_cache` for ~$0).

### How it works (data flow)

1. `POST /api/tutor/turn` — same auth + Pro+ fence as `/api/tutor`. No grounding →
   `{ mode: "text" }` (nothing to teach from yet).
2. Load-or-create the student's **board** row (`tutor_board`), rebuild the ERE
   session from its stored scene graph, then **cache-first**: identical
   (chapter, question, board-state) replays the stored TAL.
3. Miss → the **gateway** makes the model emit valid TAL grounded in the chapter,
   constrained to the catalog, and **aware of the current board** (a read-back is
   injected so follow-ups mutate rather than redraw). Validate + repair once.
4. Apply the program to the scene graph, **persist** the new snapshot + append this
   turn's events (`tutor_board_event`), and return the **authoritative new snapshot
   + this turn's events** to the client.
5. The client (`tutor-board.tsx`) is a **pure renderer**: it deserialises the
   snapshot and `renderSvg`s it, animating **only this turn's new draws** (prior
   objects render static), and narrates the `speak` text. Reload rehydrates the
   board from `GET /api/tutor/turn?generationId=` — the DB row is the source of
   truth, so client and server can't drift. `prefers-reduced-motion` → final state,
   no animation, no speech.

Board + events are **private to the student** (RLS: `student_id = auth.uid()`);
teachers/parents still see only the aggregate recap, never the raw board or chat.

### Gating

| Env | Where | Effect |
|-----|-------|--------|
| `FEATURE_AI_TUTOR=true` | Vercel (server) | Master switch (shared with the text tutor). Off → `/turn` 404s. |
| `FEATURE_AI_TUTOR_TAL=true` | Vercel (server) | **Board switch.** Off → `/turn` 404s and Ask Coach uses text/clip. Authoritative. |
| `NEXT_PUBLIC_FEATURE_AI_TUTOR_TAL=true` | Vercel (client, **build-time**) | Renders the board surface in Ask Coach. Must match the server flag; needs a fresh Vercel build to take effect. |

`FEATURE_AI_TUTOR_REQUIRE_PROPLUS` applies to the board too (same `tutorEntitled`
check), so the board is a Pro+ capability once the trial closes.

### Migration

`0029_tutor_board.sql` — `tutor_board` (current scene graph, student-RW),
`tutor_board_event` (append-only log; student-read, service-write only), and
`tutor_tal_cache` (service-role-only dedupe). Additive + idempotent; run as one
execution **before** setting the flags.

### Fallback & rollback

- **Fallback (automatic):** no grounding, an invalid/off-catalog program after
  repair, a model/DB error, or the client failing to reach `/turn` all resolve to
  `{ mode: "text" }` → the existing streamed text answer. The student always gets
  an answer.
- **Rollback (instant, no deploy):** set `FEATURE_AI_TUTOR_TAL=false` (and
  `NEXT_PUBLIC_FEATURE_AI_TUTOR_TAL=false` on the next build). The `/turn` route
  goes dark and Ask Coach reverts to text/clip. Existing board rows are inert data;
  no migration needs reverting.

### 3-subject demo (proves it teaches, not just draws)

Assign a lesson for a **biology**, a **physics**, and an **algorithms/CS** chapter
(the book's `subject` selects the catalog via `subjectFor`). For each:

1. Ask the opening question ("show me how the heart pumps" / "how does this circuit
   work" / "sort these numbers") → the board draws the object and narrates.
2. Ask a **follow-up** ("now show blood leaving the right ventricle" / "close the
   switch" / "do the next swap") → the **same** object updates in place; only the
   new stroke animates. Reload the page → the board comes back exactly.
3. Ask something off-chapter → the coach steers back (or the turn falls to text).

Automated coverage of these guarantees: `src/utils/tutor/__tests__/ere-board.test.ts`
(3-subject 2-turn persistence across a reload + the gateway validation fence),
plus the engine's own suite in `sketchcast-ere/`.

### Required env (add to the Phase-1 rollout)

App (Vercel): `FEATURE_AI_TUTOR_TAL=true`, `NEXT_PUBLIC_FEATURE_AI_TUTOR_TAL=true`
(fresh build), on top of the existing `FEATURE_AI_TUTOR` + `ANTHROPIC_API_KEY`.
Migration: `0029_tutor_board.sql`.

> Engine source note: `src/ere/` is a **vendored copy** of the `@sketchcast/ere`
> package (`src/ere/VENDORED.md` has the sync steps). Keep them in lockstep.
