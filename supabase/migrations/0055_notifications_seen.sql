-- 0055 — Issue-status notifications: the bell's "seen" watermark.
--
-- Users who report an issue now get a bell in the app header showing every
-- report's live status (Received → Being reviewed → Being fixed → Resolved,
-- plus the resolution note) — closing the loop that previously ended at
-- "thanks, we got it". No new tables: platform_issues already carries
-- status + updated_at (touch trigger) and pi_report_read lets reporters
-- read their own rows. The one missing piece is knowing what the user has
-- already SEEN — a single watermark on the profile: anything whose
-- updated_at is newer is "unread" and counts toward the badge. Opening the
-- bell advances the watermark (profiles update-self policy covers it).
--
-- Idempotent: safe to re-run.

alter table profiles add column if not exists notifications_seen_at timestamptz;

-- 0010 closed profile self-escalation with COLUMN-level grants (revoke update
-- + grant only safe columns) — without this, the bell's watermark update is
-- permission-denied forever. Additive: exposes exactly this one benign column
-- on the user's own row (profiles_update_self row policy still applies).
grant update (notifications_seen_at) on public.profiles to authenticated;
