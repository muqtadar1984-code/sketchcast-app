-- 0107_seven_piece_kit_allowances
--
-- Raises every generation allowance by 7/6, because a kit now ships SEVEN
-- pieces instead of six.
--
-- WHAT IT DOES
--   Restates public.fair_use_caps in full — the ONE place the allowances live
--   (the house rule from 0049) — with parts_cap multiplied by 7/6:
--     trial         6 ->  7      promo        24 -> 28
--     pro          24 -> 28      pro_plus     72 -> 84
--     family       12 -> 14      homeschool   48 -> 56
--     school_trial 12 -> 14
--   docs_cap and books_cap are untouched on every row, and so are the three
--   rows that carry no real number: 'school' keeps its 2147483647 sentinel,
--   'school_expired' and 'school_suspended' keep their zeros.
--
--   Nothing else in the schema changes. fair_use_used, fair_use_used_since
--   and credit_ledger_write are NOT redefined here.
--
-- WHY THE KIT COUNTS IN THE ROW COMMENTS DID NOT MOVE
--   Every old cap divided exactly by 6 and every new cap divides exactly by 7,
--   to the same quotient — 7/7=1, 28/7=4, 84/7=12, 14/7=2, 56/7=8 — so the
--   "1 kit" / "4 kits" / "12 kits" / "2 kits" / "8 kits" comments below are
--   still true word for word, and the kit counts advertised on the pricing
--   page do not change either. Only the generation numbers move.
--
-- WHY 'school' IS NOT SCALED
--   It is a sentinel meaning "no limit", not a quantity. 2147483647 * 7 / 6 is
--   2505397588, which does not fit in the integer the function returns — the
--   column would overflow. Unlimited stays unlimited.
--
-- THE DECK STAYS FREE — THIS FILE DOES NOT CHARGE FOR THE SEVENTH PIECE
--   0103 added the 'deck' kind and deliberately left it out of fair_use_used,
--   fair_use_used_since and credit_ledger_write, so a kit is 7 generations but
--   only 6 credits. That is unchanged and must stay unchanged: adding 'deck'
--   to any of those three would silently make a kit cost 7 and make every
--   existing user worse off. The effect of this file is therefore that each
--   plan delivers slightly MORE than the page advertises (a Teacher Pro month
--   buys 4 kits for 24 credits out of 28), which is the intended direction —
--   under-promise, over-deliver.
--
-- WHY IT IS SAFE ON THE LIVE POPULATION (measured read-only 2026-09-05: 160
-- accounts — 159 resolving to tier 'trial' and 1 to 'family', that one a
-- lemonsqueezy family_monthly already cancelled but paid through 2026-09-20;
-- no pro, pro_plus, promo, homeschool, school or school_trial account exists)
--   * `create or replace function` on an existing IMMUTABLE sql function.
--     Signature, return type, volatility and name are byte-identical to what
--     is running, so no dependent view, policy or trigger is invalidated and
--     nothing needs re-granting. Re-running the file is a no-op.
--   * No table is read or written. No DDL on any relation. There is no data
--     to migrate and no lock taken on anything a user touches.
--   * Every parts_cap moves strictly UP, so no account can be pushed over its
--     cap by this change. An account mid-period simply gains headroom; the one
--     cancelled family subscriber goes from 12 to 14 for the remainder of a
--     period already paid for. Nobody is made worse off, so it is safe to
--     apply at any moment in the billing month.
--   * The two locked school states stay at 0 and the enforcers still hard-stop
--     before those zeros are read, so no lockout behaviour changes.
--
-- DOWN
--   Re-apply the previous body verbatim — restore parts_cap to
--   trial 6, promo 24, pro 24, pro_plus 72, family 12, homeschool 48,
--   school_trial 12, leaving school/expired/suspended as they are here:
--
--   create or replace function public.fair_use_caps(tier text)
--   returns table(parts_cap integer, docs_cap integer, books_cap integer)
--   language sql immutable as
--   $function$
--     select t.parts_cap, t.docs_cap, t.books_cap from (values
--       ('trial',      6, 0, 2147483647),
--       ('promo',     24, 0, 2),
--       ('pro',       24, 0, 2),
--       ('pro_plus',  72, 0, 4),
--       ('family',    12, 0, 2),
--       ('homeschool',48, 0, 4),
--       ('school',    2147483647, 2147483647, 2147483647),
--       ('school_trial',     12, 0, 2),
--       ('school_expired',    0, 0, 0),
--       ('school_suspended',  0, 0, 0)
--     ) as t(k, parts_cap, docs_cap, books_cap)
--     where t.k = coalesce(tier, 'trial');
--   $function$;
--
--   (Reverting only lowers the ceiling. An account that spent more than the
--   old cap during the window keeps what it generated — the ledger is the
--   record of what was delivered — and is simply over its cap until the
--   period rolls, which the enforcers already handle.)
--
-- ORDER OF OPERATIONS — APPLY THIS BEFORE THE MARKETING SITE SHIPS
--   The sketchcast-landing branch that goes with this change prints the NEW
--   numbers: "28 generations a month", "84 a month", "14", "56", and a free
--   tier of one complete kit. That repo has no CI and deploys on push to main,
--   so those pages are live the moment the branch merges, while these caps move
--   only when a human runs this file. Merge in that window and a visitor reads
--   28 on the pricing page while the enforcer still stops them at 24.
--
--   So: apply this file FIRST, confirm with
--     select * from public.fair_use_caps('pro');   -- expect 28
--   and merge the landing branch after. Reverting is the mirror image — take
--   the site's numbers down before running the DOWN block above.
--
--   The app repo needs no such ordering: it reads every cap from this function
--   at request time and never hardcodes one. The one app-side constant that
--   repeats these numbers, PLAN_GENERATION_CAPS in src/utils/financials.ts, is
--   a console-only cost model, and src/utils/__tests__/migration-0107-caps.test.ts
--   fails if it and this file ever disagree.
--
-- NUMBERING
--   0106_visual_assets_vision is the newest migration applied to prod (checked
--   read-only 2026-09-05: supabase_migrations 20260905090127). 0104 and 0106
--   live in the WORKER repo's database/ directory and 0105 in this one on an
--   unmerged branch, so this directory jumps 0103 -> 0107; the number is a
--   shared namespace across both repos, not a per-directory sequence. Nothing
--   inside this file depends on its number.
--
-- NOT APPLIED BY ANY AGENT. The founder applies prod schema changes.

begin;

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

commit;
