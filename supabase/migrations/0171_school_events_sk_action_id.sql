-- 0171: SK S5 slice D — the action id on a school notice SK posts
-- (Final Plan 2026-10-28 §4, §8.2, §9.2; SK S5 design 2026-10-29 decisions 3–4).
--
-- `notice.school` is SK's first leader action: a principal (or a coordinator)
-- posts a school-wide or all-staff notice from a CLICK-ONLY card. /api/sk/act
-- verifies the token, consumes it through 0163's service-role
-- sk_consume_action_token, then inserts the school_events row (is_notice =
-- true) with the USER-SESSION client — exactly the row POST /api/notices
-- writes, built by the same shared builder. The existing policies decide:
-- se_admin_write (the principal of this school) and se_coordinator_write
-- (school/staff audience, created_by = me, leader_of_school). No SECURITY
-- DEFINER function re-implements them.
--
-- The row carries `sk_action_id` = the consumed token's id. One notice action
-- writes exactly ONE row, so the partial unique index is on the id alone; a
-- second write under the same action fails with 23505 and the app reports
-- "That was already done." No foreign key to sk_action_tokens (the audit value
-- outlives token housekeeping); NULL — every notice written in the app — is
-- unconstrained. Same shape as 0169 (diary_notes / generations).
--
-- No RLS change: none of the seven school_events policies carries a column
-- list, and `authenticated` holds the table-level INSERT grant (checked on
-- production 2026-10-29), so the existing write policies already cover the
-- new column.
--
-- Run as ONE execution. Idempotent.
begin;

alter table public.school_events add column if not exists sk_action_id uuid;

create unique index if not exists school_events_sk_action_uidx
  on public.school_events (sk_action_id)
  where sk_action_id is not null;

comment on column public.school_events.sk_action_id is
  'SK action token id (sk_action_tokens.id) that posted this notice; null for rows written in the app. Unique: one SK action writes one row.';

commit;
