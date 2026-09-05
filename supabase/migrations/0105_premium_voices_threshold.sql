-- 0105: premium voices follow the PLAN or a BIG comp override — not any override.
--
-- Founder decision, 2026-09-05: "give the premium voices to users to whom i
-- have given max credits (100k or above)."
--
-- WHY THIS IS A CODE CHANGE AND NOT A SWITCH. Both gates ultimately ask
-- my_fair_use()/profiles the same question, and today that question is "is
-- max_books OR max_chapters set at all?" — the VALUE is never read:
--
--   app    src/utils/narration.ts  premiumVoicesFor: f.unlimited === true || …
--   worker worker/process.py ~665  allow_premium = bool(tier_info["paid"])
--                                  (client.py resolve_tier: ANY override ⇒ paid)
--
-- Measured on prod (read-only) the day this was written: 18 profiles carry a
-- comp override, but only 7 sit at 100000 or above. The other 11 are seeded
-- accounts capped at max_books = 20. Flipping the switches as they stand would
-- have handed premium voices to 18 accounts — 11 more than were asked for.
--
-- THE RULE. Premium voices are allowed when the account is on a paid tier
-- (pro, pro_plus, family, homeschool, school) OR carries a comp override of
-- >= 100000 in max_books or max_chapters. A SMALLER override still grants
-- unlimited GENERATION exactly as it does today — it just does not buy the
-- premium voice.
--
-- ONE PLACE FOR THE NUMBER. premium_voices_allowed() below is the only thing
-- in the system that knows the threshold. my_fair_use() calls it (the app
-- reads the `premium_voices` key it now carries); the worker calls the same
-- function over RPC (worker/client.py resolve_tier → tier_info["premium"]).
-- Neither side re-derives it, so neither side can drift.
--
-- `unlimited` IS NOT TOUCHED. It still means "exempt from metering and the
-- caps", it is still true for an override of ANY size, and the 11 small-override
-- accounts keep their unlimited generation. The only new fact in the payload is
-- `premium_voices`.
--
-- BEFORE THIS MIGRATION IS APPLIED both callers degrade to PAID TIERS ONLY —
-- never back to the old rule, which is exactly the over-grant being removed,
-- and never to an exception that fails a lesson. So the deploy may safely land
-- first.
--
-- Idempotent. Requires 0101 (school trial states in my_fair_use).

-- ── 1. The threshold, once ───────────────────────────────────────────────────
-- SECURITY INVOKER on purpose. Its two real callers already have the reach
-- they need — my_fair_use() is SECURITY DEFINER (the definer's rights carry
-- into this call) and the worker holds the service role — so making this
-- DEFINER would only add a way for any signed-in user to ask whether SOMEONE
-- ELSE is comped. plan_tier() inside is DEFINER, as it already is everywhere.

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

  -- Otherwise: a paid plan. Same allow-list the worker's registry calls
  -- PAID_TIERS and the app calls PAID_VOICE_TIERS. trial, promo, school_trial,
  -- school_expired and school_suspended are NOT paid.
  return plan_tier(uid) in ('pro', 'pro_plus', 'family', 'homeschool', 'school');
end;
$function$;

comment on function public.premium_voices_allowed(uuid) is
  '0105: may this account use the premium TTS voices? Paid tier, or a comp '
  'override of at least the threshold held inside this function. The single '
  'source of truth for both the app (via my_fair_use().premium_voices) and '
  'the worker (via RPC).';

-- ── 2. The meter's read carries the answer, in EVERY branch ──────────────────
-- Reproduced from the live prod body (pg_get_functiondef, diffed line by line
-- — identical to 0101's, which is where prod got it, apart from the `0100:`
-- comment tokens the renumbering left behind). The ONLY edits are: the
-- `premium` declaration, the one `premium := premium_voices_allowed(uid)`
-- read, and a `'premium_voices', premium` pair in each of the six returned
-- objects — including the early `unlimited` return and the two locked school
-- branches, which return before the main object. Every branch is covered so
-- the app never has to guess, and every branch gets the SAME answer the worker
-- gets. src/__tests__/premium-voices-migration.test.ts asserts exactly that:
-- strip the additions back out and the body must equal 0101's byte for byte.

create or replace function public.my_fair_use() returns jsonb
  language plpgsql stable security definer set search_path = public as
$function$
declare
  uid uuid := auth.uid();
  tier text;
  caps record;
  c record;
  promo_used int;
  eff_cap int;
  trial_used int;
  trial_end text;
  -- 0105: may this account hear the premium voices? One read, reported below.
  premium boolean;
begin
  if uid is null then
    return null;
  end if;
  tier := plan_tier(uid);
  premium := premium_voices_allowed(uid);

  -- 0101: the school's trial end, as the meter's date. NULL for every school
  -- without a clock, and for everyone outside a school.
  select to_char(s.trial_ends_at at time zone 'UTC', 'YYYY-MM-DD') into trial_end
    from profiles p join schools s on s.id = p.school_id
   where p.id = uid;

  -- 0101: locked states, in the enforcers' order — suspension above the
  -- console override, expiry below it. `locked` is the meter's cue; the zero
  -- bucket keeps the pre-0101 readers rendering something sane.
  if tier = 'school_suspended' then
    return jsonb_build_object(
      'tier', tier, 'unlimited', false, 'locked', true,
      'premium_voices', premium,
      'credits', jsonb_build_object('cap', 0, 'carry', 0, 'used', 0, 'available', 0),
      'granted', 0,
      'trial_ends', trial_end,
      'resets_on', coalesce(trial_end, to_char(now() at time zone 'UTC', 'YYYY-MM-DD'))
    );
  end if;

  if exists (select 1 from profiles p where p.id = uid
             and (p.max_books is not null or p.max_chapters is not null)) then
    return jsonb_build_object('tier', 'unlimited', 'unlimited', true, 'premium_voices', premium);
  end if;

  if tier = 'school_expired' then
    return jsonb_build_object(
      'tier', tier, 'unlimited', false, 'locked', true,
      'premium_voices', premium,
      'credits', jsonb_build_object('cap', 0, 'carry', 0, 'used', 0, 'available', 0),
      'granted', 0,
      'trial_ends', trial_end,
      'resets_on', coalesce(trial_end, to_char(now() at time zone 'UTC', 'YYYY-MM-DD'))
    );
  end if;

  select * into caps from fair_use_caps(tier);

  if caps.parts_cap >= 2147483647 then
    eff_cap := caps.parts_cap;
  else
    eff_cap := caps.parts_cap + fair_use_granted(uid);
  end if;

  if tier = 'promo' then
    promo_used := fair_use_used(uid, 'credits', promo_credit_from());
    return jsonb_build_object(
      'tier', 'promo',
      'premium_voices', premium,
      'unlimited', false,
      'promo', true,
      'credits', jsonb_build_object('cap', eff_cap, 'carry', 0, 'used', promo_used,
                                    'available', greatest(0, eff_cap - promo_used)),
      'granted', fair_use_granted(uid),
      'resets_on', to_char(promo_ends_at() at time zone 'UTC', 'YYYY-MM-DD'),
      'trial_ends', to_char(promo_ends_at() at time zone 'UTC', 'YYYY-MM-DD')
    );
  end if;

  -- 0101: the school trial reads like promo did — a period budget with an end
  -- date — under its own flag so the meter can word the next step honestly
  -- ("ask us to activate", not "subscribe").
  if tier = 'school_trial' then
    trial_used := fair_use_used_since(uid, school_trial_anchor(uid));
    return jsonb_build_object(
      'tier', 'school_trial',
      'premium_voices', premium,
      'unlimited', false,
      'school_trial', true,
      'credits', jsonb_build_object('cap', eff_cap, 'carry', 0, 'used', trial_used,
                                    'available', greatest(0, eff_cap - trial_used)),
      'granted', fair_use_granted(uid),
      'resets_on', trial_end,
      'trial_ends', trial_end
    );
  end if;

  select * into c from fair_use_avail(uid, 'credits', eff_cap);
  return jsonb_build_object(
    'tier', tier,
    'premium_voices', premium,
    'unlimited', eff_cap >= 2147483647,
    'credits', jsonb_build_object('cap', eff_cap, 'carry', c.carry, 'used', c.used,
                                  'available', greatest(0, c.available)),
    -- 'available' deliberately: src/app/dashboard/fair-use-meter.tsx already
    -- reads fu.purchased.available (and tolerates a bare number).
    'granted', fair_use_granted(uid),
    'purchased', jsonb_build_object('available', fair_use_purchased_remaining(uid)),
    'resets_on', to_char(date_trunc('month', now()) + interval '1 month', 'YYYY-MM-DD')
  );
end;
$function$;
