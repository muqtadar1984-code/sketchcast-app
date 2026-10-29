# SK speech-to-text: Amazon Transcribe streaming (S6 slice B)

**State when merged: OFF.** Both flags default to `browser`, so dictation keeps using the browser's own speech recognition (Web Speech). Nothing is charged until you do all three steps below.

## How it works

1. A user presses the mic. `startDictation()` in `src/utils/assistant/voice-client.ts` is the one swap point; every dictation surface calls it (the SK panel and Board, the assistant panel, the school assistant).
2. With `NEXT_PUBLIC_SK_STT=transcribe`, the browser asks `POST /api/sk/stt/url` for a presigned WebSocket URL. The server signs it locally (SigV4, valid 300 s, the documented maximum) with the same role credentials Bedrock and Polly use. It makes no Transcribe call.
3. The browser streams 16 kHz mono PCM straight to `wss://transcribestreaming.<region>.amazonaws.com:8443`. Vercel never holds the stream.
4. The first final result ends the dictation, the same as the browser recognizer. The client sends an empty audio event and then closes the socket.
5. The §2.6 mic gate (blur, hidden, pagehide, 60 s idle, release) closes the socket and the microphone **in the same tick**.

**Fallback.** Any refusal or failure before any words arrive sends that dictation, and every later one on the page, back to the browser recognizer, and the user sees one line: *"Using your browser's speech recognition."* The triggers are:
- route answers 404, 403, 429 or 400;
- no microphone;
- a socket error;
- a Transcribe exception.

**What the URL route refuses, in order:**

| Condition | Answer |
|---|---|
| `SK_STT` not `transcribe` | 404 |
| SK gate (`FEATURE_SK`, `SK_ALLOWED_EMAILS`, sign-in) | 404 / 401 |
| Language not en / ms / ar / zh | 400 `unsupported_language` |
| A **student** without `voice` consent (a verified guardian's grant, or the school's `sk_learning_memory` switch) | 403 `no_voice_consent` |
| More than 30 URLs this hour for this user | 429 `rate_limited` |
| No AWS credentials | 503 `unavailable` |

- Adults (teachers, parents, school staff) need no consent for their own voice.
- The 30-per-hour limit is **in memory, per serverless instance**. It is a brake on a runaway client, not a billing cap. Use an AWS Budget alarm for the hard cap.
- A hands-free session opens one URL per utterance, so a long hands-free conversation can reach the limit. The user then falls back to the browser recognizer.
- The signed URL is never logged.

## Founder steps to turn it on

### 1. IAM: allow the role to stream

Add this statement to the policy on the role in `AWS_ROLE_ARN` (`sketchcast-app-bedrock`, the role Bedrock and Polly already use). The action name and `"Resource": "*"` follow the Transcribe developer guide, "Setting up a streaming transcription → WebSocket" (checked 2026-10-30). No other permission is needed for the WebSocket API.

```json
{
  "Sid": "SketchCastTranscribeStreaming",
  "Effect": "Allow",
  "Action": "transcribe:StartStreamTranscriptionWebSocket",
  "Resource": "*"
}
```

The full policy document, if you add it as a separate inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SketchCastTranscribeStreaming",
      "Effect": "Allow",
      "Action": "transcribe:StartStreamTranscriptionWebSocket",
      "Resource": "*"
    }
  ]
}
```

### 2. Environment variables (Vercel, Production)

| Variable | Value | Notes |
|---|---|---|
| `SK_STT` | `transcribe` | Server. Without it the route answers 404. |
| `NEXT_PUBLIC_SK_STT` | `transcribe` | Client. It is baked in at build time, so **redeploy** after setting it. |
| `STT_REGION` | optional, default `us-east-1` | The streaming endpoint region. |

The existing `AWS_ROLE_ARN` (Vercel OIDC) is reused unchanged. Without it, the route falls back to `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`).

### 3. Redeploy, then test with your own account

As an adult you need no consent. Watch the AWS bill for Transcribe streaming minutes.

## Turning it off

**Unset `SK_STT`.** The route answers 404 at once, and every client falls back to the browser recognizer (with the one notice). Also unset `NEXT_PUBLIC_SK_STT` and redeploy, so clients stop asking.

Removing the IAM statement also stops it: the socket is refused and the client falls back.

## Languages and regions

| App locale | Transcribe code |
|---|---|
| `en` | `en-US` |
| `ms`, `ms-arab` | `ms-MY` (Jawi is written Malay; it is spoken Malay) |
| `ar` | `ar-SA` (Modern Standard) |
| `zh` | `zh-CN` (also added to the Web Speech table) |

- Every other locale (fr, es, pt, te, mr, hi) stays on the browser recognizer.
- All four languages are listed as **streaming** on the Transcribe "Supported languages" page (checked 2026-10-30) with no regional asterisk.
- **Region caveat.** The same page marks some languages (the asterisked ones) as unavailable for streaming in `af-south-1`, `ap-northeast-1`, **`ap-southeast-5` (Malaysia)**, `ap-southeast-7` and `cn-northwest-1`. Keep `STT_REGION=us-east-1` unless you have checked that region on that page. Also check that the region offers Transcribe streaming at all.

## Cost (indicative, verify)

The S6 design plans with **~US$0.01 per minute** of standard streaming. **This figure is not verified.** The per-minute rate on <https://aws.amazon.com/transcribe/pricing/> is drawn by script and could not be read when this was written. Check the current us-east-1 standard-streaming rate there before switching on. (The commonly quoted first-tier list price has been higher, around US$0.024/min.)

What the pricing page text did say on 2026-10-30: standard usage is **"billed in one-second increments, with no minimum applied"**.

Limits per dictation:
- capped at 60 s;
- ends 8 s after the last words heard;
- ends at the first final result.

## If a Content-Security-Policy is ever added

The app sets none today. If one is added, it must allow:
- `connect-src wss://transcribestreaming.*.amazonaws.com:8443`;
- the worklet script `/worklets/pcm16-worklet.js` (same origin).

## Files

- `src/sk/speech/stt.ts`: flags and language map (pure).
- `src/sk/speech/transcribe-presign.ts`: SigV4 presign. It is checked against AWS's published example and recomputed independently in tests.
- `src/sk/speech/transcribe-server.ts`: region, credentials, URL budget.
- `src/app/api/sk/stt/url/route.ts`: the route.
- `src/utils/assistant/event-stream.ts`: event-stream codec (CRC-32). It is byte-identical to `@smithy/eventstream-codec` in a one-off cross-check.
- `src/utils/assistant/pcm16.ts` and `public/worklets/pcm16-worklet.js`: 16 kHz PCM16. A test pins the two as identical.
- `src/utils/assistant/transcribe-client.ts`: session, fallback, notice.
- Tests:
  - `src/sk/speech/__tests__/stt.test.ts`
  - `src/app/api/sk/__tests__/stt-url.test.ts`
  - `src/utils/__tests__/transcribe.test.ts`
