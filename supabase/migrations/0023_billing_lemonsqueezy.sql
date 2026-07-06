-- 0023 — Second billing provider: Lemon Squeezy (Merchant of Record) for the
-- B2C plans (parent_monthly, teacher_monthly), USD. Stripe stays the direct
-- merchant for school plans (MYR). The app still gates access ONLY on the
-- provider-agnostic `entitlements` table; this migration just lets both
-- providers write to the same billing tables.
--
-- Under MoR, Lemon Squeezy is the seller of record for parent/teacher sales
-- (handles global VAT/GST/sales tax, appears on statements, pays Aethel Twin a
-- payout). Card data still never touches us (LS hosted checkout).
--
-- Additive + idempotent. Run as ONE execution. Inert while BILLING_ENABLED is
-- off / no LS keys are set.

-- ── provider discriminator on every billing table ────────────────────────────
alter table public.billing_customers add column if not exists provider text not null default 'stripe';
alter table public.subscriptions     add column if not exists provider text not null default 'stripe';
alter table public.payments          add column if not exists provider text not null default 'stripe';
alter table public.entitlements      add column if not exists provider text not null default 'stripe';

do $$ begin
  -- constrain provider to the two we support
  if not exists (select 1 from pg_constraint where conname = 'billing_customers_provider_chk') then
    alter table public.billing_customers add constraint billing_customers_provider_chk check (provider in ('stripe','lemonsqueezy'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'subscriptions_provider_chk') then
    alter table public.subscriptions add constraint subscriptions_provider_chk check (provider in ('stripe','lemonsqueezy'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payments_provider_chk') then
    alter table public.payments add constraint payments_provider_chk check (provider in ('stripe','lemonsqueezy'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'entitlements_provider_chk') then
    alter table public.entitlements add constraint entitlements_provider_chk check (provider in ('stripe','lemonsqueezy'));
  end if;
end $$;

-- ── billing_customers: allow a Lemon Squeezy customer alongside Stripe ────────
-- A single adult can be a customer in BOTH providers (a school_admin who buys a
-- school plan via Stripe AND a parent plan via LS), so uniqueness moves to
-- (user_id, provider). Stripe customer id becomes nullable for LS rows.
alter table public.billing_customers alter column stripe_customer_id drop not null;
alter table public.billing_customers add column if not exists ls_customer_id text;
alter table public.billing_customers add column if not exists ls_customer_portal_url text;
alter table public.billing_customers drop constraint if exists billing_customers_user_id_key;
create unique index if not exists billing_customers_user_provider_uq on public.billing_customers (user_id, provider);
create unique index if not exists billing_customers_ls_customer_uq on public.billing_customers (ls_customer_id) where ls_customer_id is not null;

-- ── subscriptions: LS subscription id alongside Stripe's ─────────────────────
alter table public.subscriptions alter column stripe_subscription_id drop not null;
alter table public.subscriptions add column if not exists ls_subscription_id text;
create unique index if not exists subscriptions_ls_uq on public.subscriptions (ls_subscription_id) where ls_subscription_id is not null;
-- The provider's own updated_at, so an OUT-OF-ORDER webhook (a stale
-- "active" arriving after "expired") can be detected and skipped. LS has no
-- live-state re-fetch in the handler, so this is the monotonicity gate.
alter table public.subscriptions add column if not exists provider_updated_at timestamptz;

-- ── payments: LS order id + USD is now a valid currency ──────────────────────
alter table public.payments alter column stripe_payment_intent_id drop not null;
alter table public.payments add column if not exists ls_order_id text;
create unique index if not exists payments_ls_order_uq on public.payments (ls_order_id) where ls_order_id is not null;
-- Stripe path stays MYR (asserted in code); LS (MoR) settles USD. Widen the
-- CHECK to the two currencies we actually use.
alter table public.payments drop constraint if exists payments_currency_check;
alter table public.payments add constraint payments_currency_check check (currency in ('myr','usd'));

-- entitlements keying (user_id, plan_key) is unchanged — each plan maps to
-- exactly one provider, so there is no cross-provider conflict. RLS from 0022
-- (read-own + school-admin on school rows) is provider-agnostic and needs no
-- change: personal LS plans carry school_id = NULL, so they stay invisible to
-- a school admin, exactly like personal Stripe plans.
