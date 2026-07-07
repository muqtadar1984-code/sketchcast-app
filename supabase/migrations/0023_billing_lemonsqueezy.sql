-- 0023 — Second billing provider: Lemon Squeezy (Merchant of Record) for the
-- B2C plans (Teacher Pro, Teacher Pro+, Family — USD, monthly or annual).
-- Stripe stays the direct merchant for school plans (MYR). The app still gates
-- access ONLY on the provider-agnostic `entitlements` table; this migration
-- lets both providers write to the same billing tables AND supports buying
-- from the public pricing page (no logged-in user at checkout — see the
-- email-identity + claim section at the bottom).
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
-- FULL (non-partial) unique index: PostgREST/supabase-js `.upsert({onConflict})`
-- emits `ON CONFLICT (col)` with NO predicate, and Postgres refuses to use a
-- PARTIAL index as the arbiter (SQLSTATE 42P10). Nullable column still allows
-- many NULLs (Stripe rows have ls_customer_id = NULL), so a full unique is safe.
drop index if exists public.billing_customers_ls_customer_uq;
create unique index if not exists billing_customers_ls_customer_uq on public.billing_customers (ls_customer_id);

-- ── subscriptions: LS subscription id alongside Stripe's ─────────────────────
alter table public.subscriptions alter column stripe_subscription_id drop not null;
alter table public.subscriptions add column if not exists ls_subscription_id text;
-- FULL unique (see billing_customers_ls_customer_uq note) so the webhook's
-- upsert onConflict "ls_subscription_id" can infer it as the arbiter.
drop index if exists public.subscriptions_ls_uq;
create unique index if not exists subscriptions_ls_uq on public.subscriptions (ls_subscription_id);
-- The provider's own updated_at, so an OUT-OF-ORDER webhook (a stale
-- "active" arriving after "expired") can be detected and skipped. LS has no
-- live-state re-fetch in the handler, so this is the monotonicity gate.
alter table public.subscriptions add column if not exists provider_updated_at timestamptz;

-- ── payments: LS order id + USD is now a valid currency ──────────────────────
alter table public.payments alter column stripe_payment_intent_id drop not null;
alter table public.payments add column if not exists ls_order_id text;
-- FULL unique (see note above) for the same arbiter-inference reason.
drop index if exists public.payments_ls_order_uq;
create unique index if not exists payments_ls_order_uq on public.payments (ls_order_id);
-- Stripe path stays MYR (asserted in code); LS (MoR) settles USD. Widen the
-- CHECK to the two currencies we actually use.
alter table public.payments drop constraint if exists payments_currency_check;
alter table public.payments add constraint payments_currency_check check (currency in ('myr','usd'));

-- entitlements keying (user_id, plan_key) is unchanged — each plan maps to
-- exactly one provider, so there is no cross-provider conflict. RLS from 0022
-- (read-own + school-admin on school rows) is provider-agnostic and needs no
-- change: personal LS plans carry school_id = NULL, so they stay invisible to
-- a school admin, exactly like personal Stripe plans.

-- ═══════════════════════════════════════════════════════════════════════════
-- Public-link (MoR) purchases: email-based identity + claim-on-sign-in
-- ═══════════════════════════════════════════════════════════════════════════
-- The public marketing pricing page links STRAIGHT to LS hosted checkout, so a
-- subscription webhook can arrive with NO app user_id (we did not create the
-- checkout) and the buyer may not even have an account yet. The only identity
-- signal is the buyer's LS email. So:
--   * store that email on billing_customers;
--   * allow an UNCLAIMED customer/subscription row (user_id NULL) parked by the
--     buyer's email until someone signs in with a matching (Supabase-verified)
--     email and claims it;
--   * we NEVER auto-bind a paid subscription onto a pre-existing account from
--     the inbound webhook — a buyer can type any email at LS, so binding happens
--     only once the account holder is authenticated (claim-on-sign-in);
--   * entitlements are created ONLY when a real user_id is known (an
--     authenticated in-app purchase, or at claim time), so an unclaimed sub
--     grants NO access. RLS (user_id = auth.uid()) already hides null-user_id
--     rows from every client — exactly what we want.

-- billing_customers: store the LS email; allow an unclaimed (no user_id) row.
alter table public.billing_customers add column if not exists email text;
create index if not exists billing_customers_email_idx
  on public.billing_customers (lower(email)) where email is not null;
alter table public.billing_customers alter column user_id drop not null;
-- Uniqueness model per provider:
--   * Stripe: one customer per user — keep (user_id, provider) unique.
--   * Lemon Squeezy: a user may own SEVERAL ls_customer_ids (LS mints a fresh
--     customer per logged-out hosted-checkout session), and rows dedupe on
--     ls_customer_id (full unique above). So the (user_id, provider) unique must
--     NOT apply to LS, or a second LS purchase (or claiming two parked subs)
--     would hit a spurious unique violation and wedge the webhook/claim.
drop index if exists public.billing_customers_user_provider_uq;
create unique index if not exists billing_customers_user_provider_uq
  on public.billing_customers (user_id, provider) where user_id is not null and provider = 'stripe';

-- subscriptions: allow an unclaimed sub parked by email, and flag the founding
-- cohort (Teacher Pro bought with the FOUNDINGTEACHER discount — price-locked
-- for 24 months, worth tracking, but the same ACCESS level as Teacher Pro).
alter table public.subscriptions alter column user_id drop not null;
alter table public.subscriptions add column if not exists claim_email text;
alter table public.subscriptions add column if not exists is_founding boolean not null default false;
create index if not exists subscriptions_claim_email_idx
  on public.subscriptions (lower(claim_email)) where claim_email is not null and user_id is null;

-- entitlements: intentionally UNCHANGED — user_id stays NOT NULL. An entitlement
-- (the access grant) is only ever written for a known user, so there is no
-- unclaimed entitlement to hide; unclaimed access lives as a parked subscription
-- and becomes an entitlement at claim time.
