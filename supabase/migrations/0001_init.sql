-- SketchCast AI — foundational schema + Row-Level Security
-- ----------------------------------------------------------------------------
-- Access model (confirmed with product):
--   * Schools are first-class but OPTIONAL (independent/tuition teachers have
--     school_id = NULL).
--   * books        = SHARED LIBRARY. Everyone in the same school can read/use a
--                    book; an independent teacher's books are private to them.
--                    Only the owner can edit/delete.
--   * generations  = teacher-OWNED outputs (presentation, lesson_plan,
--                    worksheet, exam_paper, case_study, activity). Visible to
--                    the owner, to students it is explicitly shared with (via
--                    their class), and READ-ONLY to school admins of the same
--                    school.
--   * schools have READ-ONLY visibility into everything in their school.
-- ----------------------------------------------------------------------------

create extension if not exists "pgcrypto";

-- Idempotent reset — drop prior objects so this migration can be re-run cleanly.
drop table if exists generation_shares, jobs, artifacts, generations, books, enrollments, classes, profiles, schools cascade;
drop type if exists user_role, book_kind, generation_kind, job_status, artifact_kind cascade;
drop function if exists current_school_id() cascade;
drop function if exists current_role_val() cascade;
drop function if exists shared_to_me(uuid) cascade;
drop function if exists handle_new_user() cascade;
drop function if exists touch_updated_at() cascade;
drop trigger if exists on_auth_user_created on auth.users;
drop policy if exists uploads_rw on storage.objects;
drop policy if exists artifacts_owner_rw on storage.objects;

-- ── Enums ───────────────────────────────────────────────────────────────────
create type user_role       as enum ('school_admin', 'teacher', 'student');
create type book_kind        as enum ('textbook', 'material');
create type generation_kind  as enum ('presentation', 'lesson_plan', 'worksheet', 'exam_paper', 'case_study', 'activity');
create type job_status       as enum ('queued', 'processing', 'done', 'error');
create type artifact_kind    as enum ('deck_pptx', 'video_mp4', 'slide_png', 'pdf', 'docx', 'other');

-- ── Core tables ─────────────────────────────────────────────────────────────
create table schools (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- profiles extends auth.users (one row per user)
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        user_role not null default 'teacher',
  full_name   text,
  school_id   uuid references schools(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table classes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  grade       text,
  teacher_id  uuid not null references profiles(id) on delete cascade,
  school_id   uuid references schools(id) on delete set null,
  join_code   text unique not null default encode(gen_random_bytes(4), 'hex'),
  created_at  timestamptz not null default now()
);

create table enrollments (
  id          uuid primary key default gen_random_uuid(),
  class_id    uuid not null references classes(id) on delete cascade,
  student_id  uuid not null references profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (class_id, student_id)
);

-- Uploaded source material — SHARED LIBRARY
create table books (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  author       text,
  kind         book_kind not null default 'textbook',
  owner_id     uuid not null references profiles(id) on delete cascade,
  school_id    uuid references schools(id) on delete set null,
  storage_path text,                  -- path in the `uploads` storage bucket
  pages        int,
  status       text not null default 'ready',
  created_at   timestamptz not null default now()
);

-- Generated teaching content — teacher OWNED
create table generations (
  id           uuid primary key default gen_random_uuid(),
  kind         generation_kind not null,
  book_id      uuid references books(id) on delete set null,
  chapter_ref  text,
  title        text,
  owner_id     uuid not null references profiles(id) on delete cascade,
  school_id    uuid references schools(id) on delete set null,
  status       job_status not null default 'queued',
  created_at   timestamptz not null default now()
);

-- Files produced for a generation (deck, video, worksheet pdf, …)
create table artifacts (
  id            uuid primary key default gen_random_uuid(),
  generation_id uuid not null references generations(id) on delete cascade,
  kind          artifact_kind not null,
  storage_path  text not null,        -- path in the `artifacts` storage bucket
  created_at    timestamptz not null default now()
);

-- Background work the Python (FastAPI) worker processes
create table jobs (
  id            uuid primary key default gen_random_uuid(),
  generation_id uuid references generations(id) on delete cascade,
  type          text not null,
  status        job_status not null default 'queued',
  progress      int not null default 0,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Teacher shares a generation with a class (→ its enrolled students)
create table generation_shares (
  id            uuid primary key default gen_random_uuid(),
  generation_id uuid not null references generations(id) on delete cascade,
  class_id      uuid not null references classes(id) on delete cascade,
  shared_by     uuid not null references profiles(id) on delete cascade,
  due_at        timestamptz,
  created_at    timestamptz not null default now(),
  unique (generation_id, class_id)
);

create index on classes (teacher_id);
create index on enrollments (student_id);
create index on books (owner_id);
create index on books (school_id);
create index on generations (owner_id);
create index on generations (book_id);
create index on artifacts (generation_id);
create index on jobs (status);
create index on generation_shares (class_id);

-- ── Helper functions (SECURITY DEFINER → bypass RLS inside the check) ────────
create or replace function current_school_id() returns uuid
  language sql stable security definer set search_path = public as
$$ select school_id from profiles where id = auth.uid() $$;

create or replace function current_role_val() returns user_role
  language sql stable security definer set search_path = public as
$$ select role from profiles where id = auth.uid() $$;

create or replace function shared_to_me(gen uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from generation_shares gs
     join enrollments e on e.class_id = gs.class_id
     where gs.generation_id = gen and e.student_id = auth.uid()
   ) $$;

-- ── Auto-create a profile row on signup ─────────────────────────────────────
create or replace function handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, new.raw_user_meta_data->>'full_name',
          coalesce((new.raw_user_meta_data->>'role')::user_role, 'teacher'))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

create or replace function touch_updated_at() returns trigger
  language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
create trigger jobs_touch before update on jobs
  for each row execute function touch_updated_at();

-- ── Enable RLS ──────────────────────────────────────────────────────────────
alter table schools            enable row level security;
alter table profiles           enable row level security;
alter table classes            enable row level security;
alter table enrollments        enable row level security;
alter table books              enable row level security;
alter table generations        enable row level security;
alter table artifacts          enable row level security;
alter table jobs               enable row level security;
alter table generation_shares  enable row level security;

-- ── Policies ────────────────────────────────────────────────────────────────
-- schools: members read their own school
create policy schools_read on schools for select
  using (id = current_school_id());

-- profiles: read self; school admins read profiles in their school; update self
create policy profiles_read_self on profiles for select
  using (id = auth.uid()
         or (current_role_val() = 'school_admin' and school_id = current_school_id()));
create policy profiles_update_self on profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- classes: teacher manages own; students read enrolled; school admin reads school
create policy classes_owner_all on classes for all
  using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());
create policy classes_student_read on classes for select
  using (exists (select 1 from enrollments e
                 where e.class_id = classes.id and e.student_id = auth.uid()));
create policy classes_school_read on classes for select
  using (current_role_val() = 'school_admin' and school_id = current_school_id());

-- enrollments: class teacher manages; the student reads own
create policy enroll_teacher_all on enrollments for all
  using (exists (select 1 from classes c
                 where c.id = enrollments.class_id and c.teacher_id = auth.uid()))
  with check (exists (select 1 from classes c
                 where c.id = enrollments.class_id and c.teacher_id = auth.uid()));
create policy enroll_student_read on enrollments for select
  using (student_id = auth.uid());

-- books = SHARED LIBRARY: read by owner or anyone in the same school; write by owner
create policy books_read on books for select
  using (owner_id = auth.uid()
         or (school_id is not null and school_id = current_school_id()));
create policy books_write on books for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- generations = teacher-owned; visible to owner, shared students, school admin (read)
create policy gen_read on generations for select
  using (owner_id = auth.uid()
         or shared_to_me(id)
         or (current_role_val() = 'school_admin' and school_id = current_school_id()));
create policy gen_write on generations for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- artifacts / jobs: follow the parent generation's read (RLS-filtered subquery)
create policy artifacts_read on artifacts for select
  using (generation_id in (select id from generations));
create policy artifacts_write on artifacts for all
  using (generation_id in (select id from generations where owner_id = auth.uid()))
  with check (generation_id in (select id from generations where owner_id = auth.uid()));
create policy jobs_read on jobs for select
  using (generation_id in (select id from generations));
create policy jobs_insert on jobs for insert
  with check (generation_id in (select id from generations where owner_id = auth.uid()));

-- generation_shares: teacher (owner) manages; students read shares for their classes
create policy shares_owner_all on generation_shares for all
  using (generation_id in (select id from generations where owner_id = auth.uid()))
  with check (generation_id in (select id from generations where owner_id = auth.uid()));
create policy shares_student_read on generation_shares for select
  using (exists (select 1 from enrollments e
                 where e.class_id = generation_shares.class_id and e.student_id = auth.uid()));

-- ── Storage buckets ─────────────────────────────────────────────────────────
-- 200 MB per file (209715200 bytes), matching the previous app's limit.
insert into storage.buckets (id, name, public, file_size_limit) values ('uploads', 'uploads', false, 209715200)
  on conflict (id) do update set file_size_limit = excluded.file_size_limit;
insert into storage.buckets (id, name, public, file_size_limit) values ('artifacts', 'artifacts', false, 209715200)
  on conflict (id) do update set file_size_limit = excluded.file_size_limit;

-- uploads: a user manages files under a folder named by their own uid
create policy uploads_rw on storage.objects for all
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);

-- artifacts: the owner manages; served to clients via signed URLs from the worker
create policy artifacts_owner_rw on storage.objects for all
  using (bucket_id = 'artifacts' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'artifacts' and (storage.foldername(name))[1] = auth.uid()::text);
