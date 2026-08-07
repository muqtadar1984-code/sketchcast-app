-- 0077 — Extend the launch free trial by one week, and RESET the allowance.
--
-- The clock is the visible half and the smaller one. The promo allowance (24
-- generations, 2 books) is a PERIOD TOTAL counted from promo_credit_from(), not
-- a monthly reset — so moving only the end date would have given the people
-- actually using the trial nothing at all. At the moment of writing, both real
-- teachers on the promo were at or past the ceiling:
--
--   gmouni6891@gmail.com      26 of 24  — blocked outright
--   sharonyohannan@gmail.com  19 of 24  — 5 left, and a kit costs 6
--
-- Everyone else on the promo is at zero, and most of those are demo or student
-- accounts. So a clock-only extension would have been cosmetic for 100% of the
-- teachers it was meant to help.
--
-- Founder's call: reset the counter. Move the anchor to the moment the extension
-- was applied, so the extra week starts everyone fresh — a full 24 generations
-- and 2 books. Simple to explain, and at this scale the cost is noise (two
-- active teachers; ~$15 if both spend the lot).
--
-- WHY THE ANCHOR ALSO MOVES THE BOOK CAP: promo_credit_from() gates
-- enforce_beta_book_cap as well as enforce_fair_use. Resetting it hands back 2
-- book uploads alongside the generations. That is intended, not a side effect —
-- three trialists had used 1 of their 2.
--
-- The anchor is 13:00 UTC (21:00 Malaysia) on 7 August, minutes after this was
-- applied and a few hours before the original trial would have expired at
-- 23:59:59+08. Usage in that short gap is not counted, which errs toward the
-- trialist — the direction we chose deliberately.
--
-- Nothing else in the app hardcodes these dates: the in-app "trial ends {date}"
-- label reads my_fair_use(), which reads promo_ends_at(). The marketing site's
-- banner, countdown and checkout-bypass all read trial.endsAt from
-- pricing.config.js in the landing repo, which moves in the same change.

-- The trial now runs to the end of 14 August, Malaysia time.
create or replace function public.promo_ends_at()
returns timestamptz
language sql
immutable
as $$ select timestamptz '2026-08-14 23:59:59+08' $$;

-- Everyone's promo usage counts from here. Was '2026-07-19 00:00:00+00'.
create or replace function public.promo_credit_from()
returns timestamptz
language sql
immutable
as $$ select timestamptz '2026-08-07 13:00:00+00' $$;
