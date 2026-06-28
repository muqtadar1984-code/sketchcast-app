-- SketchCast AI — per-chapter lessons
-- ----------------------------------------------------------------------------
-- Adds book "indexing": on upload, a lightweight `index_book` job extracts the
-- chapter list (Agent 1) and stores it on the book, so the dashboard can offer a
-- Generate button per chapter. Chapters reuse the same detection the generator
-- uses, so `chapter_num` here always matches what worker `_pick_chapter` selects.
-- Safe to run on the existing database (idempotent).
-- ----------------------------------------------------------------------------

-- Chapter list for the book: [{"num": int, "title": str}, ...]
alter table books add column if not exists chapters jsonb;

-- An index job has no generation, so it needs to know its book.
alter table jobs add column if not exists book_id uuid references books(id) on delete cascade;
create index if not exists jobs_book_id_idx on jobs (book_id);

-- Enqueue indexing when a book is uploaded (mirrors on_generation_created).
create or replace function create_index_job_for_book() returns trigger
  language plpgsql security definer set search_path = public as
$$ begin
  insert into jobs (book_id, type, status) values (new.id, 'index_book', 'queued');
  return new;
end $$;
drop trigger if exists on_book_created on books;
create trigger on_book_created
  after insert on books
  for each row execute function create_index_job_for_book();
