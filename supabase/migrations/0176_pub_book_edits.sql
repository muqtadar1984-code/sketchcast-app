-- 0176: edits made in the book app's reader (founder 2026-10-30, phase 3): highlight a passage and reword it with
-- AI, edit it by hand, or leave a note; later, replace an image and edit the book's front matter. An accepted text
-- edit is applied as a NEW chapter revision (pub_chapter_revisions stays immutable) which then needs Gate D again;
-- this table is the record of what was asked, suggested, decided and applied, by whom and when.
--
-- Additive and idempotent. Same protection as 0161: RLS on, no policies, nothing granted to anon or authenticated —
-- only the book app's server routes (service role). Never deleted; rows move forward through their status.

create table if not exists public.pub_book_edits (
  id               bigserial primary key,
  work_uid         text not null references public.pub_works(uid) on delete cascade,
  revision_key     text not null,                -- the revision the edit was made against
  chapter          integer,                      -- null for a book-level edit (front matter)
  kind             text not null check (kind in ('reword', 'edit', 'note', 'image', 'front_matter')),
  unit             text,                         -- where in the chapter: "s2.b3" (section s2, block 3) or "x4"
  before_text      text,                         -- the passage as it read
  after_text       text,                         -- what it should read (null for a note)
  instruction      text,                         -- the request to the AI, or the note itself
  status           text not null check (status in ('accepted', 'rejected', 'applied', 'open', 'resolved')),
  created_by       text not null,
  created_at       timestamptz not null default now(),
  decided_by       text,
  decided_at       timestamptz,
  applied_revision text,                         -- the revision the edit went into
  meta             jsonb not null default '{}'
);
create index if not exists pub_book_edits_work_idx on public.pub_book_edits (work_uid, chapter, status);

-- a record: never deleted, and the text of the request never rewritten (status and decision fields move forward)
create or replace function public.pub_book_edits_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'pub_book_edits is a record: reject or resolve an edit instead of deleting it';
  end if;
  if (new.work_uid, new.revision_key, new.chapter, new.kind, new.unit, new.before_text, new.after_text,
      new.instruction, new.created_by, new.created_at)
     is distinct from
     (old.work_uid, old.revision_key, old.chapter, old.kind, old.unit, old.before_text, old.after_text,
      old.instruction, old.created_by, old.created_at)
     or old.status in ('rejected', 'applied', 'resolved') then
    raise exception 'pub_book_edits: only an open or accepted edit may change, and only its status and decision';
  end if;
  return new;
end $$;
drop trigger if exists pub_book_edits_guard on public.pub_book_edits;
create trigger pub_book_edits_guard before update or delete on public.pub_book_edits
  for each row execute function public.pub_book_edits_guard();

alter table public.pub_book_edits enable row level security;
revoke all on public.pub_book_edits from anon, authenticated;
revoke all on sequence public.pub_book_edits_id_seq from anon, authenticated;
revoke all on function public.pub_book_edits_guard() from public, anon, authenticated;
