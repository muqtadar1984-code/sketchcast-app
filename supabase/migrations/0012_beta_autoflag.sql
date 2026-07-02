-- SketchCast AI — public beta: auto-flag every NEW registration as beta_tester
-- ============================================================================
-- Going public: every newly registered account is a beta tester (capped per
-- migration 0011). EXISTING accounts keep beta_tester = false → uncapped
-- (founder/staff unaffected). To lift a specific account's caps later:
--   update profiles set beta_tester = false where id = '<uuid>';
-- Also adds signup_notified_at — the exactly-once marker for the founder's
-- new-registration email (sent by the app on first dashboard visit).
-- Requires 0011 (beta_tester column). Safe to run on the existing database.
-- ============================================================================

alter table profiles add column if not exists signup_notified_at timestamptz;

-- Everyone who exists BEFORE this migration is not a "new registration" —
-- mark them notified so the founder only gets emails for genuinely new accounts.
update profiles set signup_notified_at = now() where signup_notified_at is null;

create or replace function handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  insert into public.profiles (id, full_name, role, beta_tester)
  values (new.id, new.raw_user_meta_data->>'full_name',
          coalesce((new.raw_user_meta_data->>'role')::user_role, 'teacher'),
          true)  -- public beta: every new registration starts capped
  on conflict (id) do nothing;
  return new;
end $$;
