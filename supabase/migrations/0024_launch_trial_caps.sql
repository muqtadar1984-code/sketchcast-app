-- 0024 — Launch trial caps.
--
-- Product decision (2026-07): for the ~1-month open trial, EVERY user gets the
-- full feature set with NO tier/feature gating — the only limit is a single
-- uploaded book (they can generate all of that one book's chapters, every
-- content kind). This is the teaser; after the trial we wire real per-tier
-- gating (once the paid differentiators — AI Tutor, etc. — are built).
--
-- Mechanism: the whole cap system already routes through effective_cap()
-- (0011/0016/0018) and its triggers. We only change the DEFAULT: books -> 1 for
-- everyone; chapters/students/children stay unlimited. This also SUPERSEDES the
-- beta-tester cap defaults — everyone now shares one trial cap, so the
-- is_beta_tester branch is dropped.
--
-- Safe: lowering a cap never deletes anything — it only blocks NEW book inserts;
-- existing books are kept. A per-user override (profiles.max_books, set from the
-- platform console) still lifts an individual account — use it for founder/demo
-- accounts that need more than one book.
--
-- Idempotent (function replace). Requires 0011/0016/0018 already applied.

create or replace function public.effective_cap(uid uuid, which text) returns int
  language sql stable security definer set search_path = public as
$$
  select coalesce(
    -- 1) explicit per-user override from the console (books/chapters/students/children)
    (select case which when 'books'    then max_books
                       when 'chapters' then max_chapters
                       when 'students' then max_students
                       when 'children' then max_children end
     from profiles where id = uid),
    -- 2) trial default for EVERYONE: 1 book; everything else open.
    case which when 'books' then 1 else 2147483647 end)
$$;

-- Refresh only the wording on the books cap (same logic as 0016) — it is no
-- longer a "beta" limit, so the message shouldn't say so.
create or replace function enforce_beta_book_cap() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare cap int;
begin
  cap := effective_cap(new.owner_id, 'books');
  if cap >= 2147483647 then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('beta_book:' || new.owner_id::text));
  if tg_op = 'UPDATE' then
    -- Content-swap guard applies only while AT the cap (worker's service-role
    -- updates pass regardless: auth.uid() is null there).
    if auth.uid() = new.owner_id
       and (new.storage_path is distinct from old.storage_path
            or new.chapters is distinct from old.chapters
            or new.owner_id is distinct from old.owner_id)
       and (select count(*) from books where owner_id = new.owner_id) >= cap then
      raise exception 'Your plan includes % book. Generate every content type for the book you already have, or upgrade for more.', cap;
    end if;
    return new;
  end if;
  if (select count(*) from books where owner_id = new.owner_id) >= cap then
    raise exception 'Your plan includes % book. Generate every content type for the book you already uploaded, or upgrade for more.', cap;
  end if;
  return new;
end $$;
