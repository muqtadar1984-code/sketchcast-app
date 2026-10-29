# SK actions — confirm tier (S1 slice D: `assign`)

Status 2026-10-28: built on `s1/slice-d`; migration 0164 written, dry-run on
production inside `begin … rollback` (nothing persisted), **not applied**. The
registry does not list `assignAction` yet (the orchestrator appends it); the
turn route does not issue confirm cards yet. Final Plan 2026-10-28 §2.5, §4,
§8.1–8.2, §9.2.

## The shape of a confirm-tier action

```
turn:  user → model → capability (resolve only) → { confirm: {action, title, params} }
       route issues a token over the RESOLVED params (tokens.ts, sk_action_tokens)
       client renders the card with the opaque token
act:   client → POST /api/sk/act {token, via} → verify (HMAC over the STORED row,
       user, expiry, used_at, live context hash) → per-action RPC (consume + write
       in ONE transaction) → one line SK says
```

Three rules every action in this tier follows:

1. **The capability never writes.** It resolves the user's words into ids the
   user owns and returns `confirm`. Ambiguity asks ("Which class: 7B or 7C?"),
   nothing is guessed, not-found is `ok: false`.
2. **The client carries nothing but a token.** Execution re-reads the row, so a
   client can never alter what it confirmed; `/api/sk/act` receives no params.
3. **Consume and write are one transaction** in a `security definer`,
   service-role-only RPC that re-checks ownership from the stored params. A
   second concurrent click gets `already_used`.

## `assign` (teacher, teacher hat)

| | |
|---|---|
| Capability | `src/sk/capabilities/assign.ts` — `assignAction`, meta `{name: "assign", tier: "confirm", kind: "act", roles: ["teacher"], hats: ["teacher"]}` |
| Parameters | `classQuery` \| `classId`, `kitQuery` \| `generationId`, `due` (the user's words) |
| Resolves with | `context.resolve` (class by name, own classes) and `library.find`'s `searchLibrary` (kit by title, own library), then **re-reads the candidates as own rows** — the belt under RLS |
| Assignable | the Library's own rule (`assignableIds`): status `done`, not withdrawn, kind not `lesson_plan` / `question_bank` |
| Card params | `{generation_id, class_id, due_at (ISO or null), class_name, kit_title}` |
| RPC | `public.sk_assign_with_token(p_token uuid, p_context_hash text) returns jsonb` (0164) |
| Write | `generation_shares (generation_id, class_id, shared_by, due_at)` upsert on `(generation_id, class_id)` — the §9.2 idempotency key; a repeat updates `due_at`, as the Library's Assign modal does |
| Audit | the RPC inserts the `done` row into `sk_actions` (actor, `assign`, confirm/act, params, `{share_id}`, `token_id`); every other outcome is one row from `/api/sk/act` with `ok: false`, `error: <outcome>[:reason]` |
| Voice | a spoken yes is **allowed** (assign is not click-only) |

### Ownership checks in the RPC (both, from the STORED params)

- generation: `owner_id = token.user_id and withdrawn_at is null and status = 'done' and kind not in ('lesson_plan','question_bank')`
- class: `teacher_id = token.user_id`

RLS `shares_owner_class_all` (0018) checks only the first; the RPC runs as the
service role, so it checks both itself.

### Decision: a refused action burns the token

Outcomes after the consume (`refused: class_not_owned | generation_not_assignable
| bad_params`) **leave the token used** and write no share. The params were
resolved and ownership-checked by the server when the card was issued, so a
refusal at execution means the world changed (kit withdrawn, class handed over)
or a stale card is being replayed; retrying the same token could never succeed
differently, and an unburned card would let a prober re-submit it until something
changed. The user asks again and gets a fresh card. The RPC therefore never
raises after the consume. Two cases are refused **before** the consume and keep
the card valid: a token whose `action` is not `assign` (a server dispatch fault,
not a user retry) and, in the app, a spoken yes for a click-only action.

Dry-run evidence (production, `begin … rollback`, 2026-10-28; throwaway tokens
for a real teacher's real done kit and own class; nothing persisted — function
count 0, token count 0, `sk_actions` count unchanged at 7, no share for the kit):

| Step | Outcome |
|---|---|
| own kit, own class | `done`, share row written, audit row `ok=true token_id=<token>` |
| same token again | `already_used` |
| wrong context hash | `context_mismatch`, token still unused |
| class not hers | `refused: class_not_owned`, no share |
| retry after that refusal | `already_used` (burned) |
| expired token | `expired` |
| token for another action | `refused: wrong_action`, token still unused |
| unknown token id | `not_found` |
| new token, same kit + class, new due | `done`, same `share_id`, `due_at` updated (1 share row) |

## Due-date rules (`parseDue`)

- The teacher's **civil day in the collector clock's UTC offset** (`clock.iso`,
  e.g. `…+08:00`); no clock → `+08:00` (Kuala Lumpur). A bare day is due at
  **17:00 local**; a said time wins (`9am`, `3pm`, `pukul 10`, `noon`/`tengah hari`).
- Words (EN + MS): `today`/`hari ini`, `tomorrow`/`esok`, `day after tomorrow`/`lusa`,
  `in N days`/`N hari lagi`, ISO `YYYY-MM-DD`, a full ISO instant (taken as said).
- Weekdays `monday…sunday`, `mon…sun`, `isnin selasa rabu khamis jumaat sabtu ahad`:
  a bare weekday is the **coming** one, 1–7 days ahead (never today);
  `next <day>` / `<day> depan` is that weekday of **next calendar week** (Mon–Sun).
- A due at or before now → `due_past` (asks); unknown words → `due_unparsed`
  (asks); no `due` → `due_at: null`. Nothing is guessed.
- Summary label: `Fri 30 Oct, 17:00` in the user's offset; the card param is the
  absolute ISO instant.

## `/api/sk/act`

`POST` body `SkActRequest {turnId, token, via: "click"|"voice", collector, memory?}`;
gate = `skEnabled()` + signed in + `skShellEnabledFor` (as the turn route);
Context rebuilt server-side; every outcome answers **200** with
`SkActResponse {ok, outcome, summary, result?, memory}` — a bad token is
`refused` with no detail. Lines: `done` → "Assigned <kit> to <class>, due <label>.";
`already_used` → "That was already done."; `expired` → "That confirmation
expired — ask me again."; `context_mismatch` → "Your context changed, so I did
nothing."; `not_found` → "I don't have that confirmation any more — ask me
again."; `refused` → "I can't do that one." (click-only by voice: "That one
needs a click to confirm."; capability no longer allowed: "That isn't available
in your current view, so I did nothing."); `error` → "That didn't go through —
nothing was changed."

`CLICK_ONLY` (`src/sk/shell/act.ts`, §9.2, names for S2): `teacher.invite`,
`notice.school`, `notice.multi_class`, `kit.generate`, `chapter.prepare`,
`purchase`, `book.activate`, `access.revoke`, `recap.publish`.

Per-tier revalidation: `metaAllows(assignAction.meta, ctx)` runs again at
execution; a Context that no longer allows the capability is refused before the
RPC. The memory blob gets the outcome appended (`rememberTurn`) and is returned.

## Not done in slice D

- `assignAction` is not in `REGISTRY` (`src/sk/capabilities/index.ts`) — the
  orchestrator appends it; the permission-matrix suite then covers it.
- The turn route does not yet issue the token / emit the `confirm` event for a
  capability result carrying `confirm`.
- Migration 0164 is NOT applied; `SK_SHELL_SECRET`/`BOOK_CODE_SECRET` must be set
  or tokens cannot be issued or verified (every act is `refused`).
- Student (direct) shares, notices, diary entries: S2.

---

# S2 slice A — the action core, `diary.note`, `parents.remind`

Status 2026-10-29: built on `feat/sk-s2-actions`; migration **0169** written,
dry-run on production inside `begin … rollback` (nothing persisted), **not
applied**. Until 0169 is applied the two new actions fail at the write
(unknown column `sk_action_id`): the token is burned and SK says "That didn't
go through — nothing was changed. Ask me again." `assign` is unaffected.

## The S2 execution shape — writes run AS THE TEACHER

```
act:  verify token (HMAC over the STORED row, user, expiry, used_at, live context)
      → per-tier revalidation: metaAllows(handler.meta, live ctx)   [refused, nothing consumed]
      → shape-check the stored params                               [bad_params: refused, nothing consumed]
      → consume: sk_consume_action_token(token, live hash)  (admin RPC, 0163)
      → write with the USER-SESSION client, carrying sk_action_id = token id
      → audit row (sk_actions) with the handler's tier/kind: ok + result, or the measured error
```

`src/sk/shell/act-core.ts` `consumeThenWrite(admin, session, row, ctx, write)`
is that middle. The write goes through the request's own Supabase session (the
route has the cookies), so the **existing RLS and triggers decide** what is
allowed — `dn_insert` for the diary (author = me, and I own the class / teach
the student). No SECURITY DEFINER function re-implements `owns_class` /
`teaches_student`.

`HANDLERS` (`src/sk/shell/act.ts`) entries are `{tier, kind, clickOnly?,
auditsDone?, meta, run}`. A spoken yes is refused for `CLICK_ONLY` names and for
any handler with `clickOnly: true`. `assign` keeps its one-transaction RPC
(`auditsDone: true`: 0164 writes the done row); every other outcome and every
S2 outcome gets one audit row from `/api/sk/act` with the handler's tier/kind.

### Deviation from Final Plan §9.2 ("consume and write in the same transaction")

The consume is a service-role RPC and the write a user-session insert, so they
are **two transactions**, in that order. Consequences, by design:

- A second click is stopped by the consume (`already_used`) before any write.
- If the write fails after the consume, the token stays **burned**, nothing is
  written (a multi-row reminder insert is ONE statement — all or nothing), the
  audit row is `ok: false` with `error: "error:write:<code> <message>"`, and SK
  says **"That didn't go through — nothing was changed. Ask me again."** (ten
  locales). Asking again issues a fresh card.
- RLS refusing the insert (42501 — e.g. the class was handed over) → `refused`,
  reason `not_permitted`, burned.
- 0169's unique index makes a repeated write under the same action id fail
  (23505) → reported as **"That was already done."**

Why accept it: running the write as the teacher keeps ONE authority (RLS) for
who may write where; the alternative — a definer function per action — copies
that authority into SQL that can drift from it. The cost is a burned card on an
infrastructure error, which the teacher recovers from by asking again.

## Migration 0169 `sk_action_ids`

`diary_notes.sk_action_id uuid`, `generations.sk_action_id uuid` (nullable, no
FK), and partial unique indexes:

- `diary_notes_sk_action_target_uidx (sk_action_id, coalesce(student_id, class_id)) where sk_action_id is not null`
  — one reminder action writes one note PER STUDENT.
- `generations_sk_action_kind_part_uidx (sk_action_id, kind, coalesce(params->>'part','1')) where sk_action_id is not null`
  — for slice B (queued jobs).

No RLS change: Postgres policies have no column lists, and `authenticated`
holds the table-level INSERT grant on both tables (checked on production).

Dry run (production `pblaxsqhjwlqbrwbraxy`, 2026-10-29: one `begin … rollback`
script whose DO block ends in a raised exception, so nothing could commit; RLS
exercised by `set role authenticated` + the JWT claims of a real teacher and her
own class):

| Step | Result |
|---|---|
| columns added | 2 |
| diary index | `UNIQUE … (sk_action_id, COALESCE(student_id, class_id)) WHERE (sk_action_id IS NOT NULL)` |
| generations index | `UNIQUE … (sk_action_id, kind, COALESCE((params ->> 'part'), '1')) WHERE (sk_action_id IS NOT NULL)` |
| re-run (idempotent) | no error |
| as the teacher (`auth.uid()` = her id): class note, action A | inserted |
| same action A, same class | 23505 |
| 2 student reminders, action B, one statement | inserted 2 |
| action B, student 1 again | 23505 |
| a class that is not hers | 42501 (`dn_insert`) |
| two app notes with `sk_action_id` null, same class | inserted 2 (unconstrained) |

After: `diary_notes` 0 rows, `sk_actions` 29 (unchanged), `sk_action_tokens` 0,
no `sk_action_id` column, neither index, `generations` 7172 (unchanged), no
session idle in transaction.

## `diary.note` (teacher, teacher hat, `diary` flag)

| | |
|---|---|
| Capability | `src/sk/capabilities/diary.ts` — `diaryNoteAction` `{tier: confirm, kind: act, roles: [teacher], hats: [teacher], flags: [diary]}` |
| Phrasings | "post a notice to 7B: …", "tell 7B …", "add to the diary for 7B: …", "write in Ali's diary …", "tulis dalam diari 7B …", "maklumkan kepada 7B …", "اكتب في مذكرة 7B …" — the rules router marks them `act` (never a navigate); the model calls the capability |
| Parameters | `classQuery`/`classId` or `learnerQuery`/`learnerId`, `body` (her words; grammar may be tidied, no facts added), `type`, `parentsOnly`, `entryDate` |
| Resolves | class: her own (`pickClass`, as assign); learner: in her own classes' rosters; neither → the selected class, else asks; several → asks |
| Days | the diary's fixed KL day (UTC+8): today / tomorrow / day after / a weekday (its next occurrence, today counts) / next <day> / ISO; none → today; unknown → asks |
| Card | title "Post to 7B's diary"; params `{class_id or student_id, note_type, body, parents_only, entry_date, target_label}` |
| Write | `diary_notes` insert `{author_id: me, class_id or student_id, note_type, body, parents_only, entry_date, sk_action_id}` with the session client |
| Line | "Posted to 7B's diary." |
| Voice | a spoken yes is allowed (one target) |

## `parents.remind` (teacher, teacher hat, `diary` flag)

| | |
|---|---|
| Capability | `src/sk/capabilities/remind.ts` — `parentsRemindAction` |
| Input | `shareId` (a `share` id from `assignments.status`, or `not-done:<shareId>`); none → the most recent `learners` entity `not-done:<shareId>` in the conversation memory ("remind their parents"). The turn route now copies the signed memory's entities into `ctx.recent.entities` |
| Card time | re-reads the share (her own class only) and the not-done learners through the session with the analytics definition (`assignmentStatus`); none → "Everyone … has finished"; more than **40** → "That's more than 40 families — narrow it to one class." |
| Message | default `Reminder: "<kit>" is not done yet — due <day>. Please encourage your child to finish it.` (no child names: the same text goes to every family); a dictated `body` replaces it ("change the message to …" re-issues the card) and is refused if it names a learner of that class |
| Card | title "Remind the parents of 4 learners in 7B"; params `{share_id, generation_id, class_id, student_ids: "<comma-joined uuids>", count, body, class_name, kit_title}` |
| Execution | re-verifies through the session: the class is still hers, the share still exists for that class + kit, each learner is still enrolled and still not done; ONE insert of one `diary_notes` row per remaining learner `{student_id, note_type: "reminder", parents_only: true, body, entry_date: KL today, sk_action_id}` |
| Line | "Sent reminders to 4 families (diary). Left out Ahmad Zaki: already finished." (+ "Left out N no longer in this class."); nobody left → "Everyone has finished now, so I sent no reminders." (ok, nothing written) |
| Voice | a spoken yes is allowed |

The confirm card hides `*_id` / `*_ids` params and labels the rest from
`sk.shell.cardParams` (booleans as Yes/No). Every new line is in ten locales in
`src/sk/shell/act-lines.ts`, mirrored in `sk.shell.act.*` (parity test).

## Not done in slice A

- Migration 0169 is **not applied** (apply before enabling the two actions).
- The older `ACT_LINES` (already used / expired / …) are still English-only.
- Multi-class (`notice.multi_class`, click-only) and school-wide notices.

# S2 slice B — the marking queue and lesson prep

Four registry entries, all `roles: [teacher], hats: [teacher]`, no flag:

| Name | Tier / kind | What |
|---|---|---|
| `marking.next` | immediate / read | the oldest submission awaiting her grade, narrowed by class / learner / kit |
| `marking.grade` | confirm / act | grade one submission (score, out of, her feedback) |
| `lesson.prepare` | confirm / act, **click-only** | generate a full kit for one chapter (spends credits) |
| `lesson.status` | immediate / read | "how's the kit going" — her recent SK-started kits |

The rules router marks the phrasings `act` (EN / MS / AR, never a question,
never a navigate — "next worksheet to mark" must not open the kits page); the
model then calls the capability. Prompt rule 9 names both new actions and tells
the model that `lesson.prepare` needs a click.

## `marking.next` (`src/sk/capabilities/marking.ts`)

| | |
|---|---|
| Phrasings | "mark the next one (from 7B)", "next worksheet to mark", "what's left to mark", "let's do some marking", "tanda yang seterusnya", "mula menanda", "صحح التالي", "التالي للتصحيح" |
| Queue | `submissions.grade_status = 'pending'` (the analytics page's To-grade queue), oldest `submitted_at` first, read through the SESSION client, then re-checked in code against `generations.owner_id = me` (RLS lets a school admin / coordinator read more than her own) |
| Names / titles | learners from her own class rosters; the kit = its title, else its book chapter's title, else "worksheet chapter N" |
| Filters | `classQuery` (learners enrolled in that class of hers), `learnerQuery`, `kitQuery` (title words or a kind word: worksheet / test / exam / quiz / ujian / اختبار), `skipId` |
| Result | entity `{kind: "submission", id, label: "Ali Hassan's worksheet — Plant and Animal Cells", ids: [generation_id, student_id]}`; fact `{learner, kit, kit_kind, submitted_at, answers, auto_score, max_score, remaining_after}` — `answers` is the learner's OWN answers on one line, at most 160 chars ("(uploaded a file)" for a file) |
| Line | "Ali Hassan's worksheet, Plant and Animal Cells — 3 more after this." / "… — the last one to mark." / empty: "Nothing to mark — you're all caught up." (ten locales) |

## `marking.grade` (`marking.ts` resolver, `src/sk/shell/act-marking.ts` execution)

| | |
|---|---|
| Phrasings | "give it 7 out of 10, good work on part 2", "mark it 6/10", "give Ali 8 out of 10", "7 out of 10, well done", "beri 7 daripada 10", "markah 7/10", "أعطه 7 من 10", "الدرجة 9 من 10" (Arabic-Indic digits too) |
| Submission | `submissionId`, else the most recent `submission` entity in the conversation; none → "Which one? Say “next to mark” first …" (no card) |
| Out of | the submission's own `max_score` when it has one (an interactive quiz's auto-scorer total — never overwritten; a different "out of" is refused); a file / max-less row needs hers (asks when missing). A whole number above 0 (`max_score` is an integer column) |
| Checks | `buildGradeUpdate` (grade-update.ts — GradeList's own rules): 0 ≤ score ≤ out of; already graded → "That one is already graded." (no card); not on her kit → not found |
| Card | title "Grade Ali Hassan's worksheet"; params `{submission_id, score, out_of, feedback, learner_label, kit_title}` |
| Execution | params re-checked BEFORE the consume (bounds → `refused` `bad_params`, nothing burned); consume; then as the teacher: re-read the submission and its generation (not visible / not hers → `refused`), still pending (else `already_used`), the live row's max still the card's (else `refused`); `update(buildGradeUpdate(row, …, me, now)).eq('id').eq('grade_status','pending').select('id')`; 0 rows → `already_used` "That one is already graded."; 42501 → `refused` |
| Idempotence | `submissions` has no `sk_action_id` (0169 does not add one): the `grade_status = 'pending'` guard is it — a repeat write matches no row |
| Line | "Graded Ali Hassan: 7/10. Next: Siti Aminah's worksheet — say “next one” to see it." / "… That was the last one to mark." The next submission is remembered as an entity, so after "next one" brings it up, "give it 8 out of 10" grades it |
| Voice | a spoken yes is allowed |

## `lesson.prepare` (`src/sk/capabilities/prepare.ts`, `src/sk/shell/act-prepare.ts`)

| | |
|---|---|
| Phrasings | "prepare Specialised Cells for Friday", "make a kit for chapter 3 of Biology", "generate a lesson kit for …", "prepare chapter 4", "sediakan kit untuk bab 3", "sediakan Sel Khusus untuk Jumaat", "جهّز حزمة للفصل 3", "حضّر درس الخلايا" |
| Book + chapter | her own books, then the school shelf (another teacher's book in her school) — library.find's scope, re-checked in code; `chapterQuery` (title words), `chapterNumber` (as she says it, 1-based → `chapter_ref` = n − 1), `bookQuery`, or `bookId` + `chapterRef` from an earlier turn. Several → her own book wins; still several → asks; a book and no chapter → asks which chapter |
| Existing kit | a presentation of hers for that book + chapter that is not an `error` (any part) → **no card**: "You already have that kit — want me to open it?" + entity `{kind: "kit", id: <presentation id>, ids: [book_id, chapter_ref]}` |
| Rows | `planKit` — the Library's chapter kit exactly (chapter-generate.tsx kit mode): `kitRows({bookId, schoolId, userId, chapterNum, language: book.language, narrationStyle: defaultNarrationForGrade(book.grade)})`, presentation FIRST, minus any legacy chapter-level document. Shared by the card and the insert |
| Credits | `kitCredits(rows, chapterParts)` (kit.ts) — credit_ledger_write's rule: each metered kind 1, the deck free, a chapter-level lesson charged max(parts, 1). A one-part chapter = **6**; an N-part chapter = N + 5 |
| Credits left | `my_fair_use()` through `creditsLeftOf` (utils/fair-use.ts — the meter's `spendable()`, moved out of fair-use-meter.tsx so both read the same figure); omitted when unmetered |
| Card | title "Prepare a kit: Specialised Cells" or "… (for Friday)" — the day is in the title ONLY, nothing is scheduled; params `{book_id, chapter_ref, chapter_title, book_title, credits, credits_left?, warning?, click_only: true}`. A book the junk-upload gate flags adds `warning` ("This upload may not be a textbook — …"): the click is the confirmation and every row is stamped `junk_gate`, as the Library's dialog does |
| Click-only | the handler's `clickOnly: true` (and `CLICK_ONLY`): a spoken yes → `refused` "That one needs a click to confirm.", nothing consumed. The panel never posts a spoken yes for a card whose params carry `click_only`: it says "Needs a click — a spoken yes won't do.", keeps the card, and shows that hint on the card instead of the voice hint. `chapter_ref` and `click_only` are hidden on the card |
| Execution | params checked before the consume; consume; then as the teacher: re-plan (book still on her shelf, still no kit, credits still the card's, gate unchanged) and ONE `generations` insert of the rows, each with `sk_action_id`, through the SESSION client — never the admin client (the trial pin only applies when `auth.uid()` is set) |
| Refusals | the trigger's sentence → one line; the DB's words go to the audit only. duplicate_guard (23505 + "already being made") → "That was just started — give it a moment."; fair use / promo / school trial → "You're out of credits for this month."; trial pin / multi-part trial / console chapter cap → "Your free trial includes one kit for one part of a chapter, so I can't start this one."; RLS `gen_write` / `can_use_book` (42501) → "That book isn't on your shelf."; part-map guard → "That book is being re-read — try again in a few minutes."; lesson tools off / school suspended / expired → "Your account can't start new kits right now — contact support."; 0169's index (any other 23505) → "That was already done."; anything else → `error`, "That didn't go through — nothing was changed. Ask me again." |
| Line | "Started the kit for Specialised Cells — about 10 minutes. Ask me how it's going, or find it in your Library." + entity `{kind: "kit", id: <presentation id>}` |

## `lesson.status`

Her generations with `sk_action_id` set, newest first, grouped by action (a
kit = the presentation and its documents): "Specialised Cells: the lesson is
being made; 1 of 7 pieces ready, 1 failed." 0169 not applied → the
`sk_action_id` read fails with 42703 / PGRST204 and the read falls back to her
newest generations grouped by book + chapter + part (`started_by_sk: false`).
Each kit's fact carries `state` — the ONE kit-state rule, `kitState`
(prepare.ts), which the job tray and the greeting below read too:

| State | When | Tray says |
|---|---|---|
| `failed` | the lesson (presentation) is `error`; or nothing is in progress and nothing came out | "Didn't finish" |
| `making` | a row is still `queued` / `processing` and none is `done` | "Being made" |
| `partial` | a row is still in progress and some are `done` | "2 of 7 pieces ready" |
| `ready` | nothing in progress, the lesson done (a failed document does not fail the kit) | "Ready" |

## The job tray and the next greeting (S2 acceptance)

Final Plan §6 S2: "lesson prep lands in the job tray and the next greeting."
Both read `recentKits` (the same read as `lesson.status`) with
`{since: now − 7 days, skOnly: true}` and map it through `kitState`; neither
has a state rule of its own (`src/sk/shell/kit-tray.ts`).

**Job tray** (`GET /api/sk/shell/tray?path=…`, `src/app/api/sk/shell/tray/route.ts`)

| | |
|---|---|
| Gate | the Shell's (`skEnabled` → signed in → `skShellEnabledFor` / `skShellDecision`); 404 / 401 like the context route. Kits only where `lesson.status` is allowed (teacher, teacher hat) |
| Rows | `generations` with `sk_action_id is not null`, `owner_id = her` (re-checked in code — RLS may show a coordinator more), created in the last 7 days, grouped by action, the presentation row per action; newest first, **at most 3**. 0169 missing → empty (no fallback to Library kits) |
| Each entry | `{id: <presentation id>, title: <chapter title>, state, ready, total, href}` |
| Open | `href` is what `navigate` builds for `{target: "library", bookId}`: `/dashboard?book=<id>`. The Library (book-table.tsx) reads `?book=` (useSearchParams, so a push while already on /dashboard works), opens that book's row and scrolls to it (`id="book-<id>"`). The Library had no per-kit deep link; the book row IS the kit's location |
| Panel | `src/app/dashboard/sk-shell.tsx`: a compact list ABOVE the transcript (`data-sk="kit-tray"`), hidden when empty. Read on open; again the moment a `lesson.prepare` confirm returns `done`; and every **15 s** only while a kit is `making`/`partial`, the panel is open (mounted) and the tab is visible — `shouldPollTray` (`src/sk/shell/client/tray.ts`), the same `visibilityState === "visible"` test as the §2.6 mic gate. Hidden → polling stops; visible again → one read, then the rule decides. A failed read keeps the last state |
| Strings | `sk.shell.tray.{title, making, partial, ready, failed, open}`, ten locales |

**The next greeting** (`/api/sk/shell/context`)

The panel's warm start is now `POST {path, memory?, announced?}` (GET still
answers, with nothing carried). When an SK-started kit of the window has
finished (`ready` or `failed`) and was not announced yet, the greeting LEADS
with one line per kit, **at most 2**, then S0's greeting:

- ready: "Your kit for Specialised Cells is ready — want me to open it?"
- failed: "The kit for Specialised Cells didn't finish — ask me to try again, or check the Library."

(`act-lines.ts` `KIT_READY_NOTICE` / `KIT_FAILED_NOTICE`, = `sk.shell.act.kitReadyNotice` / `kitFailedNotice`, ten locales.)

| | |
|---|---|
| Said once | the announced presentation ids go into the signed memory blob (`SkMemory.announced`, newest first, at most 20 ≈ 1 KB of the 64 000-char ceiling) AND into a small signed note (`sealAnnounced`: `{v, uid, ids}` only, HMAC'd with the memory secret, bound to the user) the panel keeps in localStorage `sk.announced` — the conversation blob lives in sessionStorage and resets after a 4-hour gap or a hat change; the note does not. Prior ids = any blob we signed (even one too old to continue) ∪ the note. No migration |
| "yes" / "open it" | the first READY kit becomes the blob's one-turn `offer` `{target: "library", bookId, label}`. On the next turn the route asks `offerAnswer` (`src/sk/shell/offer.ts`: yes / ok / open it / open the kit / ya / boleh / buka / نعم / افتحها …) BEFORE the bare-ack reply: yes → `navigate` (visibility re-checked) to `/dashboard?book=…`, no model; no / not now / tidak / لا → "All right — it's in your Library whenever you need it." Any other turn runs as usual and `rememberTurn` drops the offer. The kits are also remembered as `kit` entities (`via: "greeting"`) |
| Never blocks | `kitNotices` is time-boxed (1.5 s): past it, or on any error, the greeting is S0's alone and `sk-shell.greeting kit notices skipped: …` is logged server-side |
| Memory | the returned memory is the carried conversation when `openMemory` still accepts it (same session id), else a fresh one — the panel now takes the server's blob rather than preferring its saved copy |

## Marking-queue drain (S2 acceptance)

`src/sk/shell/__tests__/marking-drain.test.ts`: 20 pending submissions in the
act fakes; `marking.next` → `marking.grade` "7 out of 10" → the card confirmed
through `executeAction` (signed token, one consume, GradeList's row with the
pending guard), the returned memory carried on, until "Nothing to mark —
you're all caught up." Asserts 20 grades, each submission exactly once,
oldest first, `remaining_after` 19 → 0 strictly descending, 20 consumes.

## Dry run (production, 2026-10-29)

One `begin; … DO … raise exception …; rollback;` as a real teacher
(`set local role authenticated` + her JWT claims; a teacher with two pending
submissions on her own kits — one interactive with max 10, one file):

| Step | Result |
|---|---|
| marking.next's read (pending, her own generations, oldest first) | 2 rows, the interactive one first |
| grade the FILE row: buildGradeUpdate shape (score 7, max_score 10, feedback, graded, graded_by her) `where id and grade_status = 'pending' returning id` | 1 row |
| the same update again | 0 rows (the guard → already_used) |
| grade the INTERACTIVE row with no max_score in the patch | 1 row, max kept at 10 |
| another teacher's pending submission | 0 rows (RLS `sub_teacher_grade`; she cannot read it either) |
| her queue after | 0 |
| `generations.sk_action_id` read (lesson.status) | 42703 `column "sk_action_id" does not exist` — 0169 not applied; the fallback path is the live one |

Before and after (outside the transaction): `submissions` pending 10 / graded
6 both times; the three rows touched read `pending` with no teacher score
afterwards. A kitRows-shaped insert was **not** dry-run: its triggers enqueue
jobs and touch the credit ledger even inside a transaction — it is proven in
the tests only (act-s2b.test.ts).

## Not done in slice B

- ~~0169 is still not applied~~ — 0169 is APPLIED on production (PR #172
  merged; `generations.sk_action_id` and `diary_notes.sk_action_id` exist), so
  `lesson.prepare` inserts carry their action id and the tray reads them.
- No scheduling: "for Friday" is a title. No push when a kit finishes: the
  job tray shows it while the Shell is open, and the NEXT greeting announces
  it (see "The job tray and the next greeting").
- Multi-part chapters are prepared as a whole chapter (as the Library's chapter
  row does, N + 5 credits); a single part ("part 2 of chapter 3") is not
  offered yet. Trial accounts are refused by the trial pin with the trial line.
- A bare "yes" after "Next: Siti's worksheet …" is still a chat ack (the rules
  router answers acks before the model); the line therefore says "say “next one”".
