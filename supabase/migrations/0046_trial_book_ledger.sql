-- 0046 — Close the trial-cap reset hole: the book limit counts UPLOADS, not
-- current books.
--
-- The hole (reported by a beta tester): enforce_beta_book_cap counted LIVE
-- rows (`count(*) from books where owner_id = …`), and the app hard-deletes
-- books — so delete + re-upload reset the 1-book trial forever.
--
-- Fix: a `book_upload_ledger` row is written for every book INSERT and
-- SURVIVES the book's deletion (no FK to books on purpose); the cap trigger
-- counts the ledger. Fairness rule so a bad first upload can't brick a trial
-- account: deleting a book that was NEVER generated from REFUNDS its slot
-- (ledger row removed); the moment any generation references the book, its
-- ledger row is marked used and the slot is consumed permanently.
--
-- Backfill: current books seed the ledger (used = has any generation).
-- Historical delete/re-upload cycles are unrecoverable — accounts that already
-- exploited the hole keep what they have; the door closes from now on.
--
-- Idempotent: safe to re-run.

create table if not exists book_upload_ledger (
  book_id    uuid primary key,          -- deliberately NO FK: must outlive the book
  owner_id   uuid not null references profiles(id) on delete cascade,
  used       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists book_upload_ledger_owner_idx on book_upload_ledger (owner_id);

-- Service-role/trigger-only: no client policies at all.
alter table book_upload_ledger enable row level security;
revoke all on book_upload_ledger from anon, authenticated;

-- ── Ledger maintenance triggers (SECURITY DEFINER — fire for every writer) ───

create or replace function ledger_book_insert() returns trigger
  language plpgsql security definer set search_path = public as
$$ begin
  insert into book_upload_ledger (book_id, owner_id)
  values (new.id, new.owner_id)
  on conflict (book_id) do nothing;
  return new;
end $$;

drop trigger if exists on_book_ledger_insert on books;
create trigger on_book_ledger_insert after insert on books
  for each row execute function ledger_book_insert();

-- Any generation against the book consumes its slot for good.
create or replace function ledger_generation_marks_used() returns trigger
  language plpgsql security definer set search_path = public as
$$ begin
  if new.book_id is not null then
    update book_upload_ledger set used = true where book_id = new.book_id and not used;
  end if;
  return new;
end $$;

drop trigger if exists on_generation_ledger_used on generations;
create trigger on_generation_ledger_used after insert on generations
  for each row execute function ledger_generation_marks_used();

-- Deleting a NEVER-used book refunds the slot (bad scan / wrong file retry);
-- a used book's ledger row survives the delete — that's the whole fix.
create or replace function ledger_book_delete_refund() returns trigger
  language plpgsql security definer set search_path = public as
$$ begin
  delete from book_upload_ledger where book_id = old.id and not used;
  return old;
end $$;

drop trigger if exists on_book_ledger_refund on books;
create trigger on_book_ledger_refund after delete on books
  for each row execute function ledger_book_delete_refund();

-- ── The cap now counts the LEDGER, not live rows ──────────────────────────────
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
       and (select count(*) from book_upload_ledger where owner_id = new.owner_id) >= cap then
      raise exception 'Your plan includes % book. Generate every content type for the book you already have, or upgrade for more.', cap;
    end if;
    return new;
  end if;
  -- Uploads ever made (minus refunded never-used deletes) — deleting a book you
  -- generated from no longer frees the slot.
  if (select count(*) from book_upload_ledger where owner_id = new.owner_id) >= cap then
    raise exception 'Your plan includes % book (deleting a book you generated from does not free the slot). Upgrade for more.', cap;
  end if;
  return new;
end $$;

-- ── Backfill current books (historical deletes are gone — door closes NOW) ───
insert into book_upload_ledger (book_id, owner_id, used, created_at)
select b.id, b.owner_id,
       exists (select 1 from generations g where g.book_id = b.id),
       b.created_at
from books b
on conflict (book_id) do nothing;
