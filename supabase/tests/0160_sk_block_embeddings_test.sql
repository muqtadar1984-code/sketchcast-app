-- SketchCast AI — verification for 0160 (SK block embeddings + hybrid search)
-- ============================================================================
-- Run AFTER applying 0160. Proves:
--   1. the vector extension, the five columns, the GIN and HNSW indexes and
--      the four functions exist;
--   2. sk_search_fts / sk_search_hybrid / sk_tsquery_or are NOT executable by
--      anon or authenticated and ARE by service_role;
--   3. sk_block_text follows the §6 rules: think → prompt only (its answer is
--      never in the text), key_term → "term: text", misconception → wrong +
--      right, figure → caption, list → items, table → caption + cells,
--      worked_example → problem + steps + answer, emphasis stripped;
--   4. neither search function reads topic_questions (its definition never
--      names the table);
--   5. on a throwaway product with three blocks and hand-made unit vectors,
--      plus identical copies under a FAKE product and a FAKE chapter:
--        - every returned row carries the requested product and chapter
--          (a filter failure would tie with the real rows);
--        - the FTS leg finds the lexical match, the vector leg the cosine
--          match, RRF puts both at the top, best_vec_score is the vector
--          top-1 on every row, k is honoured;
--        - a question with no lexemes and an orthogonal vector gates out
--          (best_vec_score 0 → the app reports "no grounding").
-- Every check RAISEs on failure; a clean run prints PASS lines and
-- "ALL 0160 CHECKS PASSED", then ROLLS BACK (nothing persists).
-- ============================================================================
begin;

do $$
declare
  n bigint;
  t text;
  v_prod  uuid;
  v_fake  uuid;
  v_a uuid; v_b uuid; v_c uuid;
  e1 vector; e2 vector; e3 vector; ez vector;
  r record;
  rows_n int;
begin
  -- 1. objects
  perform 1 from pg_extension where extname = 'vector';
  if not found then raise exception 'FAIL: vector extension missing'; end if;
  foreach t in array array['retrieval_text','retrieval_tsv','embedding','embedding_model','embedded_at'] loop
    perform 1 from information_schema.columns where table_schema = 'public' and table_name = 'sk_book_blocks' and column_name = t;
    if not found then raise exception 'FAIL: sk_book_blocks.% missing', t; end if;
  end loop;
  perform 1 from pg_indexes where schemaname = 'public' and indexname = 'sk_book_blocks_tsv_gin' and indexdef ilike '%gin%';
  if not found then raise exception 'FAIL: GIN index missing'; end if;
  perform 1 from pg_indexes where schemaname = 'public' and indexname = 'sk_book_blocks_emb_hnsw' and indexdef ilike '%hnsw%' and indexdef ilike '%vector_cosine_ops%';
  if not found then raise exception 'FAIL: HNSW cosine index missing'; end if;
  foreach t in array array['sk_block_flat','sk_block_text','sk_tsquery_or','sk_search_fts','sk_search_hybrid'] loop
    perform 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname = 'public' and p.proname = t;
    if not found then raise exception 'FAIL: function % missing', t; end if;
  end loop;
  raise notice 'PASS: extension, columns, indexes, functions present';

  -- 2. privileges
  foreach t in array array['public.sk_search_fts(text, uuid, int, int)', 'public.sk_search_hybrid(text, vector, uuid, int, int, int, int)', 'public.sk_tsquery_or(text)'] loop
    if has_function_privilege('anon', t, 'execute') or has_function_privilege('authenticated', t, 'execute') then
      raise exception 'FAIL: % callable by anon/authenticated', t;
    end if;
    if not has_function_privilege('service_role', t, 'execute') then
      raise exception 'FAIL: % not callable by service_role', t;
    end if;
  end loop;
  perform 1 from pg_proc where proname in ('sk_search_fts', 'sk_search_hybrid') and not prosecdef;
  if found then raise exception 'FAIL: a search function is not SECURITY DEFINER'; end if;
  raise notice 'PASS: search functions are service-role only, security definer';

  -- 3. block text rules
  t := public.sk_block_text('think', '{"text": "Why is the cell thin?", "answer": "SECRETANSWER so light passes"}'::jsonb);
  if t <> 'Why is the cell thin?' or t ilike '%SECRETANSWER%' then raise exception 'FAIL: think text = %', t; end if;
  t := public.sk_block_text('key_term', '{"term": "Magnification", "text": "how many times larger"}'::jsonb);
  if t <> 'Magnification: how many times larger' then raise exception 'FAIL: key_term text = %', t; end if;
  t := public.sk_block_text('misconception', '{"wrong": "lenses add", "right": "lenses multiply"}'::jsonb);
  if t not ilike '%lenses add%' or t not ilike '%lenses multiply%' then raise exception 'FAIL: misconception text = %', t; end if;
  t := public.sk_block_text('figure', '{"caption": "A light microscope", "asset_key": "mic"}'::jsonb);
  if t <> 'A light microscope' then raise exception 'FAIL: figure text = %', t; end if;
  t := public.sk_block_text('list', '{"items": ["carry with two hands", "lowest power first"]}'::jsonb);
  if t <> 'carry with two hands lowest power first' then raise exception 'FAIL: list text = %', t; end if;
  t := public.sk_block_text('table', '{"caption": "Units", "columns": ["unit", "symbol"], "rows": [["millimetre", "mm"], ["micrometre", "um"]]}'::jsonb);
  if t <> 'Units unit symbol millimetre mm micrometre um' then raise exception 'FAIL: table text = %', t; end if;
  t := public.sk_block_text('worked_example', '{"problem": "x10 and x40", "steps": ["multiply"], "answer": "x400"}'::jsonb);
  if t <> 'x10 and x40 multiply x400' then raise exception 'FAIL: worked_example text = %', t; end if;
  t := public.sk_block_text('paragraph', '{"text": "The **eyepiece**  lens   magnifies."}'::jsonb);
  if t <> 'The eyepiece lens magnifies.' then raise exception 'FAIL: paragraph text = %', t; end if;
  raise notice 'PASS: sk_block_text follows the indexing rules (think.answer never indexed)';

  -- 4. nothing reads topic_questions
  foreach t in array array['sk_search_fts', 'sk_search_hybrid', 'sk_block_text', 'sk_block_flat'] loop
    select pg_get_functiondef(p.oid) into t from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname = 'public' and p.proname = t limit 1;
    if t ilike '%topic_questions%' then raise exception 'FAIL: a retrieval function names topic_questions'; end if;
  end loop;
  raise notice 'PASS: retrieval never touches topic_questions';

  -- 5. scenario (rolled back): one product, three blocks, unit vectors; fake copies.
  insert into public.sk_book_products (slug, title, status) values ('sk-0160-test-product', '0160 test', 'draft') returning id into v_prod;
  insert into public.sk_book_products (slug, title, status) values ('sk-0160-test-fake', '0160 fake', 'draft') returning id into v_fake;
  e1 := ('[1' || repeat(',0', 1023) || ']')::vector;
  e2 := ('[0,1' || repeat(',0', 1022) || ']')::vector;
  e3 := ('[0,0,1' || repeat(',0', 1021) || ']')::vector;
  ez := ('[0,0,0,1' || repeat(',0', 1020) || ']')::vector;   -- orthogonal to all three
  insert into public.sk_book_blocks (product_id, chapter, section_sid, block_index, block_type, body, embedding, embedding_model)
    values (v_prod, 2, 's1', 0, 'paragraph', '{"text": "The objective lens of the microscope magnifies the specimen."}', e1, 'test') returning id into v_a;
  insert into public.sk_book_blocks (product_id, chapter, section_sid, block_index, block_type, body, embedding, embedding_model)
    values (v_prod, 2, 's1', 1, 'key_idea', '{"text": "Onion cells are stained with iodine."}', e2, 'test') returning id into v_b;
  insert into public.sk_book_blocks (product_id, chapter, section_sid, block_index, block_type, body, embedding, embedding_model)
    values (v_prod, 2, 's1', 2, 'paragraph', '{"text": "Drawings need a sharp pencil and a title."}', e3, 'test') returning id into v_c;
  -- identical text + vectors under a fake product (same chapter) and a fake chapter (same product)
  insert into public.sk_book_blocks (product_id, chapter, section_sid, block_index, block_type, body, embedding, embedding_model)
    select v_fake, chapter, section_sid, block_index, block_type, body, embedding, 'test' from public.sk_book_blocks where product_id = v_prod and chapter = 2;
  insert into public.sk_book_blocks (product_id, chapter, section_sid, block_index, block_type, body, embedding, embedding_model)
    select v_prod, 9, section_sid, block_index, block_type, body, embedding, 'test' from public.sk_book_blocks where product_id = v_prod and chapter = 2;
  select count(*) into n from public.sk_book_blocks where product_id in (v_prod, v_fake);
  if n <> 9 then raise exception 'FAIL: expected 9 scenario blocks, got %', n; end if;
  -- generated columns populated
  select retrieval_text into t from public.sk_book_blocks where id = v_a;
  if t <> 'The objective lens of the microscope magnifies the specimen.' then raise exception 'FAIL: retrieval_text = %', t; end if;

  -- 5a. FTS leg: lexical match only, filtered
  rows_n := 0;
  for r in select * from public.sk_search_fts('microscope lens', v_prod, 2, 5) loop
    rows_n := rows_n + 1;
    if r.product_id <> v_prod or r.chapter <> 2 then raise exception 'FAIL: fts leaked product %/chapter %', r.product_id, r.chapter; end if;
    if r.id <> v_a then raise exception 'FAIL: fts returned block % for "microscope lens"', r.id; end if;
    if r.score <= 0 then raise exception 'FAIL: fts score not positive'; end if;
  end loop;
  if rows_n <> 1 then raise exception 'FAIL: fts expected 1 row, got %', rows_n; end if;
  -- punctuation is data, not syntax
  perform * from public.sk_search_fts('''; DROP TABLE sk_book_blocks; -- & | ! ( ) microscope', v_prod, 2, 5);
  raise notice 'PASS: sk_search_fts matches lexically, filters by product+chapter, treats punctuation as data';

  -- 5b. hybrid: lexical hit (A) + vector hit (B) both at the top; C last; no fakes
  rows_n := 0;
  for r in select * from public.sk_search_hybrid('microscope lens', e2, v_prod, 2, 5, 20, 60) loop
    rows_n := rows_n + 1;
    if r.product_id <> v_prod or r.chapter <> 2 then raise exception 'FAIL: hybrid leaked product %/chapter %', r.product_id, r.chapter; end if;
    if abs(r.best_vec_score - 1.0) > 1e-6 then raise exception 'FAIL: best_vec_score = % (expected 1)', r.best_vec_score; end if;
    -- The vector leg ranks EVERY embedded block (cosine 0 still ranks), so A
    -- (fts rank 1 + a vector rank of 2 or 3) outscores B (vector rank 1 only).
    if r.id = v_a then
      if rows_n <> 1 then raise exception 'FAIL: A (both legs) should rank first, ranked %', rows_n; end if;
      if r.fts_score is null or r.fts_score <= 0 then raise exception 'FAIL: A has no fts_score'; end if;
      if abs(r.vec_score) > 1e-6 then raise exception 'FAIL: A vec_score = % (expected 0)', r.vec_score; end if;
      if r.score <= 1.0 / 61 or r.score > 1.0 / 61 + 1.0 / 62 + 1e-9 then raise exception 'FAIL: A rrf score = %', r.score; end if;
    elsif r.id = v_b then
      if rows_n <> 2 then raise exception 'FAIL: B (vector top-1) should rank second, ranked %', rows_n; end if;
      if r.fts_score is not null then raise exception 'FAIL: B should have no fts leg'; end if;
      if abs(r.vec_score - 1.0) > 1e-6 then raise exception 'FAIL: B vec_score = %', r.vec_score; end if;
      if abs(r.score - 1.0 / 61) > 1e-9 then raise exception 'FAIL: B rrf score = %', r.score; end if;
    elsif r.id = v_c then
      if rows_n <> 3 then raise exception 'FAIL: C should rank last, ranked %', rows_n; end if;
      if abs(r.vec_score) > 1e-6 then raise exception 'FAIL: C vec_score = % (expected 0)', r.vec_score; end if;
      if r.fts_score is not null then raise exception 'FAIL: C should have no fts leg'; end if;
      if r.score >= 1.0 / 61 then raise exception 'FAIL: C outranks a top-1 leg'; end if;
    else
      raise exception 'FAIL: unexpected row %', r.id;
    end if;
  end loop;
  if rows_n <> 3 then raise exception 'FAIL: hybrid expected 3 rows (3 real blocks), got %', rows_n; end if;
  -- k honoured
  select count(*) into n from public.sk_search_hybrid('microscope lens', e2, v_prod, 2, 2, 20, 60);
  if n <> 2 then raise exception 'FAIL: k=2 returned % rows', n; end if;
  -- the fake product and the fake chapter ARE searchable (the filter selects, it does not hide)
  select count(*) into n from public.sk_search_hybrid('microscope lens', e2, v_fake, 2, 5, 20, 60);
  if n <> 3 then raise exception 'FAIL: fake product search returned % rows (expected 3)', n; end if;
  select count(*) into n from public.sk_search_hybrid('microscope lens', e2, v_prod, 9, 5, 20, 60);
  if n <> 3 then raise exception 'FAIL: fake chapter search returned % rows (expected 3)', n; end if;
  raise notice 'PASS: sk_search_hybrid fuses both legs, filters by product+chapter, honours k, reports best_vec_score';

  -- 5c. off-book: no lexeme overlap, orthogonal vector → rows come back (vector leg always ranks) but best_vec_score is 0 → the app gates
  select max(best_vec_score), count(*) into r from public.sk_search_hybrid('photosynthesis chloroplast', ez, v_prod, 2, 5, 20, 60);
  if r.count = 0 then raise exception 'FAIL: off-book query returned no rows (the vector leg should still rank)'; end if;
  if abs(r.max) > 1e-6 then raise exception 'FAIL: off-book best_vec_score = % (expected 0, below any gate)', r.max; end if;
  raise notice 'PASS: an off-book question reports best_vec_score below the gate';

  -- 5d. a product with no embeddings at all: hybrid degrades to the FTS leg, best_vec_score null
  update public.sk_book_blocks set embedding = null where product_id = v_prod and chapter = 2;
  select count(*), max(best_vec_score) into r from public.sk_search_hybrid('microscope lens', e2, v_prod, 2, 5, 20, 60);
  if r.count <> 1 or r.max is not null then raise exception 'FAIL: unembedded product: % rows, best_vec %', r.count, r.max; end if;
  raise notice 'PASS: without embeddings the hybrid degrades to the FTS leg with best_vec_score null';

  raise notice 'ALL 0160 CHECKS PASSED';
end $$;

rollback;
