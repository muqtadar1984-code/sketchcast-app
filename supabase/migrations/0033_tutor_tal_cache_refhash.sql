-- 0033 — AI Tutor Phase 2: reference-aware TAL cache key.
--
-- A shared-board turn is now a function of (chapter, question, board state, AND
-- the object the student referenced). The old cache key (book, chapter,
-- question_norm, board_hash) excluded the reference, so "explain what I circled"
-- pointed at the Golgi vs the nucleus would collide on one cache entry. Add a
-- ref_hash column (hash of the turn's student events; "" when there's no
-- reference, so plain questions keep sharing their entry) and widen the unique key.
--
-- Additive + idempotent. Safe to run once.

alter table public.tutor_tal_cache
  add column if not exists ref_hash text not null default '';

-- Replace the 4-tuple uniqueness with the 5-tuple (adds ref_hash). The 0029
-- constraint is auto-named; drop it if present, then add the new unique index
-- (ON CONFLICT works against a unique index just as with a constraint).
alter table public.tutor_tal_cache
  drop constraint if exists tutor_tal_cache_book_id_chapter_num_question_norm_board_hash_key;

drop index if exists tutor_tal_cache_key;
create unique index tutor_tal_cache_key
  on public.tutor_tal_cache (book_id, chapter_num, question_norm, board_hash, ref_hash);
