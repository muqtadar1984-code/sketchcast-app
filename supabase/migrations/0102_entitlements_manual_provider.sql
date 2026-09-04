-- 0102 — an entitlement may be granted by hand.
--
-- APPLIED TO PROD 2026-09-03 under the history name `0101_entitlements_manual_provider`.
-- Renumbered to 0102 in the repo the next day, together with 0101 (see its header).
--
-- WHY. Most schools pay by bank transfer against a direct invoice, outside
-- Stripe entirely (BILLING.md). Until now the only way to turn such a school on
-- was a hand-written entitlements row wearing provider='stripe' — a lie the
-- financials would one day trip over. The console's school_activate action
-- (0101, Phase 2) writes that row; it needs an honest provider value.
--
-- HOW. Widen the CHECK. Nothing reads provider to decide ACCESS — plan_tier()
-- keys on active + plan_key + period end — and the Stripe webhook's upsert on
-- (user_id, plan_key) overwrites provider='manual' with 'stripe' the moment the
-- same school pays through Stripe, which is the natural hand-off.
-- billing_customers is untouched: a manual activation has no Stripe customer.
--
-- Idempotent: drop-if-exists + add.

alter table public.entitlements drop constraint if exists entitlements_provider_chk;
alter table public.entitlements
  add constraint entitlements_provider_chk check (provider in ('stripe', 'lemonsqueezy', 'manual'));
