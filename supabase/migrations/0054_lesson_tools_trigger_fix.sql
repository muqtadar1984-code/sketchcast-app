-- 0054 — URGENT FIX for 0052: enforce_lesson_tools broke generation inserts.
--
-- The function is shared by triggers on BOOKS and GENERATIONS, but its
-- content-swap guard referenced new.storage_path/new.chapters inside one
-- combined boolean expression. PL/pgSQL resolves record fields when it PLANS
-- the expression — and on the generations trigger NEW has no storage_path,
-- so every client-side generation INSERT failed with
--   record "new" has no field "storage_path"
-- (reported by Sara Junaidi, 2026-07-18). The worker was unaffected (service
-- role returns before that expression).
--
-- Fix: nested IF statements. PL/pgSQL plans statements lazily on first
-- execution, and the books-only field access now lives in a statement that
-- can only ever execute on the books trigger (TG_OP = 'UPDATE' exists only
-- there — the generations trigger is INSERT-only).
--
-- Idempotent: safe to re-run. Replaces the 0052 function in place; both
-- triggers keep pointing at it.

create or replace function enforce_lesson_tools() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  -- Only SELF-SERVICE writes gate (auth.uid() = the row's owner). The worker,
  -- console and seeder run as the service role (auth.uid() IS NULL) and pass.
  if auth.uid() is distinct from new.owner_id then
    return new;
  end if;
  -- Books trigger only (insert OR update): a metadata-only edit stays allowed
  -- for a flagged owner; a CONTENT SWAP (new file / new chapter map) is an
  -- upload by another name. The generations trigger is INSERT-only, so this
  -- branch — and its books-only fields — can never plan there.
  if TG_OP = 'UPDATE' then
    if new.storage_path is not distinct from old.storage_path
       and new.chapters is not distinct from old.chapters then
      return new;
    end if;
  end if;
  if (select coalesce(lesson_tools, true) from profiles where id = new.owner_id) then
    return new;
  end if;
  raise exception 'Lesson tools are not enabled on this account — SketchCast manages teacher tool access. Contact support.';
end $$;
