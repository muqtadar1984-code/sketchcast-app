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
| Tests | `src/sk/shell/client/__tests__/speech.test.ts` | 33 cases on fake providers and a fake Board (incl. the server client's `lang` and `tts_cap`). Google: `src/sk/speech/__tests__/google.test.ts`, `src/app/api/sk/__tests__/speak.test.ts`. |
| Wiring | `src/app/dashboard/sk-shell.tsx` | One coordinator per panel; every line SK says goes through it. |
| Seam | `src/sk/speech/{provider,browser,polly-client}.ts` | B4/B9; 2026-10-30 the server client also sends `lang` and serves `SK_TTS=google` (below). |
| Google voice | `src/sk/speech/{google,google-auth,google-marks,google-voices,tts-meter}.ts` | 2026-10-30. Server adapter, service-account token, MP3 duration + word spread, voice map, monthly meter. |
| Board | `src/app/present/sk-board-bridge.ts` | Unchanged. The panel adapts `state().paused` / `run("pause")` / `run("resume")`. |

The `StreamSpeaker` in `src/utils/assistant/voice-client.ts` is no longer used
by the SK Shell (the AI Teaching Assistant still uses it). Dictation
(`startDictation`) and the §2.6 mic gate are untouched.

## Which voice

| `NEXT_PUBLIC_SK_TTS` (client) | `SK_TTS` (server) | Result |
|---|---|---|
| unset / anything but `polly` or `google` | — | Browser `speechSynthesis` from the first line. The server provider is never constructed. |
| `polly` | `polly` | `POST /api/sk/speak` per sentence → mp3 + word/viseme marks (Polly). English only: a line in another language is read by the browser voice for it. |
| `google` | `google` | `POST /api/sk/speak` per sentence, with the sentence's `lang`, for EVERY language → mp3 + approximate word marks (Google). |
| `polly` / `google` | unset (or `google` without `GOOGLE_APPLICATION_CREDENTIALS_JSON`) | The route answers 404 → `SpeakUnavailable` → the browser speaks that line and every later one. The server is not asked again this session (`coordinator.mode` flips to `"browser"`). |
| `google` | `google`, the user's monthly characters spent | The route answers 429 `{ reason: "tts_cap" }` → `SpeakUnavailable("tts_cap")` → the browser voice for the rest of the page, as for a 404. |
| `polly` / `google` | set, but a request fails (502, 503 meter error, network, autoplay blocked) | The browser speaks THAT line; the next line asks the server again. Three such failures in a row make the browser sticky (`SERVER_FAILURES_TO_STICK`). A barge-in that aborts the request is not a failure. |

A mismatched pair stays safe. Client `polly`, server `google`: English lines get
the Google en-US voice, other languages the browser. Client `google`, server
`polly`: the first non-English line is refused 404 (Polly's voices are English
only) and the browser voice then sticks for the page, English included.

The look → voice rule is the student page's: `readRigChoice()` (A female /
B male, default B) picks the Polly or Google voice (`pollyVoiceFor` /
`googleVoiceFor`; the route picks again from `look` + `lang`), and a browser
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

## No gap between sentences (2026-10-30)

With a server voice (`polly` or `google`):

- A sentence's audio is requested **the moment the sentence is complete** in the
  stream, in the same tick (before the coordinator's await on the Board video).
- While one sentence plays, the audio of the next `PREFETCH_AHEAD` (2) queued
  sentences is already being fetched. Playback order never changes: a later
  sentence whose audio arrives first waits its turn.
- Every sentence carries its own `lang`, so its own provider and voice. A
  language change (a Marathi answer after an English one) costs no extra step.
- Barge-in (`stop()`) aborts every request still in flight; audio that already
  arrived is dropped unplayed. An aborted request is not a failure: no fallback.
- When the server voice goes sticky (404 / `tts_cap` / three failures), the
  prefetched requests are aborted and the browser voice speaks the rest.
- The browser voice is never prefetched: it synthesises as it speaks.
- `PollyClientSpeechProvider.synthesize()` no longer cancels what is playing,
  so a prefetch cannot cut the current sentence; `cancel()` aborts every request.

Cost: unchanged. Each sentence is requested once, as before. Only sentences a
barge-in drops after their audio arrived are paid for and not heard (at most
two per barge-in).

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

## Google voice (`SK_TTS=google`)

Founder decision 2026-10-30: SK speaks with the same Google premium voices the
lesson videos use. A third backend beside the browser and Polly; Polly is
unchanged and still selected by `SK_TTS=polly`.

### Switch-on (nothing is on until all three are set)

| Env (Vercel) | Side | Value |
|---|---|---|
| `SK_TTS` | server, read per request (a redeploy is enough) | `google` |
| `NEXT_PUBLIC_SK_TTS` | client, **inlined at build time — needs a rebuild** | `google` (with `polly` here the client sends only English lines to the server) |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | server, secret | The whole service-account key JSON (the GCP org forbids API keys; Vercel has no key file). The account needs the Cloud Text-to-Speech API enabled on its project and a role that may call it. Without it the route answers 404 and the client stays on the browser voice. |
| `SK_TTS_MONTHLY_CHAR_CAP` | server, optional | Characters per user per month; default `200000`. |

Auth: `google-auth.ts` signs an RS256 JWT with `node:crypto` (`client_email`,
scope `https://www.googleapis.com/auth/cloud-platform`), trades it at
`https://oauth2.googleapis.com/token` (the JWT-bearer grant; the key's own
`token_uri` is never followed) and caches the one-hour token in module memory
until five minutes before it expires. No new dependency.

### Voices

The worker registry's TEACHER voices (`shared/tts/registry.py`, `g-<lang>-f` /
`-m`). Look A → female, look B (the default) → male. The line's `lang` (the
BCP-47 tag the coordinator speaks in) picks the locale by its primary subtag;
anything unknown → en-US. Only names in `google-voices.ts` are ever sent to
Google.

| SK language (`lang`) | Locale | Female (look A) | Male (look B) |
|---|---|---|---|
| en (and anything unknown) | en-US | `en-US-Chirp3-HD-Achernar` | `en-US-Chirp3-HD-Achird` |
| ar | ar-XA | `ar-XA-Chirp3-HD-Achernar` | `ar-XA-Chirp3-HD-Achird` |
| hi | hi-IN | `hi-IN-Chirp3-HD-Achernar` | `hi-IN-Chirp3-HD-Achird` |
| ur | ur-IN | `ur-IN-Chirp3-HD-Achernar` | `ur-IN-Chirp3-HD-Achird` |
| mr | mr-IN | `mr-IN-Chirp3-HD-Achernar` | `mr-IN-Chirp3-HD-Achird` |
| te | te-IN | `te-IN-Chirp3-HD-Achernar` | `te-IN-Chirp3-HD-Achird` |
| fr | fr-FR | `fr-FR-Chirp3-HD-Achernar` | `fr-FR-Chirp3-HD-Achird` |
| es | es-ES | `es-ES-Chirp3-HD-Achernar` | `es-ES-Chirp3-HD-Achird` |
| pt | pt-BR | `pt-BR-Chirp3-HD-Achernar` | `pt-BR-Chirp3-HD-Achird` |
| ms, ms-arab (Jawi) | ms-MY | `ms-MY-Wavenet-A` | `ms-MY-Wavenet-B` |
| zh | cmn-CN | `cmn-CN-Chirp3-HD-Achernar` | `cmn-CN-Chirp3-HD-Achird` |

zh is SK-only (the worker's lesson videos have no Chinese voice). Jawi lines
go to the ms-MY WaveNet voice in Arabic script, the same locale the browser
voice uses for them today; how well it reads Jawi is unverified.

### Metering

Each line reserves its characters BEFORE synthesis through the AI Tutor's
atomic `tutor_tts_reserve` RPC (service role; provider key `sk:google`, period
`YYYY-MM` UTC). Over the cap → 429 `{ reason: "tts_cap" }` and the client stays
on the browser voice for the rest of the page. A reserve that fails (RPC error,
no service key) → 503: fail closed, never unmetered speech. A reservation is
not refunded when Google then fails, so the count can only run high.

### Cost

Chirp 3 HD: $30 per 1M characters, the first 1M characters a month free.
WaveNet (Malay): $16 per 1M after 4M free a month (founder's brief,
2026-10-30). One request per sentence, billed by input character. A session of
~200 SK lines at ~60 characters is 12,000 characters ≈ $0.36 at the Chirp rate
once the free million is spent; the default cap (200,000 characters) bounds one
user at ≈ $6 a month.

### Lip-sync and word marks (approximate)

Chirp 3 HD ignores `<mark>`, so Google returns no timepoints. As in the worker
(`chunks.interpolate_words`), the clip is measured — here by walking its MPEG
frame headers (ID3 skipped, a Xing/Info/VBRI frame count used when present;
~2.7 words/s if nothing parses) — and the words are spread over it in
proportion to their character length. The worker also trims the ~0.5 s of
silence Chirp leaves at a clip's edges with ffmpeg; this does not, so word
times run slightly early at the start and late at the end. No visemes are
returned (`marks.visemes = []`). The panel's coordinator passes only `onWord`
to the player, so neither Polly's visemes nor these marks move an avatar
mouth on the Shell today; the caption does not highlight yet either.

### Rollback

Unset `SK_TTS` (or set it back to `polly`). The route answers 404 and the
client falls back to the browser voice without a rebuild.
