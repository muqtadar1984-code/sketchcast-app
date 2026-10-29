-- 0174: SK S7 slice K1 — the knowledge layer's data model
-- (SK S7 Knowledge Layer design 2026-10-30; the book-releases contract with the
-- book-editor session, BOOK-RELEASES-CONTRACT-2026-10-30).
--
-- sk_knowledge_blocks   ONE table of passages SK may ground on, from three
--                       sources:
--                         sketchcast_book  a book-app release (pub_releases,
--                                          the book app's 0172): section text
--                                          and exercise STEMS — answers and
--                                          worked solutions never become blocks;
--                         article          an approved topic_articles row:
--                                          sections, glossary, misconceptions,
--                                          worked examples;
--                         user_book        a user's upload: chapter_grounding.
--                                          source_text split into paragraphs.
--                       `tsv` is generated from the block's own language through
--                       sk_ts_config(): English, Arabic, French, Spanish and
--                       Portuguese stemming, `simple` for everything else.
--                       Service role only: SK reads it AFTER its own access check
--                       (K2 sourcesFor) — this migration grants no client a row.
-- sk_book_products      gains the link to a release: work_uid, language,
--                       release_id, edition_key, release_kind, cover_key. One
--                       product per (work_uid, language). Existing rows are not
--                       changed (Biology keeps its W2 import, work_uid null).
-- sk_release_imports    the importer's log, one row per pub_releases id.
-- sk_knowledge_replace  the importers' ONE writer: delete the given scopes and
--                       insert the given blocks in one transaction.
-- sk_knowledge_versions what is already imported, per source/chapter/version
--                       (the importers' resume and idempotency check).
-- sk_knowledge_prune    removes blocks whose source is gone: article versions
--                       that are no longer the current approved one, and books
--                       that were removed or deleted.
-- sk_search_knowledge   full-text search over the sources the APP passes in.
--                       It never decides access.
--
-- SK never writes pub_* (the contract). Nothing here reads pub_releases: the
-- importer reads it from the app with the service role, so this migration does
-- not depend on 0172.
--
-- Run as ONE execution. Idempotent. Rollback = 0174_sk_knowledge_blocks_rollback.sql.
begin;

-- ── 1. language → text-search configuration ─────────────────────────────────
-- IMMUTABLE so the generated tsv column may call it. 'ms-arab' → 'ms' → simple.
create or replace function public.sk_ts_config(lang text)
returns regconfig
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select case lower(split_part(coalesce(lang, ''), '-', 1))
    when 'en' then 'pg_catalog.english'::regconfig
    when 'ar' then 'pg_catalog.arabic'::regconfig
    when 'fr' then 'pg_catalog.french'::regconfig
    when 'es' then 'pg_catalog.spanish'::regconfig
    when 'pt' then 'pg_catalog.portuguese'::regconfig
    else 'pg_catalog.simple'::regconfig
  end
$$;

-- ── 2. the passages ─────────────────────────────────────────────────────────
create table if not exists public.sk_knowledge_blocks (
  id           bigserial   primary key,
  source_kind  text        not null check (source_kind in ('sketchcast_book', 'article', 'user_book')),
  source_id    text        not null check (length(source_id) between 1 and 200),   -- work_uid / topic_articles.id / books.id
  version      text        not null check (length(version) between 1 and 200),     -- release id / article version / books.content_hash
  release_id   bigint,                                                                -- pub_releases.id (sketchcast_book only)
  chapter      int,
  anchor       text        not null check (length(anchor) between 1 and 200),      -- sid / section key / paragraph #
  language     text        not null check (language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})?$'),
  title        text        not null default '' check (length(title) <= 500),
  text         text        not null check (length(text) between 1 and 8000),
  kind         text        not null check (kind in ('section', 'exercise_stem', 'paragraph', 'glossary', 'misconception', 'worked_example')),
  tsv          tsvector    generated always as (
                 setweight(to_tsvector(public.sk_ts_config(language), coalesce(title, '')), 'A') ||
                 setweight(to_tsvector(public.sk_ts_config(language), text), 'B')
               ) stored,
  created_at   timestamptz not null default now()
);
create index if not exists sk_knowledge_blocks_tsv_idx     on public.sk_knowledge_blocks using gin (tsv);
create index if not exists sk_knowledge_blocks_version_idx on public.sk_knowledge_blocks (source_kind, source_id, version);
create index if not exists sk_knowledge_blocks_chapter_idx on public.sk_knowledge_blocks (source_kind, source_id, chapter);
-- one block per anchor: a re-run can never double a passage
create unique index if not exists sk_knowledge_blocks_anchor_uq
  on public.sk_knowledge_blocks (source_kind, source_id, language, version, chapter, kind, anchor) nulls not distinct;

alter table public.sk_knowledge_blocks enable row level security;
revoke all on public.sk_knowledge_blocks from anon, authenticated;
revoke all on sequence public.sk_knowledge_blocks_id_seq from anon, authenticated;

-- ── 3. product ↔ release link ───────────────────────────────────────────────
alter table public.sk_book_products add column if not exists work_uid     text;
alter table public.sk_book_products add column if not exists language     text;
alter table public.sk_book_products add column if not exists release_id   bigint;
alter table public.sk_book_products add column if not exists edition_key  text;
alter table public.sk_book_products add column if not exists release_kind text check (release_kind in ('final', 'draft'));
alter table public.sk_book_products add column if not exists cover_key    text;
create unique index if not exists sk_book_products_work_language_uq
  on public.sk_book_products (work_uid, language) where work_uid is not null;

-- ── 4. import log ───────────────────────────────────────────────────────────
create table if not exists public.sk_release_imports (
  release_id   bigint      primary key,                   -- pub_releases.id (no FK: 0172 is the book app's)
  work_uid     text        not null,
  imported_at  timestamptz not null default now(),
  blocks       int         not null default 0 check (blocks >= 0),
  status       text        not null check (status in ('ok', 'error', 'skipped')),
  error        text        check (error is null or length(error) <= 2000)
);
alter table public.sk_release_imports enable row level security;
revoke all on public.sk_release_imports from anon, authenticated;

-- ── 5. the importers' writer (one transaction per call) ─────────────────────
-- p_scopes: [{source_kind, source_id, language?, chapter?}] — every block in a
--           scope is deleted first (language/chapter narrow it when given);
-- p_blocks: [{source_kind, source_id, version, release_id?, chapter?, anchor,
--             language, title?, text, kind}] — inserted after the deletes.
-- A block outside every scope is refused, so a caller cannot add passages to a
-- source without replacing that source.
create or replace function public.sk_knowledge_replace(p_scopes jsonb, p_blocks jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted  int;
  v_inserted int;
  v_outside  int;
begin
  if jsonb_typeof(p_scopes) is distinct from 'array' or jsonb_typeof(p_blocks) is distinct from 'array' then
    raise exception 'sk_knowledge_replace: scopes and blocks must be arrays' using errcode = '22023';
  end if;

  select count(*) into v_outside
    from jsonb_array_elements(p_blocks) b
   where not exists (
     select 1 from jsonb_array_elements(p_scopes) s
      where s->>'source_kind' = b->>'source_kind'
        and s->>'source_id' = b->>'source_id'
        and (s->>'language' is null or s->>'language' = b->>'language')
        and (s->>'chapter' is null or (s->>'chapter')::int = (b->>'chapter')::int));
  if v_outside > 0 then
    raise exception 'sk_knowledge_replace: % block(s) outside the given scopes', v_outside using errcode = '22023';
  end if;

  delete from public.sk_knowledge_blocks k
   using jsonb_array_elements(p_scopes) s
   where k.source_kind = s->>'source_kind'
     and k.source_id = s->>'source_id'
     and (s->>'language' is null or k.language = s->>'language')
     and (s->>'chapter' is null or k.chapter = (s->>'chapter')::int);
  get diagnostics v_deleted = row_count;

  insert into public.sk_knowledge_blocks (source_kind, source_id, version, release_id, chapter, anchor, language, title, text, kind)
  select b->>'source_kind', b->>'source_id', b->>'version', (b->>'release_id')::bigint, (b->>'chapter')::int,
         b->>'anchor', b->>'language', coalesce(b->>'title', ''), b->>'text', b->>'kind'
    from jsonb_array_elements(p_blocks) b;
  get diagnostics v_inserted = row_count;

  return jsonb_build_object('deleted', v_deleted, 'inserted', v_inserted);
end;
$$;
revoke all on function public.sk_knowledge_replace(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.sk_knowledge_replace(jsonb, jsonb) to service_role;

-- ── 6. what is already imported (resume / idempotency) ──────────────────────
create or replace function public.sk_knowledge_versions(p_source_kind text)
returns table (source_id text, language text, chapter int, version text, blocks bigint, imported_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select k.source_id, k.language, k.chapter, k.version, count(*), max(k.created_at)
    from public.sk_knowledge_blocks k
   where k.source_kind = p_source_kind
   group by k.source_id, k.language, k.chapter, k.version
$$;
revoke all on function public.sk_knowledge_versions(text) from public, anon, authenticated;
grant execute on function public.sk_knowledge_versions(text) to service_role;

-- ── 7. prune blocks whose source is gone ────────────────────────────────────
-- article:   the row is no longer approved, or a newer approved version of the
--            same (topic, language) exists, or the row was deleted;
-- user_book: the book was removed (removed_at) or deleted.
-- Junk-gated uploads are handled by the importer (the "confirmed" rule lives in
-- the app, src/sk/knowledge/user-books.ts).
create or replace function public.sk_knowledge_prune()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_articles int;
  v_books    int;
begin
  delete from public.sk_knowledge_blocks k
   where k.source_kind = 'article'
     and not exists (
       select 1 from public.topic_articles a
        where a.id::text = k.source_id
          and a.status = 'approved'
          and not exists (
            select 1 from public.topic_articles n
             where n.topic_id = a.topic_id and n.language = a.language
               and n.status = 'approved' and n.version > a.version));
  get diagnostics v_articles = row_count;

  delete from public.sk_knowledge_blocks k
   where k.source_kind = 'user_book'
     and not exists (
       select 1 from public.books b where b.id::text = k.source_id and b.removed_at is null);
  get diagnostics v_books = row_count;

  return jsonb_build_object('articles', v_articles, 'user_books', v_books);
end;
$$;
revoke all on function public.sk_knowledge_prune() from public, anon, authenticated;
grant execute on function public.sk_knowledge_prune() to service_role;

-- ── 8. search (the app passes the ALLOWED sources) ──────────────────────────
-- p_sources: [{kind, id, version?}] — a block is searched only when its
--   (source_kind, source_id[, version]) is listed. {kind:'article'} with no id
--   means every article (articles are free to every signed-in user, design
--   decision 3); no other kind accepts a missing id.
-- The query is parsed with the caller's language AND, for a block in another
-- language, with the block's own, so an English question still matches English
-- passages when the learner's UI is Arabic, and the other way round.
-- The text returned is a ts_headline snippet of at most 600 characters.
create or replace function public.sk_search_knowledge(
  p_query   text,
  p_lang    text,
  p_sources jsonb,
  p_chapter int default null,
  p_limit   int default 8
)
returns table (id bigint, source_kind text, source_id text, version text, chapter int, anchor text, title text, text text, rank real)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with src as (
    select s->>'kind' as kind, nullif(s->>'id', '') as sid, nullif(s->>'version', '') as ver
      from jsonb_array_elements(case when jsonb_typeof(p_sources) = 'array' then p_sources else '[]'::jsonb end) s
     where s->>'kind' in ('sketchcast_book', 'article', 'user_book')
       and (nullif(s->>'id', '') is not null or s->>'kind' = 'article')
  ),
  q as (
    select websearch_to_tsquery(public.sk_ts_config(p_lang), coalesce(p_query, '')) as tsq
  ),
  hits as (
    select k.*,
           case when public.sk_ts_config(k.language) = public.sk_ts_config(p_lang) then q.tsq
                else q.tsq || websearch_to_tsquery(public.sk_ts_config(k.language), coalesce(p_query, '')) end as tsq
      from public.sk_knowledge_blocks k
      cross join q
     where exists (
             select 1 from src
              where src.kind = k.source_kind
                and (src.sid is null or src.sid = k.source_id)
                and (src.ver is null or src.ver = k.version))
       and (p_chapter is null or k.chapter = p_chapter)
  )
  select h.id, h.source_kind, h.source_id, h.version, h.chapter, h.anchor, h.title,
         left(ts_headline(public.sk_ts_config(h.language), h.text, h.tsq,
                          'MaxWords=60, MinWords=20, MaxFragments=2, FragmentDelimiter=" … "'), 600) as text,
         ts_rank_cd(h.tsv, h.tsq) as rank
    from hits h
   where h.tsv @@ h.tsq
   order by rank desc, h.id
   limit least(greatest(coalesce(p_limit, 8), 1), 50)
$$;
revoke all on function public.sk_search_knowledge(text, text, jsonb, int, int) from public, anon, authenticated;
grant execute on function public.sk_search_knowledge(text, text, jsonb, int, int) to service_role;

comment on table public.sk_knowledge_blocks is 'SK S7: passages SK grounds on (SketchCast book releases, approved articles, user uploads). Service role only; SK checks access first (K2).';
comment on table public.sk_release_imports is 'SK S7: the release importer''s log, one row per book-app release id (ok | error | skipped).';
comment on function public.sk_ts_config(text) is 'SK S7: language code → text-search config (en/ar/fr/es/pt stemming, else simple). Immutable.';
comment on function public.sk_knowledge_replace(jsonb, jsonb) is 'SK S7: the importers'' writer — delete the scopes, insert the blocks, one transaction. Service role only.';
comment on function public.sk_knowledge_prune() is 'SK S7: drop blocks of superseded/unapproved article versions and removed/deleted books. Service role only.';
comment on function public.sk_search_knowledge(text, text, jsonb, int, int) is 'SK S7: full-text search over the sources the app passes (it never decides access). Service role only.';

commit;
