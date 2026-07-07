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
