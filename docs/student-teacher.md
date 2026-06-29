# Student ↔ Teacher system + Teacher analytics — design

Status: scoped & decided 2026-06-29. Phase A in progress.

## Goal
A teacher assigns the content generated for a chapter to the students who need it;
students complete it; the teacher sees, per student, what is **completed / revised /
incomplete**, plus scores — all in one analytics view.

## Decisions (locked)
1. **Completed = 100%** for every assigned item: lesson video watched to 100%;
   test/worksheet finished 100% (not a self-report).
2. **Assigning a chapter assigns everything student-facing** for it — lesson
   (video + deck), worksheet, exam, activity, case study. The **lesson plan is
   teacher-only** and never assigned to students.
3. **Tests/worksheets support two completion paths** (student chooses):
   - **Interactive** — questions render in-app, student answers + submits.
     Objective questions auto-grade; subjective answers are stored for the teacher.
   - **File submit** — download the `.docx`, do it offline, upload an answer file;
     the teacher grades manually.
   Either way *completed = submitted*; the grade is a separate layer.
4. **Teacher sees completion status + scores** (auto where objective, manual otherwise).
5. **Revised = any re-open** of an already-completed item (`revision_count++`).
6. **Student identity**: the school gives a login **ID + password** to parents.
   Login is the student ID (a synthetic unique auth email under the hood, since
   siblings may share one parent email); the **parent's email** is stored on the
   profile for communication (notifications, reset), not as the login.

## Already in the schema (build on, don't reinvent — see `0001_init.sql`)
`profiles(role student|teacher|school_admin, school_id)`, `classes(teacher_id,
school_id, join_code)`, `enrollments(class_id, student_id)`,
`generation_shares(generation_id, class_id, shared_by, due_at)`, and RLS helper
`shared_to_me(gen)` (a student can already read content shared to any class they're
enrolled in). The assignment primitive exists; what's missing is identity
provisioning, progress tracking, and the student/analytics UIs.

## New data model

```sql
-- profiles additions
alter table profiles add column if not exists username text unique;       -- student login ID
alter table profiles add column if not exists parent_email text;           -- comms only
alter table profiles add column if not exists must_reset_password boolean default false;

-- universal completion record (video, quiz, file)
create type progress_status as enum ('assigned','in_progress','completed','revised');
create table student_progress (
  id uuid pk, generation_id uuid->generations, student_id uuid->profiles,
  class_id uuid->classes, status progress_status default 'in_progress',
  progress_pct int default 0, opened_at, completed_at, revised_at,
  revision_count int default 0, updated_at,
  unique(generation_id, student_id));

-- test/worksheet specifics (dual path + grading)
create table submissions (
  id uuid pk, generation_id uuid->generations, student_id uuid->profiles,
  mode text,            -- 'interactive' | 'file'
  answers jsonb,        -- interactive responses
  file_path text,       -- uploaded answer file (new 'submissions' bucket)
  auto_score int, max_score int,
  teacher_score numeric, feedback text,
  grade_status text,    -- 'auto' | 'pending' | 'graded'
  submitted_at, graded_by, graded_at,
  unique(generation_id, student_id));
```

New `artifact_kind 'questions_json'`; new `submissions` storage bucket (student
writes own folder, generation-owner teacher reads).

**Assigned set is derived, progress is recorded.** Don't fan-out a progress row
per student at assign time. The "assigned set" = `generation_shares ⋈ enrollments`
(auto-adjusts to enrollment changes); `student_progress` holds only actual
activity. **Incomplete** = assigned with no completed row; **overdue** = past `due_at`.

## Completion mechanics
- **Lesson video** — track playback; `completed` at 100%.
- **Interactive quiz** — all questions answered + Submit → `completed`; objective
  auto-graded into `submissions.auto_score`, subjective left `pending`.
- **File submit** — upload answer file → `completed` (submitted); teacher grades →
  `teacher_score`.
- **Revise** — re-opening a completed item sets `revised` + `revision_count++`.

## Worker change (only backend work, Phase C)
The worksheet/exam generator emits a structured `questions.json` (questions +
answer key — the exam path already produces a key) **alongside** the existing
`.docx`. The interactive player reads the JSON; the `.docx` serves the
file-submit / print path.

## Teacher analytics dashboard (Phase C)
One page from `assigned-set ⋈ student_progress ⋈ submissions`:
metric cards (classes · students · active assignments · completion % · overdue);
per-class completion; per-chapter completion + **revision hotspots** (hard topics);
per-student roster with status + scores; **needs-attention** (overdue / never-opened)
first; recent activity feed.

## RLS additions
```sql
-- student manages own progress / submissions
create policy sp_student_rw on student_progress for all
  using (student_id = auth.uid()) with check (student_id = auth.uid());
-- teacher reads progress/submissions for content they own
create policy sp_teacher_read on student_progress for select
  using (generation_id in (select id from generations where owner_id = auth.uid()));
-- teacher reads profiles of students enrolled in their classes (roster)
create policy profiles_teacher_read on profiles for select
  using (id in (select e.student_id from enrollments e
                join classes c on c.id = e.class_id where c.teacher_id = auth.uid()));
```
Student provisioning runs server-side with the **service role** (bypasses RLS).
Student artifact downloads are signed server-side with the service role for the
specific artifacts RLS confirms are shared to that student (the `artifacts`
storage policy only lets the owner sign directly).

## Build phases
- **Phase A — identity + assignment loop.** profiles fields; service-role student
  provisioning (Next.js Route Handler `/api/students`); join-by-code; teacher
  Classes UI (create class, add students → IDs/passwords, roster, join code);
  "assign whole chapter (all student kinds) + due date"; **student dashboard
  (read-only)** of assigned chapters. *No grading yet.*
- **Phase B — completion + reverse feedback.** `student_progress`; video
  100%-completion + reopen→revised; **file-submit** path (`submissions` + bucket,
  manual grade); teacher roster (✓ completed · ↻ revised · ○ incomplete · ⏰ overdue)
  + manual grade entry.
- **Phase C — interactive quizzes + analytics.** worker emits `questions.json`;
  in-app quiz player (auto-grade objective + manual subjective); the analytics
  dashboard.

## Env / ops
`SUPABASE_SERVICE_ROLE_KEY` must be set in Vercel (and `.env.local` for local dev)
for provisioning + student artifact signing. Migrations live in
`supabase/migrations/` and must be applied to the Supabase project before the
matching deploy.
