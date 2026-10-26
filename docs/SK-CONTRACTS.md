# SK AI Tutor — interface contracts (B0)

Status: **draft contracts, approved in principle 2026-10-26.** They are what S1
(the board spike), B3 (package builder) and B4 (teaching loop) build against.
A contract changes only through a PR that updates this file and the tests that
pin it. The plan these serve is `SketchCast SK AI Tutor - Architecture and
Implementation Plan 2026-10-26.md` (Edtech folder), Revision 3.

What B0 already shipped against these contracts: `LLMProvider` cancellation
(`GenerateOpts.signal`, the orchestrator's `cancelled` event, the assistant
route and panel wiring), the Bedrock 5.5 model ids, the homeschool tutor gate,
and the speech-recognition language (`speechLangFor`).

Conventions: all ids are UUIDv7 unless noted (time-ordered, so event logs sort
by id); all times are ms as integers; all coordinates on a board are logical
0–100 (ERE's space) unless the S1 decision says otherwise.

---

## 1. Provider interfaces

Every provider call has a deadline and is cancellable; retries are bounded and
only for transient errors; fallback order lives in config, never in a prompt.
A provider switch never changes graph/package versions, `rule_version` or
stored evidence.

### 1.1 `LLMProvider` (exists: `src/utils/assistant/provider.ts`)

```ts
stream(opts: GenerateOpts): AsyncGenerator<StreamEvent>
GenerateOpts = { system, messages: Turn[], tools?, maxTokens?, temperature?, signal?: AbortSignal }
StreamEvent  = text | tool_call | done{usage} | error{message, retryable?}
```

Rules added in B0:
- When `signal` fires the adapter aborts the upstream request and **ends
  quietly** (no `error`, no `done`). The orchestrator emits exactly one
  `cancelled{fullText, usage, toolCalls}`; a cancelled turn is never banked in
  an answer cache and never shown to a student as a failure.
- Still to add (B4): `strict` tool schemas for TAL output, an error class
  (`transient | refusal | fatal`), and a usage callback that writes to the
  existing `usage_ledger` shape.

### 1.2 `RetrievalProvider` (new, B4)

```ts
retrieve(q: string, filter: RetrievalFilter, k: number, opts: { signal }): Promise<Passage[]>
RetrievalFilter = { productIds: string[], curriculumId?, gradeBand?, rights: ("sketchcast_owned")[], language }
Passage = { text, sourceRef: SourceRef, version: string, rights: string, score: number }
SourceRef = "book:<product>/<chapter>/<sid>#<blockId>" | "article:<topic_article_id>#<section>" | "figure:<visual_asset_id>"
```

Adapters in order of arrival: Postgres full-text search (POC), pgvector, Bedrock
Knowledge Bases (R1 decides). Filters are applied by the **application**
before and after retrieval; a passage outside `productIds` the student may
access is dropped even if the store returned it. Questions, answer keys and
mark schemes are never in any index.

### 1.3 `SpeechProvider` (new, B3)

```ts
synthesize(text, voice: VoiceId, opts: { marks: ("word"|"viseme")[], stream?: boolean, signal })
  → { audio: Uint8Array | ReadableStream, format: "mp3"|"ogg"|"pcm16", marks: Marks }
transcribe(audio: ReadableStream, lang: string, opts: { signal }) → AsyncGenerator<{ partial: string } | { final: string }>
```

**Marks format** (what the board and the avatar consume; §3):
```ts
Marks = {
  words:   { i: number; t0: number; t1: number; text: string }[]   // i = index in the segment's word list
  visemes: { t: number; v: Viseme }[]                                 // v ∈ sil, PP, FF, TH, DD, kk, CH, SS, nn, RR, aa, E, ih, oh, ou
  sentences?: { i: number; t0: number; t1: number }[]
}
```
Adapters: Polly (word + viseme), Google WaveNet (word via `<mark>`), Edge (word
boundaries), Chirp (sentence exact, words interpolated — flagged `estimated`),
Transcribe streaming, browser (client-side only). A provider that cannot
produce a requested mark kind returns `marks.words = []` and the caller falls
back to sentence timing; it never fabricates word times.

### 1.4 `AvatarProvider` (client, B6)

```ts
play(clock: AudioClock, visemes: Marks["visemes"], gestures: Gesture[]): void
Gesture = { t: number; kind: "point"|"write"|"listen"|"think"|"idle"; target?: ElementId; until?: number }
```
The avatar never has its own clock: it follows the board's `AudioClock`.

### 1.5 `ImageProvider` — defined in Workstream A, Stage 5 (`generate(prompt, model, aspect) → bytes|null`).
### 1.6 `InferenceRuntime` — not built; only if a self-hosted model is adopted.

---

## 2. TAL v0.2 — additions to the teaching-action language

Base: `src/ere/tal/types.ts` (v0.1, 19 ops). v0.2 is **additive**; every v0.1
program stays valid. Validation remains the safety model: a program with any
invalid op is rejected whole.

New ops (semantics ported from the worker's `spike/scene_engine/schema.py`):

| op | fields | meaning |
|---|---|---|
| `write` | `id, text, at:{x,y}, size?, style?: "hand"\|"print", sync` | Handwrites text stroke by stroke; `text` is plain text only (no markup); length ≤ 200 chars |
| `erase` | `targets: ElementId[] \| "all", sync` | Removes with an eraser sweep; `"all"` is allowed only when the program also carries `step` |
| `math` | `id, latex, at, size?, sync` | Renders KaTeX → SVG paths, then reveals like `write`; latex is validated against a KaTeX allow-list (no `\href`, `\includegraphics`, `\url`) |
| `reveal` | `target: ElementId, order?: "stroke"\|"region"\|"fade", duration?, sync` | Reveals an already-placed illustration along its drawing order (from the registry's `drawing_order`) |
| `particles` | `id, region: ElementId, count ≤ 60, motion: "random"\|"gradient", from?, to?, sync` | Diffusion-style animation inside a region |

Changed semantics:
- `ask`, `expect`, `wait_for_student` become **real**: the player raises
  `player.ask` / `player.expect` events and pauses the clock until the server
  resumes it. They are no longer auto-continue no-ops.
- `sync` gains `{ word: i }` resolution against `Marks.words` (already in the
  grammar); `{ at: "start"|"end" }` resolves to the segment's audio bounds.

Security (applies to every op): text fields are plain strings rendered with
`textContent`; attribute values are validated (numeric and clamped for
coordinates; enum for styles); ids match `^[a-z][a-z0-9_.-]{0,63}$`; no `href`,
`style`, `on*`, `foreignObject`, external URLs. The adversarial suite in S1
pins this.

---

## 3. Lesson package / teaching graph manifests

### 3.1 `teaching_graph` (one per product × chapter × version × language)

```jsonc
{
  "graph_id": "uuid", "product_id": "uuid", "chapter": 2, "version": 3, "language": "en",
  "status": "draft|validated|live|retired",
  "built_from": { "manuscript_version": "ch02-draft@7333d27", "models": { "author": "claude-opus-5-5", "check": "gemini-3.5-pro" } },
  "units": [
    {
      "unit_key": "u4", "teaching_objective_id": "uuid", "title": "Total magnification",
      "prereqs": ["u2"], "order": 4,
      "assets": [ { "asset_id": "uuid", "kind": "explain", "style": "main", "segment": "s3://…/u4-explain-main.json" },
                  { "asset_id": "uuid", "kind": "alt",     "style": "visual" , "segment": "…" },
                  { "asset_id": "uuid", "kind": "demo",    "segment": "…" },
                  { "asset_id": "uuid", "kind": "misconception", "misconception_ref": "block:…", "segment": "…" },
                  { "asset_id": "uuid", "kind": "practice", "item_ids": ["tq_…"] },
                  { "asset_id": "uuid", "kind": "check",    "item_ids": ["tq_…", "tq_…", "tq_…"] } ],
      "figures": ["visual_asset_id", "…"]
    }
  ],
  "validation": { "tal": "pass", "science": "pass", "render_golden": "pass", "reviewed_by": "uuid", "at": "ISO" }
}
```

Rules: `check.item_ids` ≥ 3 deterministic items per unit; every `item_id`
must have a **validated** `teaching_objective_id` equal to the unit's; a unit
whose teaching objective has no verified curriculum mapping is still
teachable (it just never reports as curriculum coverage).

### 3.2 Segment manifest (one per asset of kind explain/alt/demo/misconception)

```jsonc
{
  "segment_id": "uuid", "asset_id": "uuid", "version": 3, "language": "en", "voice": "polly:Joanna",
  "audio": { "uri": "s3://…/u4-explain-main.mp3", "duration_ms": 93400, "sha256": "…" },
  "marks": { /* §1.3 Marks */ },
  "tal": { /* TAL v0.2 program; sync via {word:i} */ },
  "gestures": [ { "t": 1200, "kind": "point", "target": "fig.eyepiece" }, … ],
  "figures": ["visual_asset_id"],
  "origin": "prepared|generated", "generation_rung": null,
  "checkpoints": [0, 15000, 30000, …]     // safe resume points, ms
}
```

`origin: "generated"` segments carry `generation_rung ∈ {1,2,3}` per the safe
live-generation ladder (plan §3) and are queued for offline review before they
can become `prepared`.

---

## 4. `/api/sk/*` route schemas

All routes: cookie auth; `FEATURE_SK` gate; every mutating request carries an
`eventId` (UUIDv7, client-generated); the server stores `(session_id, event_id)`
unique and **returns the stored result on a repeat** (idempotent).

| Route | Body | Response |
|---|---|---|
| `POST /api/sk/session` | `{ eventId, productId, chapter, resume?: boolean }` | `{ sessionId, graphVersion, state, cursor, bookmarks, access: { source, expiresAt, allowance } }` |
| `GET  /api/sk/session/:id` | — | same shape (rehydrate) |
| `POST /api/sk/turn` | `{ eventId, sessionId, utterance: { text, modality: "typed"\|"spoken", transcriptConfirmed? }, cursor }` | **SSE**: `meta{intent, route?}` → `text` / `tal` / `gesture` / `speech{marksUri,audioUri}` … → `done{latency, usage, cancelled?}` |
| `POST /api/sk/command` | `{ eventId, sessionId, command: "repeat"\|"slower"\|"erase"\|"continue"\|"skip"\|"goto"\|"practise"\|"return"\|"explain_again", args? }` | `{ state, cursor, bookmarks }` |
| `POST /api/sk/answer` | `{ eventId, sessionId, itemId, attemptNo, response, modality, transcriptConfirmed }` | `{ outcome, score, max, feedback, hintAvailable, independent }` — graded once per `(itemId, attemptNo)` |
| `POST /api/sk/redeem` | `{ eventId, code, forChildId? }` | `{ grantId, productId, expiresAt }` or `{ error }` (rate-limited) |

Intent router output (Haiku, strict JSON): `{ kind: "command"|"route"|"question"|"answer", command?, route?, needsGrounding: boolean, confidence }`.
The route planner is deterministic code; the router may only *propose*.

---

## 5. Event-ID and idempotency rules

1. Every student event, turn request and answer submission carries a
   client-generated UUIDv7 `eventId`.
2. Unique keys: `sk_events (session_id, event_id)`, `item_attempts (session_id, item_id, attempt_no)`.
3. A duplicate (retry, double-click, reconnect replay) returns the stored result
   and performs no side effect: no second grade, no second charge, no second
   drawing.
4. The board is **snapshot-authoritative**: the server returns the new snapshot
   + this turn's events; the client never re-applies on its own. Reconnect =
   GET session → re-render from snapshot.
5. Checkpoints: `sk_sessions.cursor = { graphVersion, unitKey, assetId, segmentId, t }` plus the bookmark stack are written on every transition; a reload resumes at the last checkpoint ≤ `t`.
6. Grading runs once per `(item, attempt_no)`; `mastery_state` is recomputed from `item_attempts` by `rule_version`, never edited directly.

---

## 6. Data model pointers (B1/B4/B5/B7 migrations, branch database first)

`sk_book_products`, `sk_book_units`, `teaching_objectives`, `objective_curriculum_map`,
`teaching_graph`, `teaching_assets`, `sk_sessions`, `sk_events`, `item_attempts`,
`mastery_state`, `consents`, `publishers`, `print_batches`, `book_codes`,
`book_access_grants`, `sk_usage`. Columns as in plan §10–§11. All additive;
expand-then-contract; nothing applied to production without separate approval.
