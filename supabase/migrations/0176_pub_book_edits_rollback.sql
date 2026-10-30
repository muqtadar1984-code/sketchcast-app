-- Rollback for 0176_pub_book_edits.sql. Drops the edit record; revisions already made from edits stay.
drop trigger if exists pub_book_edits_guard on public.pub_book_edits;
drop table if exists public.pub_book_edits;
drop function if exists public.pub_book_edits_guard();
