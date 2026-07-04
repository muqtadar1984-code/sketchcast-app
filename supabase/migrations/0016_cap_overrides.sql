-- 0016 — Per-teacher cap overrides (platform console ops).
--
-- Generalizes the 0011 beta caps: NULL columns keep today's behavior exactly
-- (beta testers 1 book / 1 chapter / 2 students, everyone else unlimited);
-- a number set from the console overrides the default for that person —
-- including capping a non-beta account. The three 0011 trigger FUNCTIONS are
-- replaced in place (same names, same triggers → REQUIRES 0011 applied first).
-- Lowering a cap below current usage never deletes anything — it only blocks
-- new inserts. 0010's column-level GRANT keeps the columns client-unwritable.
--
-- Run as ONE execution AFTER 0011 and 0015. Idempotent.

alter table public.profiles add column if not exists max_books    int check (max_books    is null or max_books    >= 0);
alter table public.profiles add column if not exists max_chapters int check (max_chapters is null or max_chapters >= 0);
alter table public.profiles add column if not exists max_students int check (max_students is null or max_students >= 0);

create or replace function public.effective_cap(uid uuid, which text) returns int
  language sql stable security definer set search_path = public as
$$
  select coalesce(
    (select case which when 'books'    then max_books
                       when 'chapters' then max_chapters
                       when 'students' then max_students end
     from profiles where id = uid),
    case when is_beta_tester(uid)
         then case which when 'books' then 1 when 'chapters' then 1 else 2 end
         else 2147483647 end)
$$;

-- ── Cap 1: books ─────────────────────────────────────────────────────────────
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
      raise exception 'Beta is limited to % book(s).', cap;
    end if;
    return new;
  end if;
  if (select count(*) from books where owner_id = new.owner_id) >= cap then
    raise exception 'Beta is limited to % book(s). You can generate for the book(s) you already uploaded.', cap;
  end if;
  return new;
end $$;

-- ── Cap 2: chapters (distinct (book, chapter) pairs; all kinds per pair) ─────
create or replace function enforce_beta_generation_cap() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare cap int;
begin
  cap := effective_cap(new.owner_id, 'chapters');
  if cap >= 2147483647 then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('beta_gen:' || new.owner_id::text));
  if tg_op = 'UPDATE' then
    if auth.uid() = new.owner_id
       and (new.book_id is distinct from old.book_id
            or new.chapter_ref is distinct from old.chapter_ref)
       and not exists (
             select 1 from generations g
             where g.owner_id = new.owner_id and g.id <> new.id
               and g.book_id is not distinct from new.book_id
               and g.chapter_ref is not distinct from new.chapter_ref)
       and (select count(distinct (g.book_id, g.chapter_ref)) from generations g
            where g.owner_id = new.owner_id and g.id <> new.id) >= cap then
      raise exception 'Beta is limited to % chapter(s). You can generate every content type for the chapter(s) you already picked.', cap;
    end if;
    return new;
  end if;
  if not exists (
       select 1 from generations g
       where g.owner_id = new.owner_id
         and g.book_id is not distinct from new.book_id
         and g.chapter_ref is not distinct from new.chapter_ref)
     and (select count(distinct (g.book_id, g.chapter_ref)) from generations g
          where g.owner_id = new.owner_id) >= cap then
    raise exception 'Beta is limited to % chapter(s). You can generate every content type for the chapter(s) you already picked.', cap;
  end if;
  return new;
end $$;

-- ── Cap 3: students ──────────────────────────────────────────────────────────
create or replace function enforce_beta_student_cap() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare owner uuid; cap int;
begin
  select teacher_id into owner from classes where id = new.class_id;
  if owner is null then
    return new;
  end if;
  cap := effective_cap(owner, 'students');
  if cap >= 2147483647 then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('beta_stu:' || owner::text));
  if (select count(distinct e.student_id) from enrollments e
      join classes c on c.id = e.class_id
      where c.teacher_id = owner
        and e.student_id <> new.student_id) >= cap then
    raise exception 'Beta is limited to % students.', cap;
  end if;
  return new;
end $$;

-- Triggers are unchanged (same names/tables/columns as 0011) — replacing the
-- functions above is the whole upgrade.
