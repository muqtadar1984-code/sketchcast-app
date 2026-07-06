-- 0022 — Stripe billing (Aethel Twin Sdn. Bhd., MYR, adult-only).
--
-- Stores Stripe IDs and status ONLY — no card numbers, CVVs, or PANs ever
-- reach our database (hosted Checkout + Billing Portal keep us out of
-- PCI-DSS scope). "Tenant" in this codebase = schools; independent teachers/
-- parents have school_id NULL, so billing rows carry a NULLABLE school_id and
-- key uniqueness on the user. Writes happen ONLY via the server (service
-- role) in the checkout/webhook handlers: no client role has any write path.
-- Students have no access to any billing table.
--
-- Run in the Supabase SQL editor as ONE execution. Idempotent. Inert while
-- BILLING_ENABLED=false.

-- Per-school opt-out (global BILLING_ENABLED env is the master switch).
alter table public.schools add column if not exists billing_enabled boolean;

-- ── Stripe customer mapping ───────────────────────────────────────────────────
create table if not exists public.billing_customers (
  id                 uuid primary key default gen_random_uuid(),
  school_id          uuid references public.schools(id) on delete set null,
  user_id            uuid not null references public.profiles(id) on delete cascade,
  stripe_customer_id text not null unique,
  role               text not null,   -- teacher | parent | school_admin | coordinator (snapshot)
  created_at         timestamptz not null default now(),
  unique (user_id)
);

-- ── Subscriptions (status mirror; Stripe is upstream, entitlements downstream)
create table if not exists public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  school_id              uuid references public.schools(id) on delete set null,
  user_id                uuid not null references public.profiles(id) on delete cascade,
  stripe_subscription_id text not null unique,
  plan_key               text,
  status                 text not null,   -- active | trialing | past_due | canceled | unpaid | …
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists subscriptions_user_idx on public.subscriptions (user_id);

-- ── One-off payments (records only — never card data) ────────────────────────
create table if not exists public.payments (
  id                       uuid primary key default gen_random_uuid(),
  school_id                uuid references public.schools(id) on delete set null,
  user_id                  uuid not null references public.profiles(id) on delete cascade,
  stripe_payment_intent_id text not null unique,
  amount                   integer not null,          -- minor units (sen)
  currency                 text not null check (currency = 'myr'),
  plan_key                 text,
  status                   text not null,
  created_at               timestamptz not null default now()
);
create index if not exists payments_user_idx on public.payments (user_id);

-- ── Entitlements: THE single source of truth for paid access ─────────────────
-- Keyed per (user, plan) — one adult may legitimately hold two concurrent
-- plans (e.g. a school_admin who also buys parent_monthly for their child), so
-- a single per-user row would let one plan's webhook clobber the other's.
-- school_id is the school the PLAN applies to: NULL for personal plans
-- (teacher/parent), the school for school_* plans. That keeps personal
-- purchases invisible to a school admin (the admin read clause matches only
-- non-null school_id).
create table if not exists public.entitlements (
  id                 uuid primary key default gen_random_uuid(),
  school_id          uuid references public.schools(id) on delete set null,
  user_id            uuid not null references public.profiles(id) on delete cascade,
  active             boolean not null default false,
  plan_key           text not null,
  status             text,
  current_period_end timestamptz,
  updated_at         timestamptz not null default now(),
  unique (user_id, plan_key)
);
create index if not exists entitlements_school_idx on public.entitlements (school_id);
create index if not exists entitlements_user_idx   on public.entitlements (user_id);

-- ── Webhook idempotency ledger (service-role only) ────────────────────────────
-- processed_at distinguishes "claimed but not yet finished" (a crash between
-- claim and completion) from "fully processed" — a Stripe retry that hits an
-- UNfinished claim reprocesses instead of being falsely acked as a duplicate.
create table if not exists public.webhook_events (
  id           text primary key,       -- Stripe event id — unique = dedupe
  type         text not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);

-- ── RLS: read-own, write-nothing (server/service role does all writes) ───────
alter table public.billing_customers enable row level security;
alter table public.subscriptions     enable row level security;
alter table public.payments          enable row level security;
alter table public.entitlements      enable row level security;
alter table public.webhook_events    enable row level security;   -- no policies at all

-- billing_customers is OWNER-ONLY: an admin has no need to see who holds a
-- Stripe customer mapping. The money tables (subscriptions/payments/
-- entitlements) additionally let a school_admin read rows attached to THEIR
-- school — and because personal-plan rows carry school_id = NULL, that clause
-- only ever matches school_* purchases, never a teacher's personal one.
-- current_role_val() blocks students at the policy level regardless.
do $$
declare t text;
begin
  -- Owner-only read for every billing table…
  foreach t in array array['billing_customers','subscriptions','payments','entitlements']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_read_own', t);
    execute format(
      'create policy %I on public.%I for select using (
         current_role_val() <> ''student'' and user_id = auth.uid())',
      t || '_read_own', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_not_suspended', t);
    execute format(
      'create policy %I on public.%I as restrictive for all using (not current_user_suspended())',
      t || '_not_suspended', t);
  end loop;

  -- …plus a school-admin read on the money tables, scoped to school rows only.
  foreach t in array array['subscriptions','payments','entitlements']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_read_school', t);
    execute format(
      'create policy %I on public.%I for select using (
         current_role_val() = ''school_admin''
         and school_id is not null and school_id = current_school_id())',
      t || '_read_school', t);
  end loop;
end $$;

revoke all on public.webhook_events from anon, authenticated;
