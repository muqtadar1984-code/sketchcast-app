# SK Stage S1 — the teacher on the Board (built and merged 2026-10-28)

Built the same day as S0 on the founder's "no need start it here", under the standing instruction "apply merge and deploy what you need to". App PR [#161](https://github.com/muqtadar1984-code/sketchcast-app/pull/161) merged → `main` `9b868dd`. Migration 0164 applied to production. Worker gate PR [sketchcast-ai#340](https://github.com/muqtadar1984-code/sketchcast-ai/pull/340) open (merge pending a clean full-suite run and an empty processing lane).

## 1. Results against the S1 acceptance lines (plan §6 S1 + §9.6)

| Line | State | Evidence |
|---|---|---|
| The §2.7 journey end to end on a real kit with the pilot teacher | **Code complete; live run pending** (founder is the pilot; nothing here can sign in) | every move wired and tested on the combined tree (1616/1616); the first live Board turn is the founder's |
| Interruption mid-video | PASS (tests) | `pause` / `resume`; the segment's `end_s` stop survives a pause and re-arms on resume |
| Visual comparison via two slides | PASS (tests), **pictures degraded** | `compare(a,b)` shows both slides and answers from the two narrations; every S1 manifest marks `visual.show = caption_only` until the worker gate + a frame-aware pass write verdicts |
| Three practice questions on the roll | PASS (tests) | `showQuestions(start, count)` window; `practise 3` → "Showing 3 of N questions (q3–q5)", items mapped to the current segment |
| Assignment created only after the card | PASS (prod dry run + tests) | card → token → `/api/sk/act` → `sk_assign_with_token` in one transaction; second use `already_used`; wrong class refused (token burned); expired/tampered refused; same kit+class again updates the due date, no duplicate share |
| Recap draft listing the moves | PASS (tests) | recap reads `sk_actions` for the present session; "What SK did in this lesson" block in the prompt; fallback recap names SK's topics |
| All `present_items` / moves logged | PASS | Board moves audited in `sk_actions` under the PRESENT session id, kind `board`; `present_items` untouched |
| Stale manifest never served | PASS (tests) | read path serves `ready` only and re-checks the pinned artifacts live (incl. the worksheet's, which the DB trigger cannot see) |
| Seek within one frame; "Moving…" shown | PASS (M2 measurements carried) | start = `start_s + 0.03`, end = `end_s − 0.10`; displayed-frame error 3.6–18.6 ms |
| Existing suites green, tsc clean, preview READY | PASS | 1616/1616 (94 files), tsc 0, eslint clean on 57 files, preview `dpl_APNYRrir…` READY; new routes 404 where the flag is unset |
| One real model turn and one real Polly line before "done" | **Model: proven for S0's path; the S1 explain path uses the same provider with no tools. Polly: not proven** (needs `polly:SynthesizeSpeech` on the Bedrock role + `SK_TTS=polly`, both founder actions) | |

## 2. What was built (by slice)

| Slice | Files (new unless noted) | Essentials |
|---|---|---|
| Contracts | `src/sk/shell/types.ts` (additive), `src/sk/shell/tokens.ts` | `board` / `confirm` SSE events; `SkBoardMove`; `/api/sk/act` request/response; tokens: HMAC over the STORED row (user, action, canonical params, context hash, nonce, expiry), 10-min TTL, verify re-derives, consume via the 0163 RPC; refuses to issue without a secret |
| A Manifest | `src/sk/manifest/{load,service,store,board}.ts`, `/api/sk/manifest` | Derivation on demand in the app (`sk_manifests.status` building → ready → stale by trigger), ONE Haiku call each for concepts and items; live proof on the Biology kit: ready in 21 s, 19 segments, concepts 18/18, items 9/10, **$0.0022** |
| B Shell on the Board | `src/sk/capabilities/board.ts`, `src/app/present/sk-board-bridge.ts`, `src/app/present/{page,present-client}.tsx`, `src/app/dashboard/{sk-launcher,sk-shell}.tsx`, `src/sk/shell/client/{memory-store,confirm}.ts`, rules + route + 11 strings × 10 locales | Launcher bottom-start on `/present` (the stage's corner video owns bottom-end); 13 `board.*` registry entries (teacher hat + Board access); 84 phrasings EN/MS/AR; confirm card with countdown; spoken yes only with one active card and an intentional mic press; memory blob in `sessionStorage` so "open the board" then "start the video" is one conversation |
| C Teaching | `src/sk/shell/teach.ts`, controller/bridge/recap changes | explain/compare: slide move + ONE Sonnet call (no tools, 220 tokens) over the segment narration as a TEACHING data block, grounding-checked, labelled grounded, `sources: [board.explain, manifest]`; not-ready manifest → no model call; `getUnit()` port; `showQuestions` window; recap moves |
| D Assign | `supabase/migrations/0164_sk_assign_action.sql` (+rollback, lint test), `src/sk/capabilities/assign.ts`, `src/sk/shell/act.ts`, `/api/sk/act` | Class and kit resolved against the teacher's own rows; due parsing EN/MS at 17:00 local; CLICK_ONLY set for S2 (invite, school-wide notices, credit/money spend, revoke, publish to parents) |
| E Voice | `src/sk/shell/client/speech.ts`, `sk-shell.tsx` (speech parts) | Pause the video only if playing, resume only if SK paused it, never resume a teacher's pause; a `board` move owns the Board state afterwards; barge-in (push-to-talk, hands-free start, Stop, page hide) stops SK and never resumes; Polly when `NEXT_PUBLIC_SK_TTS=polly`, browser fallback sticks after a 404 |
| F Worker gate (sketchcast-ai#340) | `shared/asset_gate.py`, library/integration/composer changes, ledger | G1 text reuse-check before a library hit (`same/different/unsure`), G2 vision check at the composer's seam (verdict cached per asset × prompt; reject row → evict → regenerate once → strict fail), G3 at publish; Haiku 5.5 on Bedrock; `ASSET_GATE=0|warn|strict`; live proof on the real `two_cells__colour` PNG: Biology request → `ok=false` ("bacterium-like cell … no membrane-bound nucleus"), own description → `ok=true`, G1 → `different`; $0.0008 |

### Decisions taken (deviations from the plan text)
1. **Manifest job runs in the app, not on the worker's `jobs` rails** — the worker's generic lane claims any unknown job type and dispatches by `generations.kind`, so a manifest job carrying a presentation id would rebuild the kit.
2. **Visual verdicts are `unknown → caption_only` in every S1 manifest** — the app has no frame extraction. A previously stored frame-judged verdict for the same artifacts hash is carried forward, so the worker gate + a frame-aware pass lift this without re-deriving.
3. **Refused confirm actions burn the token** (a card that fails at execution could never succeed later; unburned cards invite probing). A token for the wrong action is refused before the consume.
4. **A typed bare "yes" is treated as a click**, a spoken one as voice (the §9.2 conditions apply to voice only).
5. **No retrieval over `sk_book_blocks` for kits** — kits teach from the manifest narration; `explain` is grounded on the segment's own text.
6. **The root cause of the wrong picture was library reuse, not drawing**: the matcher scored a bacterium-vs-eukaryote asset (`two_cells__colour`, canonical key collapsed to `colour_two`) as a hit for a plant-vs-animal request. G1 catches exactly this; G2/G3 are the nets behind it.

### Known limits (v1)
- No browser-verified run of the Board with SK (no sign-in possible here); the founder's first Board turn is the live proof.
- Model-path `practise` is not stamped with item ids (rules path only); question prompt text is absent from the recap's "questions asked" (the manifest pins hashes).
- Teacher pressing play then pause on the Board's own controls while SK is speaking is indistinguishable from SK's own pause (needs a controller pause event) — SK may resume at the end of its line.
- Arabic-Indic digits in "slide ٣" are not parsed; Board phrasings cover EN/MS/AR, other locales fall to the model.
- Polly not exercised live.

## 3. Cost
- Model calls during the build: Biology manifest proof $0.0022; worker gate proof $0.0008; everything else fakes. Spikes earlier today $0.094.
- Runtime once on: manifest ≈ $0.005 per kit (once, cached); explain/compare ≈ one Sonnet call (≤ 220 tokens out); gate ≈ $0.005 per kit in the worker.

## 4. Founder actions
1. **Try the Board**: open `/present` on your account, pick a unit, say "start the video", "stop there", "explain …", "give them three questions", "assign this for Friday" (confirm the card), "end the lesson". Tell me what SK said and did; I'll read `sk_actions` and the runtime log alongside.
2. **Polly**: add `polly:SynthesizeSpeech` to role `sketchcast-app-bedrock`, then `SK_TTS=polly` + `NEXT_PUBLIC_SK_TTS=polly` on Vercel and redeploy; until then SK speaks with the browser voice.
3. After sketchcast-ai#340 merges (automatic once its suite is green and the lane is empty): I retire `two_cells__colour` and re-run the Biology kit (~$1.8), then run a frame-aware manifest pass so `slide(k)` shows real frames where the gate has passed.
4. Pilot teacher and school for the §2.7 demonstration.

## 5. S2 estimate (teacher actions: notice, diary, reminders, marking queue, lesson prep, tokens generalised)
Single engineer-agent stream, ranges not commitments. The token/card/act machinery, the audit table and the CLICK_ONLY policy exist, so S2 is mostly per-action RPCs and resolvers.

| Piece | Range |
|---|---|
| Generalise `/api/sk/act` dispatch + per-action RPCs for notice (`/api/notices` wrapped), diary entry, reminder to parents of non-completers (uses `assignments.status` entities) | 4–5 days |
| Marking queue (`needs_review` submissions → "mark the next one" loop with the existing grading path) | 3 days |
| Lesson prep as a queued job (generation insert on the existing rails, credits confirm card, job tray + next-greeting report) | 3 days |
| Idempotency + token suites across all actions (single-use, expiry, altered params, context change, duplicate click → one row) | 2 days |
| **Total** | **2–3 weeks** (plan: 2 weeks) |
