-- SketchCast AI — student progress + submissions (Phase B)
-- ----------------------------------------------------------------------------
-- student_progress: one row per (assigned generation × student) recording the
--   completion lifecycle. Completed = 100% (video watched to the end, or a
--   worksheet/exam submitted). Re-opening a completed item -> 'revised'.
-- submissions: a student's worksheet/exam answer — either an uploaded file
--   (file-submit path) or, later, interactive answers. Holds the grade.
-- Both are written by the student under RLS (own rows) and read by the teacher
-- who owns the generation. Safe to run on the existing database.
-- ----------------------------------------------------------------------------

do $$ begin
  create type progress_status as enum ('assigned', 'in_progress', 'completed', 'revised');
exception when duplicate_object then null; end $$;

create table if not exists student_progress (
  id             uuid primary key default gen_random_uuid(),
  generation_id  uuid not null references generations(id) on delete cascade,
  student_id     uuid not null references profiles(id) on delete cascade,
  class_id       uuid references classes(id) on delete set null,
  status         progress_status not null default 'in_progress',
  progress_pct   int not null default 0,
  opened_at      timestamptz default now(),
  completed_at   timestamptz,
  revised_at     timestamptz,
  revision_count int not null default 0,
  updated_at     timestamptz not null default now(),
  unique (generation_id, student_id)
);
create index if not exists student_progress_student_idx on student_progress (student_id);
create index if not exists student_progress_generation_idx on student_progress (generation_id);

create table if not exists submissions (
  id             uuid primary key default gen_random_uuid(),
  generation_id  uuid not null references generations(id) on delete cascade,
  student_id     uuid not null references profiles(id) on delete cascade,
  mode           text not null default 'file',          -- 'file' | 'interactive'
  answers        jsonb,
  file_path      text,                                  -- in the 'submissions' bucket
  auto_score     int,
  max_score      int,
  teacher_score  numeric,
  feedback       text,
  grade_status   text not null default 'pending',       -- 'pending' | 'auto' | 'graded'
  submitted_at   timestamptz not null default now(),
  graded_by      uuid references profiles(id) on delete set null,
  graded_at      timestamptz,
  unique (generation_id, student_id)
);
create index if not exists submissions_generation_idx on submissions (generation_id);
create index if not exists submissions_student_idx on submissions (student_id);

drop trigger if exists student_progress_touch on student_progress;
create trigger student_progress_touch before update on student_progress
  for each row execute function touch_updated_at();

alter table student_progress enable row level security;
alter table submissions      enable row level security;

-- student manages own rows; teacher reads (and grades) rows for content they own
drop policy if exists sp_student_rw on student_progress;
create policy sp_student_rw on student_progress for all
  using (student_id = auth.uid()) with check (student_id = auth.uid());
drop policy if exists sp_teacher_read on student_progress;
create policy sp_teacher_read on student_progress for select
  using (generation_id in (select id from generations where owner_id = auth.uid()));

drop policy if exists sub_student_rw on submissions;
create policy sub_student_rw on submissions for all
  using (student_id = auth.uid()) with check (student_id = auth.uid());
drop policy if exists sub_teacher_read on submissions;
create policy sub_teacher_read on submissions for select
  using (generation_id in (select id from generations where owner_id = auth.uid()));
drop policy if exists sub_teacher_grade on submissions;
create policy sub_teacher_grade on submissions for update
  using (generation_id in (select id from generations where owner_id = auth.uid()))
  with check (generation_id in (select id from generations where owner_id = auth.uid()));

-- 50 MB answer uploads; student manages files under a folder named by their uid.
insert into storage.buckets (id, name, public, file_size_limit)
  values ('submissions', 'submissions', false, 52428800)
  on conflict (id) do update set file_size_limit = excluded.file_size_limit;
drop policy if exists submissions_student_rw on storage.objects;
create policy submissions_student_rw on storage.objects for all
  using (bucket_id = 'submissions' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'submissions' and (storage.foldername(name))[1] = auth.uid()::text);
