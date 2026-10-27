-- SketchCast AI — 0160: SK retrieval (hybrid FTS + pgvector) over sk_book_blocks
-- ============================================================================
-- Plan: SK AI Tutor plan §6 (retrieval) and the R1 test (sketchcast-ai
-- docs/SK-R1-REPORT.md): strict FTS misses 18 of 30 in-chapter questions;
-- pgvector (Amazon Titan Text Embeddings v2, 1024 dims, cosine) reaches
-- recall@5 1.00; the hybrid (OR-relaxed FTS + vector, reciprocal rank fusion
-- k = 60) ties and carries both scores, so the app can gate "no grounding" on
-- the VECTOR score (0.32 for Titan, per the R1 re-run of 2026-10-27).
--
-- What this adds (additive, expand-then-contract):
--   extension vector           pgvector (Supabase ships 0.8.x).
--   sk_block_flat(jsonb)       jsonb → plain text helper.
--   sk_block_text(type, body)  the text a block contributes to the index, by
--                              block_type (same rules as spike/sk_r1/schema.sql):
--                                paragraph/key_idea/extension/think → text
--                                key_term      → "term: text"
--                                misconception → wrong + right
--                                figure        → caption
--                                list          → items
--                                table         → caption + cells
--                                worked_example→ problem + steps + answer
--                              NEVER think.answer (an answer key) and NEVER
--                              topic_questions (not read by anything here).
--   sk_book_blocks.retrieval_text   stored generated column (the text above)
--   sk_book_blocks.retrieval_tsv    stored generated tsvector ('english')
--   sk_book_blocks.embedding        vector(1024), null until embedded
--   sk_book_blocks.embedding_model  which model wrote the vector (re-embed on change)
--   sk_book_blocks.embedded_at
--   GIN index on retrieval_tsv; HNSW cosine index on embedding.
--   sk_tsquery_or(q)           the OR-relaxed query (every stemmed lexeme |'d).
--   sk_search_fts(...)         FTS leg alone (the default adapter, no vectors needed).
--   sk_search_hybrid(...)      RRF of the FTS and vector legs; returns score,
--                              fts_score, vec_score and best_vec_score (the
--                              vector leg's top-1, the number the app gates on).
--   Both search functions filter product_id AND chapter in their WHERE and are
--   SECURITY DEFINER, executable by service_role ONLY (revoked from public,
--   anon and authenticated): the app's admin client calls them; no browser can.
--
-- Embeddings are written by tools/sk/embed-blocks.ts (service role, idempotent).
-- Rollback = 0160_sk_block_embeddings_rollback.sql.
-- Search path: functions set `public, extensions` so `vector` resolves whether
-- the extension lives in `extensions` (Supabase default) or `public`.
-- ============================================================================

begin;

-- ── 1. pgvector ──────────────────────────────────────────────────────────────
create extension if not exists vector with schema extensions;

-- ── 2. block text ───────────────────────────────────────────────────────────
-- Flatten any jsonb value to plain text (arrays/objects joined with spaces).
create or replace function public.sk_block_flat(j jsonb) returns text
language plpgsql immutable as $$
begin
  return case jsonb_typeof(j)
    when 'array'  then (select coalesce(string_agg(public.sk_block_flat(e), ' '), '') from jsonb_array_elements(j) e)
    when 'object' then (select coalesce(string_agg(public.sk_block_flat(v), ' '), '') from jsonb_each(j) kv(k, v))
    when 'string' then j #>> '{}'
    when 'null'   then ''
    else coalesce(j::text, '')
  end;
end $$;

-- The text a block contributes to retrieval. think → the prompt only: its
-- `answer` is an answer key and is never indexed. Unknown block types fall
-- back to the whole body flattened. Markdown emphasis (*) stripped, whitespace
-- collapsed.
create or replace function public.sk_block_text(bt text, b jsonb) returns text
language sql immutable as $$
  select btrim(regexp_replace(regexp_replace(case bt
    when 'paragraph'      then coalesce(b->>'text', '')
    when 'key_idea'       then coalesce(b->>'text', '')
    when 'extension'      then coalesce(b->>'text', '')
    when 'think'          then coalesce(b->>'text', '')
    when 'key_term'       then coalesce(b->>'term', '') || ': ' || coalesce(b->>'text', '')
    when 'misconception'  then 'Common mistake: ' || coalesce(b->>'wrong', '') || ' Correct idea: ' || coalesce(b->>'right', '')
    when 'figure'         then coalesce(b->>'caption', '')
    when 'list'           then public.sk_block_flat(b->'items')
    when 'table'          then coalesce(b->>'caption', '') || ' ' || public.sk_block_flat(b->'columns') || ' ' || public.sk_block_flat(b->'rows')
    when 'worked_example' then coalesce(b->>'problem', '') || ' ' || public.sk_block_flat(b->'steps') || ' ' || coalesce(b->>'answer', '')
    else public.sk_block_flat(b) end, '\*+', '', 'g'), '\s+', ' ', 'g'))
$$;

-- ── 3. columns ──────────────────────────────────────────────────────────────
alter table public.sk_book_blocks
  add column if not exists retrieval_text  text     generated always as (public.sk_block_text(block_type, body)) stored,
  add column if not exists retrieval_tsv   tsvector generated always as (to_tsvector('english'::regconfig, public.sk_block_text(block_type, body))) stored,
  add column if not exists embedding       vector(1024),
  add column if not exists embedding_model text,
  add column if not exists embedded_at     timestamptz;

comment on column public.sk_book_blocks.retrieval_text is 'SK retrieval: the block text that is indexed (sk_block_text); never a think.answer.';
comment on column public.sk_book_blocks.embedding is 'SK retrieval: 1024-dim embedding of retrieval_text (amazon.titan-embed-text-v2:0, normalised). Written by tools/sk/embed-blocks.ts.';

create index if not exists sk_book_blocks_tsv_gin  on public.sk_book_blocks using gin (retrieval_tsv);
create index if not exists sk_book_blocks_emb_hnsw on public.sk_book_blocks using hnsw (embedding vector_cosine_ops);

-- ── 4. query shaping ────────────────────────────────────────────────────────
-- Every stemmed lexeme of the question, OR'd (R1: the AND form returned nothing
-- for 18/30 questions). Lexemes are quoted so punctuation in a question is
-- data, never tsquery syntax. A question with no lexemes matches nothing.
create or replace function public.sk_tsquery_or(q text) returns tsquery
language sql immutable as $$
  select to_tsquery('english'::regconfig,
    coalesce(nullif((select string_agg(quote_literal(lex), ' | ') from unnest(tsvector_to_array(to_tsvector('english'::regconfig, coalesce(q, '')))) lex), ''), '''zzzznomatch'''))
$$;

-- ── 5. search: FTS leg ──────────────────────────────────────────────────────
create or replace function public.sk_search_fts(q text, p_product uuid, p_chapter int, k int default 5)
returns table (id uuid, product_id uuid, chapter int, section_sid text, block_index int, unit_key text, block_type text, content text, score real)
language sql stable security definer set search_path = public, extensions as $$
  select b.id, b.product_id, b.chapter, b.section_sid, b.block_index, b.unit_key, b.block_type, b.retrieval_text,
         ts_rank_cd(b.retrieval_tsv, public.sk_tsquery_or(q)) as score
  from public.sk_book_blocks b
  where b.product_id = p_product and b.chapter = p_chapter
    and b.retrieval_tsv @@ public.sk_tsquery_or(q)
  order by 9 desc, b.id
  limit greatest(1, least(coalesce(k, 5), 20))
$$;

-- ── 6. search: hybrid (RRF of FTS top-`pool` and vector top-`pool`) ────────
-- score = Σ 1/(rrf_k + rank) over the legs a block appears in; fts_score /
-- vec_score are the legs' own scores (null when the block is not in that
-- leg); best_vec_score (same on every row) is the vector leg's top-1 cosine —
-- the app gates "no grounding" on it, because the RRF score is rank-based and
-- cannot be thresholded (R1 §4.2).
create or replace function public.sk_search_hybrid(q text, qv vector, p_product uuid, p_chapter int,
                                                   k int default 5, pool int default 20, rrf_k int default 60)
returns table (id uuid, product_id uuid, chapter int, section_sid text, block_index int, unit_key text, block_type text, content text,
               score double precision, fts_score real, vec_score double precision, best_vec_score double precision)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  tsq tsquery := public.sk_tsquery_or(q);
  kk  int := greatest(1, least(coalesce(k, 5), 20));
  pp  int;
  rk  int := greatest(1, coalesce(rrf_k, 60));
begin
  pp := greatest(kk, least(coalesce(pool, 20), 100));
  return query
  with f as (
    select b.id as bid, ts_rank_cd(b.retrieval_tsv, tsq) as s,
           row_number() over (order by ts_rank_cd(b.retrieval_tsv, tsq) desc, b.id) as r
    from public.sk_book_blocks b
    where b.product_id = p_product and b.chapter = p_chapter and b.retrieval_tsv @@ tsq
    order by s desc, b.id limit pp),
  v as (
    select b.id as bid, 1 - (b.embedding <=> qv) as s,
           row_number() over (order by b.embedding <=> qv, b.id) as r
    from public.sk_book_blocks b
    where b.product_id = p_product and b.chapter = p_chapter and b.embedding is not null
    order by b.embedding <=> qv, b.id limit pp),
  u as (select f.bid from f union select v.bid from v),
  best as (select max(v.s) as s from v)
  select b.id, b.product_id, b.chapter, b.section_sid, b.block_index, b.unit_key, b.block_type, b.retrieval_text,
         (coalesce(1.0 / (rk + f.r), 0) + coalesce(1.0 / (rk + v.r), 0))::double precision as score,
         f.s as fts_score, v.s as vec_score, best.s as best_vec_score
  from u
  join public.sk_book_blocks b on b.id = u.bid
  left join f on f.bid = u.bid
  left join v on v.bid = u.bid
  cross join best
  order by 9 desc, b.id
  limit kk;
end $$;

-- ── 7. access: service role only ────────────────────────────────────────────
revoke all on function public.sk_search_fts(text, uuid, int, int) from public, anon, authenticated;
revoke all on function public.sk_search_hybrid(text, vector, uuid, int, int, int, int) from public, anon, authenticated;
revoke all on function public.sk_tsquery_or(text) from public, anon, authenticated;
grant execute on function public.sk_search_fts(text, uuid, int, int) to service_role;
grant execute on function public.sk_search_hybrid(text, vector, uuid, int, int, int, int) to service_role;
grant execute on function public.sk_tsquery_or(text) to service_role;

comment on function public.sk_search_hybrid(text, vector, uuid, int, int, int, int) is
  'SK retrieval: RRF of OR-FTS and cosine legs over sk_book_blocks, filtered by product and chapter. Service role only. Gate on best_vec_score (0.32 for Titan v2).';

commit;
