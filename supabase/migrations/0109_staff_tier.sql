-- 0109_staff_tier
--
-- SketchCast staff are premium users of their own product.
--
-- Founder decision 2026-09-06 (topic-catalogue plan, §1.5): "all staff accounts
-- are default premium users who have access to all features including premium."
-- Verified the same day against prod: muqtadar.quraishi@sketchcast.app resolved
-- to plan_tier = 'trial', premium_voices_allowed = false, no entitlement, no
-- caps. Nothing in the schema knew what staff was.
--
-- WHAT DEFINES STAFF
--   Membership, not the e-mail domain. `is_platform_admin(uid)` (0014: an
--   unrevoked platform_admins row) is already how the console decides who is
--   staff, and the console Users page is where that row is granted and revoked.
--   The domain would be the wrong key: demo.parent1@sketchcast.app and
--   principal.test@sketchcast.app are demo accounts and must stay on trial.
--   The founder's account already holds its row (granted 2026-07-13, "Founder
--   console identity"); Sara's is granted from the console Users page ("Make
--   staff"). Nothing here inserts rows.
--
-- WHAT IT DOES
--   1. plan_tier(): a NEW FIRST branch returns 'staff' for platform admins.
--      First, above 'school_suspended': a staff member who happens to sit in
--      a suspended school must never be locked out of the product they run.
--      Every other branch is the live 0101 body, verbatim.
--   2. fair_use_caps('staff'): the same 2147483647 sentinel as 'school' on all
--      three columns, so every enforcer's existing "unlimited" early return
--      covers staff without a new branch anywhere (enforce_fair_use,
--      reject_double_submit, my_fair_use, effective_cap all read this table).
--   3. premium_voices_allowed(): 'staff' joins the paid allow-list. The worker
--      registry (PAID_TIERS), the app (PAID_VOICE_TIERS) and the shared
--      fixture tests/fixtures/premium_voice_cases.json change in the same
--      commit, as 0105 requires; the two repos pin the fixture's sha256.
--
-- WHAT IT DOES NOT DO
--   No table, no column, no policy. It does not touch entitlements, the
--   ledger, or credit grants: 'staff' is unlimited through the sentinel, so
--   no credit row is ever written for a staff generation (0059's trigger
--   already returns early on the sentinel path).
--
-- ROLLBACK: re-run 0107's fair_use_caps, 0105's premium_voices_allowed and
-- 0101's plan_tier bodies; nothing else changed.
--
-- NOT APPLIED BY ANY AGENT. The founder applies prod schema changes.

begin;

-- ── 1. plan_tier: staff first ────────────────────────────────────────────────
create or replace function public.plan_tier(uid uuid) returns text
  language sql stable security definer set search_path = public as
$$
  select coalesce(
    -- 0109 (0): SketchCast staff. Membership (0014 platform_admins), never the
    -- e-mail domain. Above every lock: staff run the product.
    (select 'staff' where public.is_platform_admin(uid)),
    -- 0100 (1): a suspended school locks every member — paid or not. This is
    -- the console kill switch; nothing below can out-rank it.
    (select 'school_suspended'
     from profiles p join schools s on s.id = p.school_id
     where p.id = uid and s.status <> 'active'),
    -- (2) School plan (one entitlement held by the admin; every member is 'school').
    (select 'school'
     from profiles p
     join entitlements e on e.school_id = p.school_id
     where p.id = uid and p.school_id is not null
       and e.active and e.plan_key like 'school%'
       and (e.current_period_end is null or e.current_period_end > now())
     limit 1),
    -- (3) Personal paid entitlement (the buyer's own plan). Ranked above the
    -- school trial on purpose: a teacher who pays for Pro keeps Pro even while
    -- their school is only trialling, and keeps it after that trial expires.
    (select case
       when e.plan_key like 'teacher_pro_plus%' then 'pro_plus'
       when e.plan_key like 'homeschool%'       then 'homeschool'
       when e.plan_key like 'teacher_pro%'      then 'pro'
       when e.plan_key like 'family%'           then 'family'
       when e.plan_key like 'school%'           then 'school'
     end
     from entitlements e
     where e.user_id = uid and e.active
       and (e.current_period_end is null or e.current_period_end > now())
     order by case
       when e.plan_key like 'school%'           then 1
       when e.plan_key like 'teacher_pro_plus%' then 2
       when e.plan_key like 'homeschool%'       then 3
       when e.plan_key like 'teacher_pro%'      then 4
       when e.plan_key like 'family%'           then 5
       else 6 end
     limit 1),
    -- 0100 (4): a school inside its trial window.
    (select 'school_trial'
     from profiles p join schools s on s.id = p.school_id
     where p.id = uid and s.trial_ends_at is not null and s.trial_ends_at > now()),
    -- 0100 (5): the clock ran out and nothing was paid — read-only until the
    -- console activates it. A school with NO clock (every school that predates
    -- 0100) skips (4) and (5) and resolves exactly as it did before.
    (select 'school_expired'
     from profiles p join schools s on s.id = p.school_id
     where p.id = uid and s.trial_ends_at is not null and s.trial_ends_at <= now()),
    -- Launch free-trial period: any non-school account with no paid plan, while
    -- the promo runs. School members are out (staff-provisioned/sales-led).
    (select 'promo'
     from profiles p
     where p.id = uid and p.school_id is null and now() < promo_ends_at()),
    'trial');
$$;
revoke execute on function public.plan_tier(uuid) from public, anon, authenticated;

-- ── 2. fair_use_caps: 'staff' is unlimited, like 'school' ────────────────────
create or replace function public.fair_use_caps(tier text)
returns table(parts_cap integer, docs_cap integer, books_cap integer)
language sql immutable as
$function$
  select t.parts_cap, t.docs_cap, t.books_cap from (values
    -- parts_cap is a count of GENERATIONS (0075), not lessons. Since 0103 a
    -- kit is SEVEN generations but only SIX credits — the deck rides free —
    -- so the kit counts below are parts_cap / 7.
    ('trial',      7, 0, 2147483647),  -- 1 kit — the 0057 pin, priced honestly (was 96; books via 0046 lifetime ledger)
    ('promo',     28, 0, 2),           -- 4 kits — launch trial (expired 2026-08-14; branch kept for history)
    ('pro',       28, 0, 2),           -- 4 kits
    ('pro_plus',  84, 0, 4),           -- 12 kits
    ('family',    14, 0, 2),           -- 2 kits — sold as "Home Basic" (plan_key unchanged)
    ('homeschool',56, 0, 4),           -- 8 kits, 4 books/month, 10 learners
    ('school',    2147483647, 2147483647, 2147483647),
    -- 0109: SketchCast staff (platform_admins). A sentinel, not a quantity —
    -- the same one 'school' carries, so every enforcer's unlimited path applies.
    ('staff',     2147483647, 2147483647, 2147483647),
    -- 0101: school states. school_trial is a PERIOD budget for the whole trial
    -- (any mix of kinds — docs_cap has been retired since 0059), counted from
    -- school_trial_anchor(); the two locked states are hard-stopped in the
    -- enforcers before these zeros are ever read.
    ('school_trial',     14, 0, 2),    -- 2 kits
    ('school_expired',    0, 0, 0),
    ('school_suspended',  0, 0, 0)
  ) as t(k, parts_cap, docs_cap, books_cap)
  where t.k = coalesce(tier, 'trial');
$function$;

-- ── 3. premium_voices_allowed: staff hear the premium voices ─────────────────
create or replace function public.premium_voices_allowed(uid uuid)
returns boolean
language plpgsql stable set search_path = public as
$function$
declare
  -- THE THRESHOLD. The single named constant; nothing else in the app, the
  -- worker or this schema may carry this number.
  comp_threshold constant integer := 100000;
begin
  if uid is null then
    return false;
  end if;

  -- A comp override big enough to be a grant of the product, not a seeded cap.
  -- greatest(): either column alone is enough, as it is for `unlimited`.
  if exists (
    select 1 from profiles p
     where p.id = uid
       and greatest(coalesce(p.max_books, 0), coalesce(p.max_chapters, 0)) >= comp_threshold
  ) then
    return true;
  end if;

  -- Otherwise: a paid plan, or staff (0109). Same allow-list the worker's
  -- registry calls PAID_TIERS and the app calls PAID_VOICE_TIERS. trial,
  -- promo, school_trial, school_expired and school_suspended are NOT paid.
  return plan_tier(uid) in ('pro', 'pro_plus', 'family', 'homeschool', 'school', 'staff');
end;
$function$;

-- Same ACL 0105 set; `create or replace` preserves it, restated so the file
-- stands alone.
revoke execute on function public.premium_voices_allowed(uuid) from public, anon, authenticated;
grant execute on function public.premium_voices_allowed(uuid) to service_role;

comment on function public.premium_voices_allowed(uuid) is
  '0105/0109: may this account use the premium TTS voices? Paid tier, staff (platform_admins), or a comp override at or above the threshold this function alone carries.';

commit;
