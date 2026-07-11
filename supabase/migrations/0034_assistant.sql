-- 0034 — AI Teaching Assistant: session history + per-turn telemetry.
--
-- The assistant (replacing "Ask Coach" as the active student-tutor path) keeps
-- the ACTIVE session's turns in context and summarises older history. Retention
-- is ~30 days, enforced on session open (delete by created_at — indexed).
-- Privacy: rows are RLS-scoped to the owning student; teachers/parents keep
-- aggregate recaps only (the existing recap surface) — never raw chat.
--
-- Additive + idempotent. Safe to run as one execution.

create table if not exists public.assistant_sessions (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.profiles(id) on delete cascade,
  started_at  timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  summary     text,                       -- reserved: model-written session summary
  created_at  timestamptz not null default now()
);
create index if not exists assistant_sessions_lookup
  on public.assistant_sessions (student_id, last_at desc);
alter table public.assistant_sessions enable row level security;
drop policy if exists assistant_sessions_student_read on public.assistant_sessions;
create policy assistant_sessions_student_read on public.assistant_sessions
  for select using (student_id = auth.uid());
revoke insert, update, delete on public.assistant_sessions from anon, authenticated;

create table if not exists public.assistant_messages (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.assistant_sessions(id) on delete cascade,
  student_id      uuid not null references public.profiles(id) on delete cascade,
  role            text not null check (role in ('student','assistant')),
  content         text not null,
  source_book_id  uuid,          -- grounded answers: which book/chapter answered
  source_chapter  int,
  source_label    text,          -- "Chapter 3 — Photosynthesis" (the "from your …" tag)
  provider        text,          -- llm adapter id, for cost attribution
  latency         jsonb,         -- {retrievalMs, firstTokenMs, totalMs, toolMs}
  tokens          jsonb,         -- {inputTokens, outputTokens}
  created_at      timestamptz not null default now()
);
create index if not exists assistant_messages_session on public.assistant_messages (session_id, created_at);
create index if not exists assistant_messages_retention on public.assistant_messages (student_id, created_at);
alter table public.assistant_messages enable row level security;
drop policy if exists assistant_messages_student_read on public.assistant_messages;
create policy assistant_messages_student_read on public.assistant_messages
  for select using (student_id = auth.uid());
revoke insert, update, delete on public.assistant_messages from anon, authenticated;
