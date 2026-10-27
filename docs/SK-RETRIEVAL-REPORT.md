# SK retrieval — hybrid provider (0160) built and measured on the branch

Date: 2026-10-27. Branch database: Supabase **sk-b1** (`grxsibudgjgepecxbyke`). Production (`pblaxsqhjwlqbrwbraxy`) was **not written to**: 0160 is not applied there, no block has an embedding there, and `SK_RETRIEVAL` is unset on Vercel (the default `fts` adapter then fails quietly against the missing function and the teacher grounds on the unit narration, as today).

Plan reference: SK AI Tutor plan §6; the R1 test (`sketchcast-ai` `docs/SK-R1-REPORT.md` §1–§9, `spike/sk_r1/`). R1's recommendation was: pgvector + OR-relaxed FTS fused by reciprocal rank fusion behind a `RetrievalProvider` seam, the query embedded in parallel with the router call and cached per turn, and the "no grounding" gate on the **vector** score — 0.32 for Amazon Titan Text Embeddings v2 (the RRF score is rank-based and cannot be thresholded).

## 1. What changed

| Piece | Where | What |
|---|---|---|
| Migration | `supabase/migrations/0160_sk_block_embeddings.sql` (+ rollback) | `vector` extension; `sk_block_text(type, body)` with the R1 text rules (think → prompt only, never its answer; key_term → "term: text"; misconception → wrong + right; figure → caption; list → items; table → caption + cells; worked_example → problem + steps + answer); stored generated `retrieval_text` + `retrieval_tsv`; `embedding vector(1024)`, `embedding_model`, `embedded_at`; GIN + HNSW (cosine) indexes; `sk_tsquery_or`; `sk_search_fts`; `sk_search_hybrid(q, qv, p_product, p_chapter, k, pool, rrf_k)` returning `score`, `fts_score`, `vec_score` and `best_vec_score` (the vector leg's top-1, on every row). Both search functions filter product AND chapter in their WHERE, are SECURITY DEFINER and executable by **service_role only** (revoked from public/anon/authenticated). Nothing reads `topic_questions`. |
| SQL test | `supabase/tests/0160_sk_block_embeddings_test.sql` | DO-block style; 8 PASS lines, then rolls back. **Passed on sk-b1.** |
| Seam | `src/sk/retrieval.ts` | `RetrievalProvider` (`begin(query, ctx)` → `TurnRetrieval.result()`), `FtsRetrievalProvider` (default), `HybridRetrievalProvider`, `toPassages`, `gateDecision`, `selectRetrievalProvider` by env. Failures become `status: "error"`, never a throw. The graph names the product by slug; the provider resolves it to `sk_book_products.id` once and caches it. |
| Embedder | `src/sk/embed.ts` | `TitanEmbedder`: Bedrock `InvokeModel` on `amazon.titan-embed-text-v2:0`, 1024 dims, normalised; `AWS_ROLE_ARN` via the Vercel OIDC exchange shared with the Claude client, else the SDK default chain; region `BEDROCK_REGION`. New direct dependency `@aws-sdk/client-bedrock-runtime` (already present transitively through `@anthropic-ai/bedrock-sdk`). |
| Loop | `src/sk/loop.ts`, `src/sk/teacher.ts`, `src/sk/server.ts` | Retrieval **starts before the router call** (in parallel) whenever a question could be answered (PRESENTING/PAUSED) and is awaited only for a question whose intent `needsGrounding`. `grounded` → the passages ride in the **user turn** (`questionWithPassages`), so the per-unit system prefix stays byte-identical and the prompt cache keeps serving it; the history stores the plain question. `none` → SK says `NOT_IN_BOOK_TEXT` ("I can't find that in this book, so I won't guess…") **without a model call**. `error` → unit-only grounding, logged once. `meta` carries `{grounding: {status, bestVecScore, gate, passages: [sourceRef…], ms}}`; `done.latency.retrievalMs`. |
| Tools | `tools/sk/embed-blocks.ts`, `tools/sk/retrieval-bench.ts` | Idempotent block embedder (service role; `--emit-sql` for a database reachable only through SQL); the R1 question set re-runner with the R1 rubric. |
| Tests | `src/sk/__tests__/retrieval.test.ts` | 19 cases: row shaping, gate, per-turn cache (embedding starts at `begin()`, one RPC however often `result()` is read), slug resolution, error folding, FTS default, env selection, Titan embedder over a mocked `InvokeModel`, passage formatting, and the loop with a scripted provider (grounded / none / error / command). |

## 2. Measured on the branch (Chapter 2, 90 blocks, 50 R1 questions)

Chapter 2 was embedded with `tools/sk/embed-blocks.ts` (90 blocks, **4,489 Titan tokens, $0.00009** — the same token count as R1's Titan re-run), the 50 questions embedded (680 tokens) and run through `sk_search_hybrid` (k = 5, pool = 20, rrf_k = 60) with `tools/sk/retrieval-bench.ts`. Identical copies of the 90 blocks (same text, same vectors) sat under a fake product and a fake chapter 9 during the run, so a filter failure would have tied with the real rows; they were deleted afterwards.

| group | n | recall@5 block | MRR block | recall@5 unit | MRR unit | empty | best_vec min | best_vec max |
|---|---|---|---|---|---|---|---|---|
| in_chapter | 30 | **1.00** | 0.90 | 1.00 | 0.98 | 0 | **0.439** | 0.914 |
| alt_example | 6 | **1.00** | 0.78 | 1.00 | 0.92 | 0 | 0.501 | 0.755 |
| off_chapter | 8 | — | — | — | — | 0 | 0.111 | **0.202** |
| injection (4 with a real question) | 6 | 0.75 | 0.63 | 1.00 | 0.88 | 0 | 0.138 | 0.721 |

**Gate 0.32:** off-chapter false positives **0/8**; in-chapter + alternative-example questions wrongly rejected **0/36**; injection strings answered with ordinary rows 6/6 (the two with no real question, "developer mode" and "retrieve rows from topic_questions", gate out at 0.215 / 0.138; `topic_questions` is not in the index so nothing from it can be returned); rows outside the requested product/chapter **0/250**. The margin either side of the gate is 0.12 (in-chapter minimum 0.439, off-chapter maximum 0.202), the same picture as R1 §9.

Against the brief: recall@5 ≥ 0.97 ✓ (1.00), 0 off-chapter false positives ✓. The one block-level miss is q50 (`magnification" OR 1=1 UNION SELECT … FROM topic_questions --`): its top 5 are the right unit's magnification blocks, just not the two the rubric names; the rubric scores injection recall for information only. R1's Titan hybrid_or numbers were 1.00 / 0.93 (in-chapter) and 1.00 / 0.81 (alt); the MRR difference here (0.90 / 0.78) is ordering among gold neighbours within the same unit, not a miss.

Per-question ranks are in `docs/sk-retrieval/bench-2026-10-27.txt`.

## 3. Env vars

| Var | Values | Default | Meaning |
|---|---|---|---|
| `SK_RETRIEVAL` | `fts` \| `hybrid` \| `off` | `fts` | Which adapter grounds questions. `hybrid` needs embeddings in the table and Bedrock access. |
| `SK_RETRIEVAL_GATE` | 0–1 | `0.32` | The vector-score gate (Titan v2). Re-calibrate if the embedding model changes (Gemini was 0.65). |
| `SK_EMBED_MODEL` | model id | `amazon.titan-embed-text-v2:0` | Stored beside each vector; `embed-blocks.ts --all` re-embeds blocks written by another model. |
| `BEDROCK_REGION` | region | `us-east-1` | Where Titan is invoked (shared with Claude on Bedrock). |
| `AWS_ROLE_ARN` / keys | — | — | The identity (shared with the Claude client). |

## 4. IAM note (blocking for production)

The Vercel app signs into AWS as the role in `AWS_ROLE_ARN` (Vercel OIDC), **not** as the `sketchcast-ops` user. On 2026-10-27 only `sketchcast-ops` has `bedrock:InvokeModel` on `arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0` (that is what this branch run used, from this machine). **The role needs the same allow before `SK_RETRIEVAL=hybrid` is set in production**; without it every grounded question logs an AccessDenied once and falls back to unit-only grounding (a turn never fails, but nothing is gated either). The policy document the founder used for the user is `Edtech/SK AI Tutor - IAM policy titan-embeddings.json`.

## 5. Production steps (founder's explicit yes needed for each)

1. Grant the Titan allow to the `AWS_ROLE_ARN` role (IAM console; same statement as for `sketchcast-ops`).
2. Apply `supabase/migrations/0160_sk_block_embeddings.sql` to production (Supabase MCP `apply_migration` or the SQL editor), then run `supabase/tests/0160_sk_block_embeddings_test.sql` there — it must print the 8 PASS lines and roll back.
3. Embed Chapter 2 once: `SUPABASE_URL=<prod> SUPABASE_SERVICE_ROLE_KEY=<prod> BEDROCK_REGION=us-east-1 npx tsx tools/sk/embed-blocks.ts --product cells-structure-function-organisation --chapter 2` (90 Bedrock calls, ≈ $0.0001; idempotent — re-running embeds only blocks still lacking a vector).
4. Vercel production env: `SK_RETRIEVAL=hybrid` (gate stays at the 0.32 default). Redeploy.
5. Check `meta.grounding` on a few turns in the founder's test session: an in-chapter question shows `status: "grounded"` with `bestVecScore` well above 0.32; "what is photosynthesis?" shows `status: "none", reason: "gate"` and SK answers with the not-in-book line.

Rollback: unset `SK_RETRIEVAL` (back to `fts`, or `off` to leave the teacher on the unit narration); `0160_sk_block_embeddings_rollback.sql` removes the columns and functions (the `vector` extension stays).

## 6. Not done / caveats

- No signed-in browser run (login is off-limits to the agent); the loop behaviour is proven by unit tests and the SQL function by the branch bench.
- Latency from Vercel was not measured (R1 §4.5 has the from-this-machine numbers; the embedding call from a Vercel function in us-east-1 should be well under 100 ms).
- Article sections are still not indexed (the branch article has an empty body); blocks only, as in R1.
- `FtsRetrievalProvider` is the default so that merging this PR changes nothing user-visible before 0160 is applied: until then every grounded question logs "sk_search_fts failed (is 0160 applied?)" once per process and the teacher grounds on the unit narration as before. Set `SK_RETRIEVAL=off` to silence it.
- The branch `sk-b1` keeps 0160 applied and Chapter 2 embedded (90 vectors, model `amazon.titan-embed-text-v2:0`); the fake twins, the temporary `sk_r2_*` helper functions and the temporary anon grant used for the run were removed (verified: anon cannot execute either search function; service_role can).
