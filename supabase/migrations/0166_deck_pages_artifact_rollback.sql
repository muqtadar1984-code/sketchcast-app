-- 0166 rollback: Postgres cannot drop an enum value, so the value stays and
-- the rows that use it go. The slide PNGs (`slide_png`) are kept: they predate
-- this migration as a kind and are harmless on their own.
--
-- ⚠️ This deletes every deck text map; the worker re-renders a deck's pages on
-- the next `deck_pages` job for it.
begin;
delete from public.artifacts where kind::text = 'deck_pages_json';
commit;
