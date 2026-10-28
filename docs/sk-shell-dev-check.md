# SK Shell (S0, slice A) — local check

What this slice built: the SK launcher + panel (`src/app/dashboard/sk-launcher.tsx`,
`sk-shell.tsx`), its pure client modules (`src/sk/shell/client/{collector,sse,mic-gate,narration}.ts`),
the `sk-intro` tour constant (`src/sk/shell/tour.ts`), the mounts in the dashboard and
console layouts, and the `sk.shell.*` strings in all ten locales. Slice B supplies the two
endpoints the panel talks to (`GET /api/sk/shell/context`, `POST /api/sk/shell/turn`);
until it lands, the panel opens, shows the fallback greeting and reports "SK couldn't
answer just now" on a question — that is expected, not a bug.

## 1. Environment (`.env.local`, never committed)

```
FEATURE_SK=true
NEXT_PUBLIC_FEATURE_SK=true        # baked at BUILD time — restart `next dev` after changing it
SK_ROLES=teacher                   # the Shell is on for this profile role only
SK_ALLOWED_EMAILS=<your email>     # verified address; bypasses the per-school opt-in
```

With `SK_ALLOWED_EMAILS` unset you would instead need `schools.config.sk_shell = true`
on your school (or `FEATURE_SK_SHELL_ALL_SCHOOLS=true`), or `SK_SHELL_CONSUMER=true`
for an account with no school. `NEXT_PUBLIC_FEATURE_AI_ASSISTANT` can stay as it is: the
layout hands the old Assistant launcher `hidden` whenever the Shell is on, so only one
button sits in the bottom-end corner.

## 2. Open `/dashboard` as a teacher

1. Bottom-end corner: a round **SK** button (`data-tour="sk-launcher"`), expanding to
   "Ask SK" on hover. The old graduation-cap Assistant button is gone.
2. Click it. The panel opens; the header shows "SK, your SketchCast companion",
   the read-aloud toggle (on by default; persisted in `localStorage sk.readAloud`) and ×.
3. **First open only** (no `user_tour_progress` row for `sk-intro`): SK narrates the
   introduction — one hello line, then the six teacher-tour step bodies in tour order
   (library → generate → output → assign → assistant → classes), then the first-task
   offer. Each line lands in the transcript as it is spoken; a **Skip** link sits under
   them. On completion or Skip, ONE `POST /api/tour/seen {tourKey:"sk-intro", version:1,
   status}` is sent (Network tab). Reload: no narration. To hear it again, delete the row
   (`delete from user_tour_progress where tour_key='sk-intro' and user_id=...`) or bump
   `SK_INTRO_TOUR.version`.
   S0 narrates WITHOUT driver.js spotlights — transcript + voice only.
4. Below the transcript: the **caption** line (SK's latest sentence), the empty **job
   tray** ("No jobs running.") and a hidden confirmation-card slot (`data-sk="confirm-slot"`).

## 3. Voice

- **Push-to-talk** (default): press and HOLD the 🎤 button (mouse, touch, or Space/Enter
  on the focused button). The box shows "Listening…"; your words appear in the input as
  you speak; release to stop. Enter sends. Nothing is sent by itself.
- **Mic gate (§2.6)** — with the mic held, switch tabs, click another window, or minimise:
  listening stops at once and does NOT resume when you come back. Press again to speak.
- **Hands-free** (opt-in, bottom-left of the input): toggle it on (persisted in
  `sk.handsFree`), then CLICK the 🎤 once. A red "● Listening…" indicator stays on; each
  utterance is sent as a turn and listening restarts — until you leave the window, go
  quiet for 60 s, click the mic again, or turn hands-free off. It never switches itself
  back on.
- **Stop** (replaces the read-aloud toggle while SK is speaking, writing or narrating):
  aborts the fetch AND the voice AND the narration.

## 4. A turn (needs slice B)

Type a question → a user bubble, an SK bubble that fills as the SSE arrives; tool chips
under it (the `sources` from `done`), and a label badge: "From your data" (grounded),
"General knowledge" (supplementary), "Not available" (declined), "Navigation". A
`navigate` event changes the page immediately and writes "→ Opening {label}" under the
turn. The `memory` blob from `done` (or the context GET) is echoed on the next turn.

## 5. Console

`/console` (staff) mounts the same launcher; it is dark unless the account's own profile
role is in `SK_ROLES` (and the allow-list admits it). No intro narration there.

## Automated checks (all green at the commit)

```
node node_modules/vitest/vitest.mjs run src/sk/shell/client src/i18n src/__tests__/server-client-boundary.test.ts src/tour
node node_modules/typescript/bin/tsc --noEmit -p .
node node_modules/eslint/bin/eslint.js src/app/dashboard/sk-*.tsx src/sk/shell
```

The mic-gate suite asserts `onStop` runs inside the blur/hidden/pagehide dispatch itself
(measured 0.03 ms; the S0 bar is 200 ms).
