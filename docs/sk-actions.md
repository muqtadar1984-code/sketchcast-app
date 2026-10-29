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
