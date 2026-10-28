# SK's voice on the Shell and the Classroom Board (S1 slice E)

Status 2026-10-28: built on `s1/slice-e`. Final Plan 2026-10-28 §2.4 ("SK adds
nothing unless asked"; the Board uses the teacher's device microphone only) and
§2.6 (four lifecycles; this slice is lifecycle 2, speech playback). Verified by
unit tests and compile only — no browser run; nothing in production changes
until the branch merges and deploys.

## Where it lives

| Piece | File | Role |
|---|---|---|
| Coordinator | `src/sk/shell/client/speech.ts` | PURE. The queue, the pause/resume rule, barge-in, provider selection, sentence splitting. Providers, the Board and the callbacks are injected. |
| Tests | `src/sk/shell/client/__tests__/speech.test.ts` | 27 cases on fake providers and a fake Board. |
| Wiring | `src/app/dashboard/sk-shell.tsx` | One coordinator per panel; every line SK says goes through it. |
| Seam | `src/sk/speech/{provider,browser,polly-client}.ts` | Unchanged (B4/B9). |
| Board | `src/app/present/sk-board-bridge.ts` | Unchanged. The panel adapts `state().paused` / `run("pause")` / `run("resume")`. |

The `StreamSpeaker` in `src/utils/assistant/voice-client.ts` is no longer used
by the SK Shell (the AI Teaching Assistant still uses it). Dictation
(`startDictation`) and the §2.6 mic gate are untouched.

## Which voice

| `NEXT_PUBLIC_SK_TTS` (client) | `SK_TTS` (server) | Result |
|---|---|---|
| unset / anything but `polly` | — | Browser `speechSynthesis` from the first line. The server provider is never constructed. |
| `polly` | `polly` | `POST /api/sk/speak` per sentence → mp3 + word/viseme marks (Polly). |
| `polly` | unset | The route answers 404 → `SpeakUnavailable` → the browser speaks that line and every later one. The server is not asked again this session (`coordinator.mode` flips to `"browser"`). |
| `polly` | `polly`, but a request fails (502, network, autoplay blocked) | The browser speaks THAT line; the next line asks the server again. Three such failures in a row make the browser sticky (`SERVER_FAILURES_TO_STICK`). A barge-in that aborts the request is not a failure. |

The look → voice rule is the student page's: `readRigChoice()` (A female /
B male, default B) picks the Polly voice through `pollyVoiceFor`, and a browser
voice by name through `pickBrowserVoice` — only among voices of the page's
language; when the language has none, `browser:default` lets the engine choose
by the utterance's `lang` (`pageSpeechLang()`). One provider is built per
language and reused.

## Pause / resume and barge-in rules

| Situation | What SK does to the video | Why |
|---|---|---|
| SK has a line to say and the video is playing | Pauses it once, before the first line | "The video paused while SK speaks." |
| The queue drains (last sentence of the whole queue, across `say` calls) | Resumes it — only if SK paused it | SK gives back exactly what it took. |
| The video was already paused (by the teacher) | Never paused again, never resumed | Never resume a video the teacher paused. |
| The teacher presses play on the Board while SK is still talking | SK neither re-pauses nor resumes; the next ask is a fresh claim | The teacher took playback back. |
| A `board` event (a move with a `say` line) | Pause if playing → speak the line → run the move → **no resume** | The move owns the Board's state: `slide` leaves the end frame paused, `intro`/`segment`/`resume` are already playing, `pause` is the teacher's "stop there". No pause/resume fight. The pause happens even with read-aloud off or an empty line (slice B paused before every move; that stays). |
| The move's line is queued, then a text sentence streams in | The move's line keeps its place (queued synchronously) | Order is the server's order. |
| Barge-in: push-to-talk pressed, hands-free capture started, a new question sent | `stop()`: queue cleared, provider cancelled, pending `say` promises resolve, video **not** resumed | The teacher is about to speak; "continue" is one word away and a video that restarts by itself surprises a class. |
| Stop button, read-aloud toggled off, `pagehide`, panel unmount | `stop()`, same rule | Explicit stop / navigation away (§2.6). |
| Read-aloud off | `say` resolves at once; nothing queued; the video is never touched for speech | The transcript still carries the words. |

`announceMove(line, run)` is the single entry point for a Board move; `say` is
for everything else (SK's answer sentences via `stream()`, the confirm result
line, the intro narration).

## Mic on the Board

Nothing new. Push-to-talk and the hands-free opt-in are the Shell's, behind the
§2.6 mic gate (blur / hidden / pagehide / idle 60 s / release). The Board has no
keyboard shortcuts of its own on `/present` (the only `keydown` listener under
`src/app/present` is none; `side-drawer.tsx` handles Escape), so the SK input
needs no propagation guard — the student page's Space-to-pause is on
`/sk/[product]/[chapter]`, not the Board. Hands-free does not barge in by voice
mid-sentence (the device would hear SK's own speaker); the teacher's utterance
barges in when it is sent, which is when the answer stops.

## Sentence splitting

`StreamSpeaker`'s rule — split on whitespace after `.` `!` `?` — widened to the
Arabic `؟` and the Devanagari `।`. Every sentence passes through
`speakableText` (markdown → words); a sentence that was only markup speaks
nothing. `stream().push(chunk)` speaks whole sentences as the answer streams;
`flush()` speaks the tail when the turn ends.

## Known limits (follow-ups, not in this slice)

- `run("pause")` on the bridge drops the segment-end watcher. When SK speaks
  during a `segment` move (teacher asks a question mid-segment) and gives the
  video back, it plays on past the segment's end. Fix belongs in the bridge
  (keep the watcher across a pause/resume pair), not here.
- A teacher who presses play and then pause on the Board's own controls while
  SK talks is indistinguishable from "still paused by SK"; SK will resume at the
  end. Detecting it needs a pause event from the controller.
- `onWord` marks are passed through (`WordMark {charIndex, t, text}`) but the
  Shell's caption does not highlight yet.
- No transcript line announces the fallback to the browser voice (no new i18n
  string); it is logged to the console.
