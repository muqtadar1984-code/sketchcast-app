-- 0049 — Family plan trim: hold $9.99, size the allowance to the margin rule.
--
-- Pricing decision (2026-07-17): Family keeps its $9.99/mo price point (the
-- consumer entry matters more than the extra $2), and the allowance is trimmed
-- so the ≥50% gross-margin rule holds at the ceiling:
--
--   family: 10 parts / 30 docs  →  8 parts / 24 docs   (books 2, children 2)
--
-- ~$1.25 per lesson part — the same rate card as Teacher Pro ($1.20), half…
-- rather, 40% of the allowance, plus the family features. Every other tier is
-- unchanged; this re-states fair_use_caps in full because it is the ONE place
-- cap policy lives (0047).
--
-- Idempotent (function replace). Requires 0047.

create or replace function public.fair_use_caps(tier text)
returns table (parts_cap int, docs_cap int, books_cap int)
  language sql immutable as
$$
  -- Explicit column list: the declared return type has THREE columns, so the
  -- tier key must not leak into the projection (42P13 at CREATE otherwise).
  select t.parts_cap, t.docs_cap, t.books_cap from (values
    ('trial',    20,  40,  2147483647),  -- books bounded by the 0046 lifetime ledger
    ('pro',      20,  40,  2),
    ('pro_plus', 40,  80,  4),
    ('family',    8,  24,  2),
    ('school',   2147483647, 2147483647, 2147483647)
  ) as t(k, parts_cap, docs_cap, books_cap)
  where t.k = coalesce(tier, 'trial');
$$;
