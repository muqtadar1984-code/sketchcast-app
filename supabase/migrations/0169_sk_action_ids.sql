-- 0169: SK S2 slice A — the action id on the rows an SK action writes
-- (Final Plan 2026-10-28 §2.5, §8.2, §9.2; docs/sk-actions.md "S2 action core").
--
-- From S2 on, a confirm-tier action's write runs AS THE TEACHER: /api/sk/act
-- verifies the token, consumes it through 0163's service-role
-- sk_consume_action_token, then inserts with the USER-SESSION client, so the
-- existing RLS policies and triggers decide what is allowed (dn_insert for the
-- diary, gen_write for generations). No SECURITY DEFINER function re-implements
-- owns_class / teaches_student.
--
-- The row carries `sk_action_id` = the consumed token's id, and a partial
-- unique index makes the write idempotent per (action, target):
--
--   diary_notes  (sk_action_id, coalesce(student_id, class_id))
--                — one `parents.remind` action writes one note PER STUDENT;
--                  one `diary.note` action writes one note to one target.
--   generations  (sk_action_id, kind, coalesce(params->>'part', '1'))
--                — slice B (queued kit/chapter jobs): one row per kind and part.
--
-- A second write under the same action id fails with 23505 and the app reports
-- "That was already done." No foreign key to sk_action_tokens: the audit value
-- outlives token housekeeping, and a NULL (every non-SK write) is unconstrained.
--
-- No RLS change: policies carry no column lists, and `authenticated` holds the
-- table-level INSERT grant on both tables (checked on production 2026-10-29),
-- so the owner's existing insert policies already cover the new column.
--
-- Run as ONE execution. Idempotent.
begin;

alter table public.diary_notes add column if not exists sk_action_id uuid;
alter table public.generations add column if not exists sk_action_id uuid;

create unique index if not exists diary_notes_sk_action_target_uidx
  on public.diary_notes (sk_action_id, (coalesce(student_id, class_id)))
  where sk_action_id is not null;

create unique index if not exists generations_sk_action_kind_part_uidx
  on public.generations (sk_action_id, kind, (coalesce(params->>'part', '1')))
  where sk_action_id is not null;

comment on column public.diary_notes.sk_action_id is
  'SK action token id (sk_action_tokens.id) that wrote this note; null for notes written in the app. Unique per (action, target).';
comment on column public.generations.sk_action_id is
  'SK action token id (sk_action_tokens.id) that queued this generation; null otherwise. Unique per (action, kind, part).';

commit;
