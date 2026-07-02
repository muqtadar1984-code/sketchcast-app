-- SketchCast AI — Teacher beta: server-side caps + view events + feedback
-- ============================================================================
-- A `beta_tester` marker on a teacher activates hard caps for THAT teacher:
--   * 1 book upload
--   * generation for 1 chapter only (any/all content kinds for that chapter)
--   * 2 students max
-- Caps are BEFORE-INSERT TRIGGERS, so they hold against direct API calls and
-- even service-role inserts (triggers fire regardless of RLS) — a curious
-- teacher cannot bypass a limit and trigger generation cost. Non-beta accounts
-- are completely unaffected (every trigger no-ops unless beta_tester = true).
--
-- Also adds:
--   * artifact_views — one row per (teacher, generation, artifact kind) opened;
--     drives the "you've seen everything → give feedback" prompt.
--   * beta_feedback — one submission per teacher (UNIQUE teacher_id enforces
--     single-submission at the DB level), structured ratings + free text.
--
-- Inert until a teacher is flagged: update profiles set beta_tester = true
-- where id = '<teacher-uuid>';  Safe to run on the existing database.
-- ============================================================================

-- ── Marker ──────────────────────────────────────────────────────────────────
alter table profiles add column if not exists beta_tester boolean not null default false;

create or replace function is_beta_tester(uid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select coalesce((select beta_tester from profiles where id = uid), false) $$;

-- ── Cap 1: one book ─────────────────────────────────────────────────────────
-- INSERT: at most one book row. UPDATE: the owner may not swap the row's
-- content (a new storage_path / chapter map would be a second book in the same
-- row). Keyed off auth.uid() = owner so the WORKER's legitimate service-role
-- updates (indexing writes chapters/status; auth.uid() is null there) pass.
create or replace function enforce_beta_book_cap() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  if not is_beta_tester(new.owner_id) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('beta_book:' || new.owner_id::text));
  if tg_op = 'UPDATE' then
    if auth.uid() = new.owner_id
       and (new.storage_path is distinct from old.storage_path
            or new.chapters is distinct from old.chapters
            or new.owner_id is distinct from old.owner_id) then
      raise exception 'Beta is limited to 1 book.';
    end if;
    return new;
  end if;
  if (select count(*) from books where owner_id = new.owner_id) >= 1 then
    raise exception 'Beta is limited to 1 book. You can generate for one chapter of the book you already uploaded.';
  end if;
  return new;
end $$;

drop trigger if exists beta_book_cap on books;
create trigger beta_book_cap
  before insert or update of storage_path, chapters, owner_id on books
  for each row execute function enforce_beta_book_cap();

-- ── Cap 2: one chapter (all content kinds allowed for it) ───────────────────
-- INSERT: the first generation pins the (book, chapter); later inserts must
-- match it. UPDATE: the owner may not MOVE the pin (updating chapter_ref and
-- then inserting would sidestep the insert check).
create or replace function enforce_beta_generation_cap() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  if not is_beta_tester(new.owner_id) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('beta_gen:' || new.owner_id::text));
  if tg_op = 'UPDATE' then
    if auth.uid() = new.owner_id
       and (new.book_id is distinct from old.book_id
            or new.chapter_ref is distinct from old.chapter_ref) then
      raise exception 'Beta is limited to 1 chapter. You can generate every content type for the chapter you already picked.';
    end if;
    return new;
  end if;
  if exists (
       select 1 from generations g
       where g.owner_id = new.owner_id
         and (g.book_id is distinct from new.book_id
              or g.chapter_ref is distinct from new.chapter_ref)
     ) then
    raise exception 'Beta is limited to 1 chapter. You can generate every content type for the chapter you already picked.';
  end if;
  return new;
end $$;

drop trigger if exists beta_generation_cap on generations;
create trigger beta_generation_cap
  before insert or update of book_id, chapter_ref on generations
  for each row execute function enforce_beta_generation_cap();

-- ── Cap 3: two students ─────────────────────────────────────────────────────
-- Counts DISTINCT students across all the teacher's classes; re-enrolling one
-- of the existing two into another class stays allowed.
create or replace function enforce_beta_student_cap() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare owner uuid;
begin
  select teacher_id into owner from classes where id = new.class_id;
  if owner is null or not is_beta_tester(owner) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('beta_stu:' || owner::text));
  if (select count(distinct e.student_id) from enrollments e
      join classes c on c.id = e.class_id
      where c.teacher_id = owner
        and e.student_id <> new.student_id) >= 2 then
    raise exception 'Beta is limited to 2 students.';
  end if;
  return new;
end $$;

drop trigger if exists beta_student_cap on enrollments;
create trigger beta_student_cap before insert on enrollments
  for each row execute function enforce_beta_student_cap();

-- ── Close a generation-cost side door ────────────────────────────────────────
-- 0001's jobs_insert policy let any generation OWNER queue jobs directly — the
-- worker would happily regenerate on each one, bypassing every cap. The client
-- has never inserted jobs (they're created by the on_generation_created
-- trigger); only the worker (service role, bypasses RLS) touches them. Drop it.
drop policy if exists jobs_insert on jobs;

-- ── View events (feeds the "accessed everything" feedback trigger) ──────────
create table if not exists artifact_views (
  id              uuid primary key default gen_random_uuid(),
  teacher_id      uuid not null references profiles(id) on delete cascade,
  generation_id   uuid not null references generations(id) on delete cascade,
  kind            text not null,           -- 'video_mp4' | 'deck_pptx' | 'docx'
  first_viewed_at timestamptz not null default now(),
  unique (teacher_id, generation_id, kind)
);
create index if not exists artifact_views_teacher_idx on artifact_views (teacher_id);

alter table artifact_views enable row level security;
drop policy if exists av_own_rw on artifact_views;
create policy av_own_rw on artifact_views for all
  using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

-- ── Feedback (single submission per teacher, DB-enforced) ───────────────────
create table if not exists beta_feedback (
  id            uuid primary key default gen_random_uuid(),
  teacher_id    uuid not null unique references profiles(id) on delete cascade,
  overall       int not null check (overall between 1 and 5),
  lesson_quality int not null check (lesson_quality between 1 and 5),
  deck_quality  int not null check (deck_quality between 1 and 5),
  ease_of_use   int not null check (ease_of_use between 1 and 5),
  worked_well   text,
  improve       text,
  trigger_type  text not null default 'manual' check (trigger_type in ('auto', 'manual')),
  context       jsonb,                     -- usage snapshot at submit time
  submitted_at  timestamptz not null default now()
);

alter table beta_feedback enable row level security;
drop policy if exists bf_own_insert on beta_feedback;
create policy bf_own_insert on beta_feedback for insert
  with check (teacher_id = auth.uid());
drop policy if exists bf_own_read on beta_feedback;
create policy bf_own_read on beta_feedback for select
  using (teacher_id = auth.uid());
-- The founder view reads all rows via the service role (bypasses RLS).
