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
