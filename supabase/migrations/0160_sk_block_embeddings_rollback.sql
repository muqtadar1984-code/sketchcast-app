-- SketchCast AI — rollback for 0160 (SK block embeddings + hybrid search)
-- ============================================================================
-- Removes the search functions, the generated/embedding columns and their
-- indexes. Embeddings are lost (re-create them with tools/sk/embed-blocks.ts
-- after re-applying 0160). The `vector` extension is LEFT INSTALLED: other
-- objects may depend on it; drop it by hand if nothing else uses it.
-- ============================================================================

begin;

drop function if exists public.sk_search_hybrid(text, vector, uuid, int, int, int, int);
drop function if exists public.sk_search_fts(text, uuid, int, int);
drop function if exists public.sk_tsquery_or(text);

drop index if exists public.sk_book_blocks_emb_hnsw;
drop index if exists public.sk_book_blocks_tsv_gin;

alter table public.sk_book_blocks
  drop column if exists embedded_at,
  drop column if exists embedding_model,
  drop column if exists embedding,
  drop column if exists retrieval_tsv,
  drop column if exists retrieval_text;

drop function if exists public.sk_block_text(text, jsonb);
drop function if exists public.sk_block_flat(jsonb);

commit;
