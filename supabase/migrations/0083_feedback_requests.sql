-- Feedback requests + manual activation reminders (console-triggered).
--
-- Context: the lifecycle cron (0080) nudges automatically; this gives the
-- founder two MANUAL levers on the console roster — "ask this teacher the
-- 6-question feedback questionnaire" and "send the activation nudge now".
--
-- All three tables are SERVICE-ROLE ONLY: RLS is enabled with NO policies, so
-- every normal client is denied. The app talks to them exclusively through
-- server routes using the admin client:
--   POST /api/console/feedback-request  (staff)  — create a request
--   POST /api/console/remind            (staff)  — manual lifecycle nudge
--   POST /api/feedback action=submit|later (user) — answer / snooze own request

-- One row per ask. A request is OPEN while responded_at is null AND
-- (snoozed_until is null OR snoozed_until > now()); the route refuses (409) to
-- stack a second open request on the same user. After an answer a NEW request
-- is allowed — history is kept, not overwritten.
create table if not exists public.feedback_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  requested_by  uuid not null,
  created_at    timestamptz not null default now(),
  -- "Maybe later" — the in-app ask re-surfaces after this passes.
  snoozed_until timestamptz,
  responded_at  timestamptz
);

comment on table public.feedback_requests is
  'Founder-triggered asks for the in-app feedback questionnaire. Open = '
  'responded_at null and (snoozed_until null or in the future).';

create index if not exists feedback_requests_user_idx
  on public.feedback_requests (user_id);

alter table public.feedback_requests enable row level security;

-- The questionnaire answers. Scores are 1–5 stars; most_used mirrors the kit
-- artifact kinds (plus 'none' — "Haven't used them yet").
create table if not exists public.feedback_responses (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.feedback_requests(id) on delete cascade,
  user_id     uuid not null,
  ease        smallint not null check (ease between 1 and 5),
  usefulness  smallint not null check (usefulness between 1 and 5),
  quality     smallint not null check (quality between 1 and 5),
  most_used   text not null check (most_used in
    ('presentation','worksheet','exam_paper','lesson_plan','activity','case_study','none')),
  -- Free text: "what almost stopped you" / "what should we build next".
  blocker     text,
  wish        text,
  contact_ok  boolean not null default false,
  created_at  timestamptz not null default now()
);

comment on table public.feedback_responses is
  'Answers to the 6-question feedback questionnaire, one row per submission.';

create index if not exists feedback_responses_request_idx
  on public.feedback_responses (request_id);

alter table public.feedback_responses enable row level security;

-- Manual reminder ledger. The cron's lifecycle_emails (0080) stays the
-- automated sent-marker; this records founder-clicked sends. The 3-day
-- cooldown in /api/console/remind reads BOTH tables — an automated send also
-- disables manual for 3 days (founder's rule).
create table if not exists public.console_reminders (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references public.profiles(id) on delete cascade,
  segment  text not null check (segment in ('no_upload','no_generation')),
  sent_by  uuid not null,
  sent_at  timestamptz not null default now()
);

comment on table public.console_reminders is
  'Manual activation reminders sent from the console roster. Written only '
  'AFTER a successful send, mirroring lifecycle_emails.';

create index if not exists console_reminders_user_idx
  on public.console_reminders (user_id);

alter table public.console_reminders enable row level security;

-- One UNANSWERED request per user, enforced by the database rather than the
-- route's check-then-write (two concurrent asks could both pass the 409 check;
-- with this index the second insert fails loudly instead of leaving two open
-- requests for the dashboard and console to disagree over).
create unique index if not exists feedback_requests_one_unanswered
  on public.feedback_requests (user_id)
  where responded_at is null;
