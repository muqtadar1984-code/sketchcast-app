-- 0052 — Staff-managed teachers + lesson-tools gating.
--
-- Product decision (2026-07-17): SketchCast staff add, edit and delete
-- teacher accounts — schools do NOT self-provision staff. A school with
-- unlimited self-serve teacher creation can outgrow what its contract (and
-- our generation capacity) covers; keeping provisioning with staff is the
-- capacity-control valve. Concretely:
--
--   1. invites_admin_all WITH CHECK now permits role = 'parent' ONLY. The
--      school admin's invite surface remains for parent onboarding (child
--      mapping), but teacher/school_admin invites are rejected AT THE
--      POLICY — the UI removal alone would be bypassable via PostgREST.
--   2. profiles.lesson_tools (default true): false = this teacher does not
--      teach from books (PE, Music, Art, drama...) and gets no book upload /
--      lesson generation tools. Set by SketchCast staff. Enforced by
--      triggers on books and generations INSERT so the UI gating can't be
--      bypassed; the service role (worker, console, seeder) is exempt via
--      the NULL-safe auth.uid() check — same polarity lesson as 0047.
--
-- Idempotent: safe to re-run.

alter table profiles add column if not exists lesson_tools boolean not null default true;

create or replace function enforce_lesson_tools() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  -- Only SELF-SERVICE writes gate (auth.uid() = the row's owner). The worker,
  -- console and seeder run as the service role (auth.uid() IS NULL) and pass.
  if auth.uid() is distinct from new.owner_id then
    return new;
  end if;
  -- Metadata-only edits (title, cover) stay allowed for a flagged owner; a
  -- CONTENT SWAP (new file / new chapter map) is an upload by another name —
  -- the same channel the 0046 ledger guards for caps.
  if TG_OP = 'UPDATE'
     and new.storage_path is not distinct from old.storage_path
     and new.chapters is not distinct from old.chapters then
    return new;
  end if;
  if (select coalesce(lesson_tools, true) from profiles where id = new.owner_id) then
    return new;
  end if;
  raise exception 'Lesson tools are not enabled on this account — SketchCast manages teacher tool access. Contact support.';
end $$;

drop trigger if exists books_lesson_tools on books;
create trigger books_lesson_tools before insert or update on books
  for each row execute function enforce_lesson_tools();

-- A flagged teacher may still hold shared or legacy books — generation is
-- gated too, not just upload.
drop trigger if exists generations_lesson_tools on generations;
create trigger generations_lesson_tools before insert on generations
  for each row execute function enforce_lesson_tools();

-- Teacher/admin invites end here; parents (child-mapped onboarding) remain.
drop policy if exists invites_admin_all on invites;
create policy invites_admin_all on invites for all
  using (current_role_val() = 'school_admin' and school_id = current_school_id())
  with check (current_role_val() = 'school_admin' and school_id = current_school_id() and role = 'parent');

-- Pending teacher/admin invite links issued BEFORE this migration would stay
-- redeemable until they expire (the accept route runs as the service role) —
-- expire them now so the staff-managed rule holds from day one.
update invites set expires_at = now() where accepted_at is null and role <> 'parent';
