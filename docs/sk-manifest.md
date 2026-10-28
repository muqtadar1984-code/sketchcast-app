# SK Kit Manifest — derivation on demand, storage, read path (S1 slice A)

Status 2026-10-28: built and unit-tested on branch `s1/slice-a`; live-proved
against production READS with an in-memory store (nothing written to
production). Final Plan §5.1–5.2, §9.1, §9.6.

## 1. Where it lives

| File | Role |
|---|---|
| `src/sk/manifest/derive.ts`, `prompts.ts` | M1's pure derivation and versioned Haiku prompts — unchanged by this slice |
| `src/sk/manifest/load.ts` | `loadKitInput(admin, generationId)`: generation row, artifacts rows, script.json parts, the worksheet's questions file, concepts → the `KitInput` derive.ts expects |
| `src/sk/manifest/service.ts` | `deriveAndStore(admin, generationId, opts)`: claim → load → two Haiku passes → `assemble` → `sk_manifests` row `ready` (or `failed`) |
| `src/sk/manifest/store.ts` | `readManifest(admin, generationId)`: the ONLY way a manifest leaves the table; re-verifies the pins on every read |
| `src/sk/manifest/board.ts` | `toBoardManifest(m, part)`, `segmentForConcept`, `itemsForSegment`, `segmentIndexFor` — pure, for the Board controller and the moves slice |
| `src/app/api/sk/manifest/route.ts` | `GET ?generationId=` (read result) · `POST {generationId}` (derive, then read result); one `sk_actions` row per POST |
| `src/sk/manifest/__tests__/fixtures/*.json` | three real M1 manifests (derived data) the board suite runs on |

## 2. Why the app derives, not a worker job (deviation from plan §5.2)

Plan §5.2 says "a queued job (`kind: "manifest"`)". Decided 2026-10-28 against
it: the worker's generic lane claims ANY unknown `jobs.type` and dispatches by
`generations.kind`, so a "manifest" job carrying a presentation's generation_id
would REBUILD THE KIT. Derivation therefore runs in the app, inside the POST
request (`maxDuration = 60`), and `sk_manifests.status` is the queue.

## 3. Status machine and claim rules

| `status` | Meaning |
|---|---|
| `building` | a derivation is running; claimed at most once per 10 minutes |
| `ready` | served — after the read path re-verifies the pins (§4) |
| `stale` | the 0163 trigger (presentation's `artifacts` rows changed) or the read-time re-check flipped it |
| `failed` | the last derivation failed; `stale_reason` holds the error (≤ 300 chars) |

`deriveAndStore` claims like this (optimistic: every update is keyed on the
status it read, so two concurrent POSTs cannot both derive):

- no row → `insert … status='building'`; a `23505` means another request just claimed → `{status:"building"}`
- row `stale` or `failed` → `update … set status='building' where status = <that value>`; zero rows → `{status:"building"}`
- row `building` younger than 10 min → `{status:"building"}`, nothing loaded, no model call
- row `building` 10 min or older → treated as abandoned; re-claimed keyed on `updated_at`
- row `ready` → `readManifest` first: still fresh → served as is (no derivation); drifted → it is now `stale` and claimed as above

Budget guard: more than 60 segments or more than 80 items → `failed` with
`too large: …`, before any model call. Any other failure (load refusal, model
error, write error) → `failed` with the reason; `deriveAndStore` never throws.

## 4. The read-path rule (§9.6 "a stale Manifest is never served")

`readManifest` returns a manifest **only when** the row is `ready` **and**
`isStale(manifest, liveArtifactRows, liveFormatVersion) === false`, where the
live rows are re-read from `artifacts` for every generation the manifest pinned
(its own plus the worksheet's — recovered from the second path component of
`pinned.artifact_paths`) and the live format_version from `generations.params`.
If the re-check finds drift, the row is flipped to `stale` by the reader itself
and `{status:"stale"}` is answered. Every other status answers with that status
and never a manifest. This is belt and braces over the 0163 trigger: the trigger
is keyed on the presentation's generation_id and so does not see the pinned
worksheet's rows; the re-check does.

## 5. What is pinned, and what is loaded

- Only `kind = presentation`, `status = done`, `withdrawn_at is null`; anything else is a `failed` row with the refusal.
- `artifacts` rows of the presentation **and** of the newest DONE worksheet of the same owner on the same chapter (book kits: `book_id` + `chapter_ref`) or article (catalogue kits: `params.article_id`). One worksheet: a second version of the same questions would only duplicate items. A newer worksheet appearing later does NOT invalidate the manifest (S1 limitation; the next POST after a stale/failed picks it up).
- `script_json` per part, sorted by the `_partN` suffix; an unreadable part is skipped; none → `completeness.script = "missing"`.
- Items: `q_id = ws:<worksheet id first 8>:<question id>` (the M1 CLI used `ws:<question id>`; the fixtures still carry that form).
- Concepts: `chapter_grounding(book_id, chapter_num).concepts.concepts.concepts[]` (older shapes tolerated) on the book path, else `topic_articles.objectives[{id,text}]` on the catalogue path. None → `completeness.concepts = "none"` and every mapping `unavailable` with a reason.

Model: `claude-haiku-5-5` through `src/utils/claude-backend.ts` (`claudeClient()`
/ `claudeModel()`; Vercel OIDC role in production, static or ambient AWS
credentials otherwise; no `temperature`). ONE call for the segments the
mechanical rules did not place, ONE for the questions without a valid
`objective_ref`; both skipped when the kit has no concept source.
`derived_by` records `{model, prompt_versions, at, usage{input_tokens, output_tokens, usd}}`.

## 6. The S1 visual limitation

The visual pass (`m1-visual-v3`) judges the segment's slide FRAME, and the app
has no ffmpeg to extract frames. The mechanical `hold_secs` / heading-change
heuristics are NOT a visual verdict (M1 report §3b: reused boards and misleading
boards look identical to them). So in S1 **every lesson segment is
`visual = {status:"unknown", show:"caption_only", reason:"no frame check in app (S1)"}`**,
and `moves.slide` is `degraded` on every manifest the app derives — UNLESS a
previously stored manifest for the SAME `artifacts_hash` already carries a
frame-judged verdict (`judged_by.model` set) for that segment key: those are
carried over verbatim (with their `visual_metrics`), a carried `fallback_frame`
is re-verified against the carried target, and `assertNoMisleadingFrame` runs.
Lifting the limitation needs the founder's worker asset-correctness gate plus a
frame-aware pass (worker-side, where the frames are) that writes verdicts into
the stored manifest.

## 7. Route

`/api/sk/manifest` — gate: `skEnabled()` + signed in + `skShellEnabledFor`
(404 off, 401 signed out); then the generation must exist (404) and belong to
the caller, or the caller is `PRESENT_ALLOWED_EMAILS` staff (403 otherwise).
The owner check applies to GET too: the manifest carries the kit's narration.
The admin client is created only after the gate. POST writes one
`SkActionRow` (`action: "manifest.build"`, `kind: "job"`, `tier: "queued"`,
`ok` for ready|building) through `auditSinkFor(admin)`.

## 8. Live proof (2026-10-28, production reads only)

`deriveAndStore` run locally for `eef426bd-523b-4fed-827c-95421263d89a`
(Biology, catalogue) with the real admin client for reads/downloads and
`sk_manifests` redirected to an in-memory fake; real-table writes trapped
(0 attempted). Haiku via Bedrock on the ambient `~/.aws` chain.

| | |
|---|---|
| result | `ready` in 20.8 s (downloads + 2 Haiku calls) |
| segments | 19 (18 lesson + 1 outro), 1 part, format_version 3, en |
| completeness | video ok · script ok · questions ok · concepts ok (article objectives o1–o6) |
| concept links | 18/18 lesson segments available (15 with a concept, 3 overview/null), all by model (18 went to the model) |
| items | 10 (newest worksheet `180d55c7`), 9/10 available, 10/10 with teaching segments |
| moves | intro/segment/practise/explain available; slide degraded (S1 visual); walkthrough/remediate degraded (1 item unavailable) |
| visual | 19 × caption_only (18 "no frame check in app (S1)", 1 outro) |
| cost | 9,879 in / 2,428 out tokens = **$0.0022** |
| vs the M1 CLI manifest | concept agreement 18/18; item primary-concept agreement 7/10 on the overlapping questions; `artifacts_hash` differs (M1 pinned the deck and both worksheets) |
| read path | `readManifest` over the live rows → `ready`; `toBoardManifest(m, 1)` → 19 segments, last end 851.53 s |

## 9. Tests

`src/sk/manifest/__tests__/{load,service,store,board}.test.ts` and
`src/app/api/sk/manifest/__tests__/route.test.ts` — 62 tests. The fakes are in
`src/sk/manifest/__tests__/fake-admin.ts` (filters incl. `params->>key`,
update…select, insert 23505, storage downloads).

Run: `node node_modules/vitest/vitest.mjs run src/sk/manifest src/app/api/sk/manifest`
