# SK B5 — Assessor: durable sessions, attempts, item bank and mastery rule v1

Status 2026-10-27: **draft PR against `feat/sk-b4-loop`.** Migration 0157 is
applied on the Supabase **branch** `sk-b1` (`grxsibudgjgepecxbyke`) and its
test passes there; **nothing has touched production.** The whole of B5 sits
behind `SK_STORE=supabase`; unset, the B4 loop runs exactly as before (the
in-memory store and the five U4 stand-in items).

Plan: `SketchCast SK AI Tutor - Architecture and Implementation Plan 2026-10-26.md`
(§3 skip-what-I-know and independent evidence, §10 data model and grading
rules, §14 wrong-mastery and replay controls, §15 row B5). Contracts:
`docs/SK-CONTRACTS.md` §5 (event ids, the two unique keys, grading once,
mastery recomputed by `rule_version`). B4: `docs/SK-B4-REPORT.md`.

## 1. What exists

### Migration `supabase/migrations/0157_sk_sessions_assessment.sql` (+ `_rollback.sql`)

| Table | Keys and guards |
|---|---|
| `sk_sessions` | `id` (UUIDv7 from the app), `student_id → profiles`, `product_id` (the graph's product id — the book slug; FK to `sk_book_products` when the packager emits uuids), `chapter`, `graph_version`, `status open\|closed`, denormalised `state`, `phase`, `cursor`, `bookmarks`, `rate`, plus `machine` (the whole MachineState, authoritative for resume), `mastery` (the loop's per-unit map), `history`. **One OPEN session per student × product × chapter** (partial unique index); opening a new one closes the old |
| `sk_events` | `PRIMARY KEY (session_id, event_id)` — the key **is** the replay guard. `status inflight\|stored`, `kind`, `result`, `claimed_at`, `at`; a CHECK forbids `stored` without `kind` and `at` |
| `item_attempts` | `UNIQUE (session_id, item_id, attempt_no)` and `UNIQUE (session_id, event_id)`; `item_id → topic_questions` (restrict), `teaching_objective_id → teaching_objectives` (set null = unmapped = no evidence), `attempt_no`, `response`, `outcome`, `score`/`max_score`, `independent`, `hint_used` + `hints_used`, `modality`, `transcript_confirmed`, `grader`, `purpose`, `unit_key`, `check_key` (the event that opened the check), `check_size`, `rule_version`, `at`. CHECKs: `independent` only on attempt 1 / no hint / correct / deterministic; a **spoken answer must be transcript-confirmed** |
| `mastery_state` | `PK (student_id, teaching_objective_id)`, `status`, `independent` (CHECK: only on `mastered`), `evidence` jsonb, `rule_version`, `updated_at`. Derived only |

RLS on all four; `revoke all … from anon, authenticated` as 0156/0158 do;
students `select` their own sessions, attempts and mastery; **nothing is
writable from `authenticated`**; `sk_events` has no policy at all (model
output and transcripts).

### Branch test `supabase/tests/0157_sk_sessions_test.sql` — PASSED on `sk-b1`

Run through the Supabase MCP after `apply_migration`. The DO block raises on
any failure and the transaction rolls back; afterwards the four tables, the
two throwaway profiles and the helper functions are all gone (verified with a
count query). A deliberate `raise exception` through the same tool surfaces as
an error, so a clean run is a real pass. It proves:

1. four tables with RLS on, the three read-own policies, no policy on `sk_events`;
2. a second OPEN session for the same student/product/chapter → `23505`; a closed one coexists; `phase` is constrained;
3. duplicate `(session_id, event_id)` → `23505`; an inflight claim completes exactly once (second update: 0 rows); the same event id on another session is a different key; a released claim is deleted;
4. duplicate `(session_id, item_id, attempt_no)` → `23505`; the same event id cannot grade a second attempt; attempt 2 after a hint is a new row; `independent` refused after a hint / on attempt 3 / on an LLM grade (`23514`); an unconfirmed spoken answer refused (`23514`);
5. `mastery_state` upsert updates in place (assisted pass: `mastered`, `independent=false`); `independent=true` on `needs_work` refused;
6. as student 1 under RLS (`_act_as`): sees their own two sessions, two attempts and one mastery row only; cannot see student 2's; cannot read `sk_events` (`42501`); cannot insert/update/delete any of the four tables.

### `src/sk/store-supabase.ts` — `SupabaseSessionStore implements SessionStore`

Same contract as the in-memory store, so `loop.ts` and the routes are untouched.

- **Claim protocol.** `claimEvent` INSERTs an `inflight` row; `23505` means the event exists → `stored` replays its result, `inflight` returns `done` = a poll (every `pollMs`, up to `inflightTimeoutMs`) that resolves when the first run stores its result and rejects if the first run released the claim. A claim older than `staleClaimMs` (a function that died mid-turn) is deleted and taken over. `completeEvent` updates `… where status = 'inflight'` and refuses when 0 rows changed (already stored / never claimed); `releaseEvent` deletes the inflight row.
- **Attempts.** `putAttempt` reads the session row (student id + the machine's open check), stamps `purpose / unit_key / check_size / check_key` (the first attempt on the check's first item opens it with its own event id; later attempts join the latest check on that unit and purpose), resolves `teaching_objective_id` from `topic_questions` (or takes `Attempt.teachingObjectiveId` when the caller sets it — a new optional field on the B4 `Attempt` type), inserts, and turns `23505` into `DuplicateAttemptError` carrying the stored row. A non-uuid item id (the stand-in bank) is refused with a clear message.
- **Mastery.** After every mapped attempt the store **recomputes** the student's `mastery_state` for that objective from all their attempts (rule below) and upserts it. A recompute failure is logged, the attempt stays stored (graded once); `lastMasteryError` exposes it.
- The client surface is narrowed to `SkDb` (`from / select / insert / update / upsert / delete / eq / order / limit / maybeSingle / single / await`), so the tests run on a fake (`src/sk/__tests__/fake-supabase.ts`, with Postgres-style `23505` on the declared unique keys) with no network.

### `src/sk/items-supabase.ts` — `SupabaseItemBank implements ItemBank`

`get(id)` returns an approved or draft `topic_questions` row mapped to the
loop's `RawQuestion`; `listForUnit(product slug|id, chapter, unitKey)` goes
`sk_book_products → teaching_objectives (unit_key) → topic_questions
(teaching_objective_id)`; `objectiveFor(itemId)` and `objectiveForUnit` for
the planner/packager. Mapping (worker shapes in `src/utils/catalogue/questions.ts`):
mcq / assertion_reason (`options[{key,text}]` + `answer.key` → option text),
true_false (`answer.value`), fill_blank (`answer.text`, `accept[]`),
**numerical → fill_blank** with the value as the key and the unit as an
accepted spelling (the quiz grader's numeric reading does the rest; a
non-zero `tolerance` is not honoured — the grader is exact), match
(`answer.pairs`), short/long/diagram_label → `short` (never auto-marked). A
row the grader could not mark honestly maps to `null` and is skipped — nothing
is guessed. `stripItem` is unchanged: keys never leave the server.

### `src/sk/mastery.ts` — rule v1, `rule_version "sk-b5.1"`

Pure and deterministic over `AttemptRecord`s (an `item_attempts` row):

- only **mapped** items count (`teachingObjectiveId`), and an optional `countsAsEvidence(objectiveId)` hook applies the plan §14 validated-map gate;
- only **deterministic** grades count; a check containing an LLM- or teacher-graded attempt is **excluded whole** (listed in `evidence.runs` with the reason, contributing no ids);
- a check (`skip | prereq | unit`) is `open` until every item is finished (correct, or wrong at `MAX_ATTEMPTS`), `passed` when correct items ≥ the pass mark (default every item — the 2-item checks need 2 of 2; `passMarkFor(purpose, size)` sets a unit check's mark), else `failed`;
- `mastered` after a passed check, `needs_work` after a failed one — the **latest completed check decides**; `in_progress` while a check is open or only practice has happened and nothing has been decided; `unknown` only when every run was excluded;
- `independent` **only** when a passed check's every counted attempt was independent (attempt 1, no hint): one hint anywhere makes the pass assisted (`mastered`, `independent:false`);
- `practise` runs and attempts outside any check are `evidence.practice`, never mastery;
- `evidence = { correct, total, attempt_ids[], runs[], practice }` — every mastery value traces to its attempts.

### `src/sk/server.ts`

`persistence()`: `SK_STORE=supabase` → `SupabaseSessionStore` + `SupabaseItemBank`
on the admin client; otherwise the B4 in-memory store and `StaticItemBank`.
Nothing else in the wiring changed.

## 2. Test results

```
npx vitest run src/sk src/app/api/sk   → 12 files, 168 tests passed (108 from B4 + 60 new)
npx tsc --noEmit                        → clean
npx eslint <touched files>              → clean
supabase/tests/0157_sk_sessions_test.sql on branch sk-b1 → PASSED (rolled back; 0 rows left)
```

New suites:

| File | What it pins |
|---|---|
| `src/sk/__tests__/mastery.test.ts` | **The 20 scripted runs** (21 scripts): independent 2-of-2 pass; assisted pass ≠ independent pass; attempt 2 never independent; failed check; open check (both shapes); unmapped → no evidence; LLM short answer in a check never counts; teacher review excluded; practice-only; loose attempts; pass→fail; fail→pass; a pass stands while a later check is open; unit pass mark 2-of-3 (assisted) and 1-of-3 (fail); row order irrelevant; validated-map gate; another objective's attempts ignored; practice after a pass; `partial` at the last attempt. Invariants on every run: `independent ⇒ mastered`, every listed id is an input, excluded runs list no ids. Plus `groupRuns` / `assessRun` / `masteryMapFromAttempts` |
| `src/sk/__tests__/store-supabase.test.ts` | The in-memory store's cases on the Supabase store (sessions, run-once/replay, concurrent duplicate waits, failed run releases) + one-open-session, a waiting duplicate told of a release, a stale claim taken over, complete-without-claim refused, `DuplicateAttemptError` with the stored row, non-uuid item refused, the check context stamped from the open check, practice outside a check, and `mastery_state` recomputed: independent pass → `mastered/independent`, assisted → `mastered/not independent`, fail → `needs_work`, unmapped → no row |
| `src/sk/__tests__/items-supabase.test.ts` | Mapping of 9 fixture rows copied from the branch (mcq, true_false, match, fill_blank, short, two numerical, a draft mcq); refusals; **deterministic grades match the quiz grader** — for every gradeable fixture `gradeItem` gives full marks for the key and none for a wrong answer, and its score equals `scoreQuiz`'s; short answer → `needs_review`; `stripItem` leaves no key; the bank's `get` (approved + draft, not rejected, not non-uuid), `listForUnit` by slug and by id, `objectiveFor` |

## 3. What is deferred

- **The loop does not yet call the bank by unit.** `loop.ts` (B4's file, not touched here) still takes item ids from the graph's `check`/`practice` assets; the B3 packager emits none, and the stand-in graph's ids (`ch2-u4-c1`) are not uuids. So with `SK_STORE=supabase` sessions and events persist and grading works for uuid items, but a check on the stand-in graph is refused by `putAttempt`. Next step (B3/B4 owner): the packager emits `item_ids` from `SupabaseItemBank.listForUnit`, or the planner asks the bank for the unit's items when the asset has none.
- **Dashboards** (students / parents / teachers / principals, plan §10) — nothing reads `mastery_state` yet. `evidence.attempt_ids` and `runs[]` are there for them; curriculum-level roll-ups must go through `objective_curriculum_map` rows with `status = 'verified'` only.
- **Retention of `sk_events` and `item_attempts.response`** (transcripts, 30 days, plan §14): 0158's `sk_retention_sweep()` is where it belongs, but 0157 < 0158 in number and a `create or replace` here would be overwritten when 0158 applies after it on main. Add the two deletes to the sweep in a migration numbered after both.
- **The Supabase store under real concurrency.** The claim protocol is tested on the fake and the unique keys on the branch; two Vercel functions racing on one event id (insert → `23505` → poll) has not been exercised against Postgres. The in-flight wait is a poll (250 ms, 30 s), not LISTEN/NOTIFY.
- **The validated-map gate** (plan §14) is a hook (`countsAsEvidence`), not wired: every Chapter 2 objective is still `draft` on the branch, so wiring it today would record no mastery at all. Wire it to `teaching_objectives.status = 'validated'` when B1b's review is done.
- **`item_id → topic_questions` is `on delete restrict`**: a question with attempts cannot be deleted from the library console. Intended (evidence must keep its item), but worth a console message.
- **`mastery_state` is written per objective by the store**, while the loop's session view still renders its own per-unit `mastery` map (B4's `applyCheckToMastery`, keyed by unit). The two agree on pass/fail; the derived table is the one dashboards should read. Switching the view to read `mastery_state` is a one-line change in `sessionView` once the graph carries objective ids for every unit.
- **Numerical tolerance** and **partial credit for short answers** (LLM, practice-only) are not implemented; `numerical` is graded exactly.
- `AttemptRecord.at` ordering relies on the `at` timestamp; two attempts in the same millisecond fall back to `attempt_no` then id.

## 4. How to try it

```bash
# worktree with node_modules; the branch database's keys (NEVER production's) in .env.local
printf 'FEATURE_SK=true\nNEXT_PUBLIC_FEATURE_SK=true\nSK_STORE=supabase\nNEXT_PUBLIC_SUPABASE_URL=https://grxsibudgjgepecxbyke.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=…\nSUPABASE_SERVICE_ROLE_KEY=…\n' > .env.local
node node_modules/next/dist/bin/next dev --webpack -p 3214
```

Open `/sk/cells-structure-function-organisation/2`, press Play, type commands:
`sk_sessions` gets one open row per student, every turn/command/answer leaves
a `stored` row in `sk_events`, and a repeat of the same `eventId` replays
without a second model call. Checks need uuid item ids (see §3, first item).

Re-run the branch test any time: paste `supabase/tests/0157_sk_sessions_test.sql`
into the SQL editor on `sk-b1` (it rolls itself back).
