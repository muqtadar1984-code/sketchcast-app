-- 0084 — Allow 'welcome' in the lifecycle email ledger.
--
-- The founder-approved welcome email (sent once, on a new account's first
-- dashboard visit) records into lifecycle_emails like every other lifecycle
-- send, so the existing machinery covers it for free:
--   · unique (user_id, segment) is the once-ever guard;
--   · the manual-remind cooldown reads this table with no segment filter, so a
--     fresh welcome blocks the console Remind button for 3 days (founder rule:
--     any email that reached the user starts the cooldown);
--   · the cron's per-segment dedup is untouched — its 3-day no_book nudge
--     still fires on schedule for a user who stays inactive after the welcome.

alter table public.lifecycle_emails
  drop constraint if exists lifecycle_emails_segment_check;

alter table public.lifecycle_emails
  add constraint lifecycle_emails_segment_check
  check (segment in ('no_book', 'no_generation', 'welcome'));
