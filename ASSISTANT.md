# AI Teaching Assistant — operator runbook + Step-0 preservation report

The **AI Teaching Assistant** is the active student-tutor path: a fast, grounded,
voice-enabled **chat** that answers **book-first**, stays inside the student's
curriculum **topics** (Option B), verifies maths with a constrained **SymPy** tool,
and is built so the **model provider, voice, and math tool are all swappable**.
It replaces "Ask Coach" as the live path; the TAL whiteboard work is **preserved,
disabled** behind its flag.

---

## Step 0 — the whiteboard phases are PRESERVED, not deleted

**Snapshot (recoverable in full):** branch `preserve/tal-board-phase1-2` and tag
`tal-board-phase1-2-snapshot` in both `sketchcast-app` and `sketchcast-ere`
(app @ the P2-B commit; engine @ `8cc8caa`).

**Inventory — what the TAL/board phases added (all isolated behind flags):**

| Area | Files / objects | Flag |
|---|---|---|
| Engine | `src/ere/**` (vendored `@sketchcast/ere`: TAL, scene graph, renderer, KO library, gateway) | n/a (library) |
| Board turn API | `src/app/api/tutor/turn/route.ts`, `src/app/api/tutor/board-token/route.ts` | `FEATURE_AI_TUTOR_TAL`, `FEATURE_AI_TUTOR_CANVAS` |
| Board UI | `src/app/dashboard/tutor-board.tsx`; board branch in `ask-coach.tsx` | `NEXT_PUBLIC_FEATURE_AI_TUTOR_TAL`, `…_CANVAS` |
| Board data | migrations `0029` (tutor_board / _event / _tal_cache), `0030`/`0032` (resets), `0033` (ref_hash) | — |
| Server auth/events | `src/utils/tutor/board-token.ts`; `board.ts` (`boardCors`, `parseStudentEvents`, `refHash`, `persistStudentEvents`) | `FEATURE_AI_TUTOR_CANVAS` |

**Shared with the tutor core (reused by BOTH the board and the new Assistant — do
NOT remove):** chapter grounding (`chapter_grounding`, `loadGrounding`), the answer
cache (`tutor_qa`, `findCached`/`saveCache`/`bumpCache`), mastery/weak-spots
(`buildStudentModel`, `mastery_events`), voice tiers, RLS/tenant scoping
(`resolveTutorContext`), and the Anthropic client. The Assistant reuses all of
these; only the TAL/board *surfaces* are dormant.

**Entanglement checkpoint:** the only shared UI surface is `ask-coach.tsx` (it
hosts the flag-gated board). The new Assistant is entirely NEW components
(`assistant-panel.tsx` / `assistant-launcher.tsx`) — the old panel is untouched
and simply not shown when its flags are off.

**To DISABLE the board (rollout):** set `FEATURE_AI_TUTOR_TAL=false`,
`NEXT_PUBLIC_FEATURE_AI_TUTOR_TAL=false`, `FEATURE_AI_TUTOR_CANVAS=false`,
`NEXT_PUBLIC_FEATURE_AI_TUTOR_CANVAS=false` in all environments. The old per-lesson
"Ask Coach" launcher is gated by `NEXT_PUBLIC_FEATURE_AI_TUTOR` — turn it off too.

**To RE-ENABLE the board later:** flip those flags back on (data + code are intact),
run any pending board migrations, and re-vendor the engine if it advanced.

---

## How the Assistant works (per turn)

1. **Retrieve** — in-scope books (a student's assigned lessons' books, else books
   they own), scored against the question by content-word overlap with the books'
   chapter/topic metadata (`scope.ts`).
2. **Scope-decide (Option B)** — `in_scope` (a topic matched) / `off_topic` (no
   match, fresh question) / `no_book`. A contextless follow-up ("say that again")
   stays on the active topic.
3. **Answer** —
   - *in_scope*: **book-first**, streamed, with a **"from your [chapter]"** tag,
     enriching within the topic; the model may call the **math tools**.
   - *off_topic*: a warm, deterministic **decline-and-redirect** to real topics
     (no model call — faster, free, unjailbreakable).
   - *no_book*: a friendly empty state.
4. **Honest mastery** — hints and method, **never** graded answers, including
   through the math tool. Quiz-authoritative mastery is reused, never faked.
5. **Cache + log** — answers bank to `tutor_qa` (classmates replay for $0);
   latency + token cost logged per turn (`assistant_messages.latency/tokens`).

## Speed

- **Cold start:** `GET /api/assistant` warm-start pre-loads the greeting + book
  scope + session when the panel MOUNTS, before the student types. (Keep the
  Vercel function warm via min-instances/ping if cold starts bite.)
- **Latency:** SSE token streaming; read-aloud starts on the stream; the book
  context is prompt-cached (Anthropic adapter) and answers are cached; routine
  turns use the fast tier. `firstTokenMs` / `totalMs` / `toolMs` are logged.

## Swap points (all behind adapters)

- **Model:** `ASSISTANT_PROVIDER` = `gemini` (default) | `anthropic`. Add a new
  provider = one file in `src/utils/assistant/providers/`. No provider refs leak
  outside that folder.
- **Voice:** `src/utils/assistant/voice-client.ts` (browser TTS/STT) — swap for a
  hosted voice without touching the panel.
- **Math:** `src/utils/assistant/math-tool.ts` → the SymPy service. Fixed op set,
  extend server-side.

## ⚠️ Children's-data terms (founder/legal — surface, don't decide)

Before **Gemini free tier** processes children's data in production, its
**data-handling / model-training terms must be verified acceptable** for minors
(is prompt/response data used for training? retention? region?). The provider
adapter exists precisely so we can move if the terms or rate limits don't work.
**Do not enable `FEATURE_AI_ASSISTANT` in production with Gemini until this is
signed off.** (Interim: run with `ASSISTANT_PROVIDER=anthropic`, whose terms are
already in use, while Gemini is evaluated.)

## Flags & env

| Env | Where | Purpose |
|---|---|---|
| `FEATURE_AI_ASSISTANT=true` | Vercel (server) | Master switch — off → `/api/assistant` 404s. |
| `NEXT_PUBLIC_FEATURE_AI_ASSISTANT=true` | Vercel (client, build-time) | Shows the bottom-right launcher. |
| `ASSISTANT_PROVIDER` | Vercel | `gemini` (default) or `anthropic`. |
| `GEMINI_API_KEY` (+ `GEMINI_MODEL`) | Vercel | Gemini free tier. |
| `ASSISTANT_ANTHROPIC_MODEL` | Vercel | Anthropic model when `ASSISTANT_PROVIDER=anthropic` (reuses `ANTHROPIC_API_KEY`). |
| `MATH_SVC_URL` + `MATH_SVC_TOKEN` | Vercel | The SymPy service (see below). Absent → math tools are simply not offered (assistant still works, explains conceptually). |

**Migration:** `0034_assistant.sql` (assistant_sessions / assistant_messages, RLS,
30-day retention on open). Run before enabling.

## Math service (SymPy) — DEPLOYED (2nd Railway service)

Live at `https://successful-imagination-production-42cd.up.railway.app` (Railway
project `charming-embrace`, service `successful-imagination`, same repo
`sketchcast-ai`, **Dockerfile path `mathsvc/Dockerfile`**, target Port 8080 — the
Dockerfile keeps this build light and isolated from the worker's nixpacks build).
`MATH_SVC_TOKEN` is set on the service; `MATH_SVC_URL` + the same `MATH_SVC_TOKEN`
are set on Vercel. Health check `/health`. Redeploys on any change under
`mathsvc/**` (watch path). To rebuild a new service from scratch, see
`sketchcast/mathsvc/README.md`.

## Acceptance hardening (post-deploy audit, 2026-07-11)

A multi-agent acceptance audit of the deployed service + the app-side contract
found and fixed two confirmed issues (both pre-enablement — the feature is
flag-off and `/math` is token-gated, so neither was live-exploitable):

- **Definite integrals (wrong-answer-to-a-child, FIXED).** The model emits
  definite bounds as flat `from`/`to`, but `op_integrate` reads only a nested
  `definite:{from,to}` — so the bounds were silently dropped and the service
  returned the *indefinite antiderivative* as `{ok:true}`. Fixed in
  `math-tool.ts` (`toMathRequestBody` remaps `integrate` → nested `definite`),
  covered by a contract test so the shape can't drift again.
- **Power-tower / degree DoS (FIXED).** `9^9^9` (or `(x+1)^9999999`) bypassed
  the whitelist and would materialize an astronomically large value at parse
  time; the op timeout can't reclaim it (CPython can't kill the thread) → OOM on
  the single worker. Fixed in `safety.py` with a pre-parse (`evaluate=False`)
  size guard (`_estimate_numeric_bits` + `_reject_absurd_degree`, caps
  `MAX_RESULT_BITS` / `MAX_SYMBOLIC_DEGREE`) — rejects in ≤0.1s, legit powers
  and symbolic exponents (`2**x`) still compute.

**Recommended deeper follow-ups (not yet done):**
- **Process isolation** for each op (separate process + memory `rlimit` +
  `SIGKILL` on timeout) so any future runaway is truly reclaimed, plus a small
  concurrency cap. The size guard closes the cheap trigger; this bounds the rest.
- **Honest-mastery is prompt-only** — the math tool always returns the full
  graded answer to the model; only the system prompt (`prompt.ts` rule 3) stops
  it being read out on a graded item. Consider an eval asserting a direct
  "what's the answer to Q5" doesn't leak the raw `result` verbatim.

## Privacy / RLS

`assistant_sessions` + `assistant_messages` are RLS-scoped to the student
(`student_id = auth.uid()` read; service-role write only). Teachers/parents keep
the existing **aggregate recap** — never raw chat. Retention ≤30 days (deleted on
session open).

## Acceptance demo script

1. **Grounding:** as a student with a science book — ask *"how does photosynthesis
   work?"* → book-first answer + **"from your Chapter … "** tag. Ask *"who won the
   world cup?"* → warm decline-and-redirect to a real topic. As a student with no
   book → the no-book state.
2. **Maths:** *"solve x² − 5x + 6 = 0"* → correct **{2, 3}** shown as method (via
   SymPy). A physics formula with units → correct value. Ask something SymPy can't
   → conceptual explanation, no fabricated number.
3. **Voice:** tap the mic, ask aloud → the answer reads aloud **as it streams** and
   the **Stop** button interrupts it; reload → read-aloud preference remembered.
4. **Speed:** open the panel → greeting appears immediately (warm-start); watch
   tokens stream; check `assistant_messages.latency` for a turn.
5. **Provider swap:** set `ASSISTANT_PROVIDER=anthropic`, redeploy → identical UX.
6. **Preservation:** confirm the board flags are off and the preserve branch/tag
   exist; flipping the board flags back on restores it.

## Rollback

Set `FEATURE_AI_ASSISTANT=false` (instant, server-authoritative) — the launcher
and route go dark; nothing else is affected. The old tutor/board remain independently
flag-controlled.
