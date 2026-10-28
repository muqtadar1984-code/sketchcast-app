# SK Stage S0 — Shell, context, navigation, onboarding (teacher)

Built 2026-10-28 on the Final Plan (2026-10-28, §2, §3, §4, §6 S0 row, §8, §9.7), from `main` `29c4764` (after spikes M1/M2). Branch `feat/sk-s0-shell` (PR #158, draft). Migration 0162 is separate (PR #156, draft, **not applied**). Nothing is live: every surface is behind `FEATURE_SK` + `SK_ROLES` + a per-school opt-in, and the Vercel preview of this branch answers 404 on the new routes with the flag unset.

## 1. Results against the S0 acceptance lines (plan §6)

| Acceptance line | Result | Evidence |
|---|---|---|
| "How many finished the quiz" returns the tool's count and names at-risk learners per the school-health rule on a seeded class | **PASS** | `src/app/api/sk/shell/__tests__/acceptance-s0.test.ts`: seeded 7B (5 learners) → `assignments.status` summary "Cells quiz (7B): 3 of 5 done, 2 not done (2 overdue), 1 to grade. Not done: Dina, Emir."; answer "3 of 5 finished the quiz. Dina and Emir have not." labelled `grounded`; `learners.risk` → "1 at risk in 7B: Emir — never started." (school-health's own reason text). Every number and name in the answer is traced back to a tool result by an assertion independent of the grounding code. |
| "Show me 7B's analytics" lands on the filtered page within 2 s without a card | **PASS** | Deterministic rules route → `context.resolve` → `navigate` → `/dashboard/analytics?c=<7B id>` in **32 ms** wall time with no model constructed; the analytics page now pre-filters on `?c=` when it is one of the teacher's classes. |
| Mic stops within 200 ms of blur/hidden in an automated test | **PASS** | `src/sk/shell/client/__tests__/mic-gate.test.ts`: blur → `onStop` in **0.03 ms**, and the stronger assertion that `onStop` runs before the event dispatch returns (blur, `visibilitychange`→hidden, `pagehide`); idle 60 s only in hands-free; never auto-resumes on focus/visible. |
| Tour shown once per version | **PASS** | `SK_INTRO_TOUR = {key: "sk-intro", version: 1}`; the dashboard layout reads `user_tour_progress`, `shouldAutoStart(seen, version)` decides, the panel narrates once and posts `/api/tour/seen` exactly once (completed or skipped); bumping the version re-shows it. Pinned in `narration.test.ts`. |
| Permission-matrix suite: 0 cross-role / cross-tenant rows | **PASS (unit level)** | `src/sk/capabilities/__tests__/permission-matrix.test.ts` is generated from `REGISTRY` × 5 roles × hats and covers every entry automatically (7 today); `context.resolve`, `assignments.status`, `learners.risk` re-filter in code on top of the DB predicate, and a deliberately leaking fake session yields no foreign row. The DB-level proof (RLS over a seeded tenant pair) is a founder-run SQL check — see §5. |
| Unsupported-claims suite: SK declines 30/30 | **PASS** | `src/sk/shell/__tests__/unsupported-claims.test.ts`: 30 teacher questions, every tool empty, a stub model inventing numbers and names → the route emits exactly `I have nothing on that.` with label `declined`, 30/30. |

Test totals on the combined tree: **1135/1135** across 72 files for the SK, Board, i18n, tour and boundary suites, plus the 6-case acceptance suite; `tsc --noEmit` 0 errors on a complete `node_modules`; eslint clean on all 55 changed files; Vercel preview builds READY for every push.

## 2. What was built

| Slice | Files (new unless noted) | Notes |
|---|---|---|
| Contracts + gate | `src/sk/shell/types.ts`; `src/utils/flags.ts` (+`skShellDecision`, `skShellEnabledFor`, `skShellRoles`) | Context, capability entry, turn protocol, signed memory blob. Gate = `FEATURE_SK` + `SK_ROLES` (default `teacher`) + `schools.config.sk_shell` (or `FEATURE_SK_SHELL_ALL_SCHOOLS`; `SK_SHELL_CONSUMER` for users without a school); a verified `SK_ALLOWED_EMAILS` address skips the tenant opt-in only. |
| A — Shell client | `src/app/dashboard/{sk-launcher,sk-shell}.tsx`, `src/sk/shell/client/{collector,sse,mic-gate,narration}.ts`, `src/sk/shell/tour.ts`, layouts (dashboard, console), `assistant-launcher.tsx` (+`hidden`), `sk.shell.*` × 10 locales | Launcher + panel (transcript, tool chips, grounded/supplementary/declined/navigation badge, caption line, job tray + confirmation-card slots), push-to-talk by default, hands-free opt-in with a persistent indicator, read-aloud via `StreamSpeaker`, navigate → `router.push` at once, SK-narrated teacher tour. Hidden on `/dashboard/school/*` (briefing bot's corner until S5) and not mounted on `/present` (S1). |
| B — Server core | `src/sk/shell/{context,hash,memory,registry,runner,prompt,rules,audit}.ts`, `src/sk/capabilities/{index,navigate,resolve}.ts`, `src/app/api/sk/shell/{context,turn}/route.ts`; `analytics/page.tsx` (+8/−2, `?c=`) | Context built server-side per turn; capability registry (§9.7) with `allowedFor` re-checked at execution; deterministic navigate for 16 targets mirroring `nav-tabs` visibility; rules router (EN/MS/AR phrasings) before any model; Sonnet 5.5 with the allowed tools for the rest; grounding check; audit sink (memory by default, `SK_AUDIT=db` once 0162 is applied). |
| C — Teacher knowledge tools v1 | `src/sk/capabilities/{library,assignments,risk,timetable}.ts`, `src/utils/{assignment-status,availability}.ts` | `library.find`, `catalogue.availability`, `assignments.status`, `learners.risk`, `timetable.now_next`. All read through the user-session client only, scoped to the teacher's own classes, capped, never throw. |
| F — Migration | `supabase/migrations/0162_sk_actions_manifests_tokens.sql` (+ rollback, lint test) — PR #156 | `sk_actions`, `sk_action_tokens` + atomic `sk_consume_action_token`, `sk_manifests` + stale trigger on `artifacts`. Deny-by-default RLS, no policies. Dry-run on production inside a rolled-back transaction passed; nothing persisted. |

### Decisions taken (deviations from the plan text, all additive)
1. **No Haiku router call in S0.** Rules first (navigate and acknowledgements are deterministic, which is what the 2 s line needs); everything else goes to the Sonnet call with tools. The Haiku router can be added as a registry-aware pre-pass in S1 if the rules miss too much.
2. **Conversation memory is a server-signed blob echoed by the client** (`SkTurnRequest.memory`), because serverless instances share no memory. A tampered or stale blob (4 h gap, hat/school/role change) just starts a new conversation; entities in it are hints only — every tool re-reads under RLS.
3. **Answer text is buffered, not token-streamed**, so the grounding check runs before anything reaches the client (answers are 1–4 sentences).
4. **`I have nothing on that.` is emitted by the route, not the model**, when every tool returned empty — that makes the unsupported-claims gate mechanical.
5. **SK moves are not written to `assistant_messages`** (student-keyed tables); the per-call `sk_actions` row is the S0 trail, held in memory until 0162 is applied.
6. **Availability vocabulary** (none existed): `in_library → on_school_shelf → in_catalogue_unlocked → sk_book_activated → in_catalogue → in_catalogue_locked → sk_book_not_activated → in_catalogue_not_yet → not_found` ("usable now → obtainable → promised → nothing").

### Known limits (v1)
- **Unlocked vs locked is undecidable for a specific catalogue kit from a teacher's session**: `public_catalogue()` withholds topic ids and `topics` is service-role only, so own `catalogue_unlocks` cannot be joined to a kit. v1 says "in the catalogue" and points at Kits when the teacher has unlocks, "locked, N of cap used this week" when none. Fix = a small read-only RPC (`my_catalogue_unlocked_slugs()`) in a later migration. `in_catalogue_not_yet` is never produced for the same reason.
- The grounding check exempts sentence-initial capitals and numbers written as words ("three"); documented in `prompt.test.ts`.
- Rules router covers English, Malay and Arabic phrasings; the other seven locales fall to the model.
- No driver.js highlighting during the SK narration (narration + transcript + voice only); the launcher carries `data-tour="sk-launcher"`, so the old teacher tour's "assistant" step is skipped gracefully when the Shell is on.
- Ten locale strings (25 keys) were translated by the builders, not by native speakers.
- No live model run: every suite uses fakes and a scripted provider. The first real run is the founder's local check (`docs/sk-shell-dev-check.md`).

## 3. Cost
- Model calls during S0: **none** (fakes only). Spikes M1+M2 earlier today: $0.094.
- Runtime once on: one Sonnet 5.5 call per non-navigate turn (≤3 tool rounds, 1024 max tokens); navigate and acknowledgements cost nothing.

## 4. The migration — APPLIED
**Applied to production 2026-10-28** on the founder's instruction, as Supabase version `20261028123125` (name `0162_sk_actions_manifests_tokens`). The file pair was then renumbered to **`0163_sk_actions_manifests_tokens.sql`** because `main` took 0162 for `pub_artifact_screen_copy` the same day; content unchanged; next free number is 0164. Post-apply verification: RLS on for all three tables, 0 policies, 0 grants to anon/authenticated, trigger + both functions present, `sk_consume_action_token(random)` → `not_found`. Set `SK_AUDIT=db` on Vercel for the audit trail to persist. Dry-run evidence before the apply: RLS on for all three tables, 0 policies, consume lifecycle `not_found → context_mismatch → done → already_used`, artifacts update → `status = stale`; afterwards 0 tables / 0 triggers / 0 functions present. The trigger on `artifacts` is one indexed update per artifact row change. Audit retention is not set (suggest 12 months, swept later).

## 5. Founder actions to turn S0 on
1. ~~Apply migration 0162~~ Done 2026-10-28. Set `SK_AUDIT=db` on Vercel so the audit trail persists; merge #156 to record the file (now numbered 0163).
2. Vercel env (no env-var tool exists; manual): `FEATURE_SK=true`, `NEXT_PUBLIC_FEATURE_SK=true`, `SK_ROLES=teacher`, `SK_SHELL_SECRET=<32+ random chars>` (memory-blob signing; falls back to `BOOK_CODE_SECRET`), and for the pilot either keep `SK_ALLOWED_EMAILS=<pilot teacher, you>` (skips the tenant opt-in) or set `schools.config.sk_shell = true` on the pilot school by SQL. Optional: `SK_SHELL_MODEL` (default `claude-sonnet-5-5`).
3. Run the local check in `docs/sk-shell-dev-check.md` once (first real model run, voice, navigation).
4. DB-level permission proof: run `supabase/tests`-style checks as the seeded tenant pair (teacher A, teacher B, parent, principal, coordinator, other-school) against `classes`, `generation_shares`, `student_progress`, `submissions`, `timetable_slots`, `present_last_taught`, `books`, `generations` and assert row counts — the unit suites prove the handlers' own scoping, not RLS itself.
5. Name the pilot school and teacher.

## 6. S1 estimate (teacher on the Board — the demonstration)
Built on the merged Board controller (#154) and manifest derivation (#155) plus this Shell. Single engineer-agent stream, ranges not commitments.

| Piece | Range |
|---|---|
| Manifest job on the existing `generations` poller (`kind: "manifest"`), `sk_manifests` read path, stale → rebuild queue, serve route | 3–4 days |
| Shell mounted on `/present` with the Board controller as a registry entry per move (intro, segment, slide, explain, compare, freeze, blank, back) and `sk_actions` logging as `kind: "board"` | 4–5 days |
| `practise(n)` / `walkthrough` on the question page (built in M2) mapped through the manifest's item↔segment links; "moving…" state; separate resume | 2–3 days |
| `assign(due)` as the first confirm-tier action: card, `sk_action_tokens` issue/consume, `generation_shares` insert behind `/api/sk/act` | 3 days (shared with S2) |
| `recap` pre-filled from the moves made (existing recap draft) | 1–2 days |
| Voice on the Board: push-to-talk on the teacher's device; Polly via `/api/sk/speak` when the role allows, browser fallback | 2 days |
| Pilot run with one teacher on one real kit, fixes | 3–5 days |
| **Total** | **4–5 weeks** (plan said 3–4 + the 3–5 days of amendment 7) |

Dependencies before S1's visual claims: the **worker asset-correctness gate** (founder decision 2026-10-28; until it exists SK must not say "this is what X looks like" — `slide(k)` shows a caption card where the manifest says `misleading`/`unknown`), migration 0162 applied, `polly:SynthesizeSpeech` on the Bedrock role for voice, a pilot teacher.
