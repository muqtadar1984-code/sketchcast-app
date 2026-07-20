-- 0064 — Getting-started stepper: the dismissal watermark.
--
-- New joiners get an inline, progress-tracking checklist on the Library
-- (Upload a textbook → Generate a lesson → Assign it) that checks each step
-- off from their real data and disappears when finished or dismissed. The one
-- piece of persisted state is "has this user dismissed / finished it" — a
-- single timestamp on the profile, exactly like the notifications bell
-- watermark (0055).
--
-- Existing accounts have already learned the app, so we BACKFILL them as
-- dismissed: only a row whose column is still NULL (a genuinely new signup
-- created after this runs) ever shows the guide. Gated in the app by
-- FEATURE_GETTING_STARTED, so nothing appears until it's turned on.
--
-- Idempotent: safe to re-run.

alter table profiles add column if not exists getting_started_dismissed_at timestamptz;

-- Mark every existing profile as done (one-time). New profiles default to NULL
-- (no column default) → they see the guide; everyone here already knows the app.
update profiles set getting_started_dismissed_at = now() where getting_started_dismissed_at is null;

-- 0010 revoked blanket UPDATE on profiles and re-granted only safe columns. This
-- is benign per-user UI state, so the owner sets it straight from the client
-- (same as notifications_seen_at, 0055) — the profiles_update_self row policy
-- still confines the write to their own row.
grant update (getting_started_dismissed_at) on public.profiles to authenticated;
