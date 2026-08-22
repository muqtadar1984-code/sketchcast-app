-- 0093 — Subscription revenue: the half of "Collected to date" that has never
-- existed, plus the durable record that makes it possible to record at all.
--
-- THE HOLE (verified against the live LS store and prod on 2026-08-20). 0092
-- repaired the credit packs. It did not touch subscriptions, and subscriptions
-- were never recorded at all — not once, not for anybody:
--   · A subscription's INITIAL order does reach handleLsOrderEvent, but
--     packForOrderItem() returns null for it, so the handler logs
--     `order_ignored_not_pack` and returns. No payments row, ever.
--   · A RENEWAL never reaches that handler at all. LS's documented lifecycle
--     sends `subscription_payment_success` + `subscription_updated` for a
--     successful renewal and NO order_created — and the payment event is
--     invoice-shaped (data.type = "subscription-invoices"), which handlers.ts
--     correctly refuses to read as a subscription lifecycle object.
-- Live proof of both: order 9261749 (SketchCast Home Basic / Monthly, $11.79
-- collected) has zero payments rows, while public.payments holds four rows —
-- every one of them a credit pack.
--
-- WHY THE MONEY IS TAKEN FROM THE INVOICE AND NEVER FROM THE ORDER. The
-- initial charge is represented BOTH ways: order 9261749 and invoice 8235804
-- are the same $11.79, field for field (subtotal 999, tax 180, total 1179,
-- USD), and LS files that invoice under that order's own identifier. Renewals
-- go the other way: an invoice and no order. So there is exactly one rule that
-- neither double-counts nor gaps:
--
--     SUBSCRIPTION REVENUE COMES FROM THE INVOICE. ALWAYS. ONLY.
--
-- for every billing_reason ('initial', 'renewal', 'updated'), and order_created
-- keeps ignoring subscription orders exactly as it does today. That is the
-- invariant this migration and the code that lands with it exist to protect.
-- Deliberately absent below, for the same reason: a `subscriptions.ls_order_id`
-- column. LS already sends that id (handlers.ts receives it and passes it to
-- detectFounding) and storing it would be one line — but the only thing it
-- could enable is booking the order, which is precisely the double count. Not
-- storing it is the cheapest possible guard.
--
-- WHAT COUNTS AS REVENUE: NET OF TAX (founder's decision, 2026-08-22). Lemon
-- Squeezy is Merchant of Record. On the first real sale it added $1.80 IGST
-- (18%, Indian buyer) on top of a $9.99 list price and remits that $1.80
-- itself; the business never keeps it, so it is not revenue and must not reach
-- "Collected to date". Both writers therefore book
--
--     subtotal - discount_total          (NOT total, and NOT bare subtotal)
--
-- in MINOR UNITS. An LS order and an LS subscription invoice each carry all
-- four money fields separately, so nothing has to be derived:
--     invoice 8235804   subtotal 999 · tax 180 · total 1179  → book  999
--     order   9261766   subtotal 800 · tax 144 · total  944  → book  800
--     a FOUNDINGTEACHER order ($14 off $24)                  → book 1000
-- The middle line is why bare `subtotal` is wrong as often as `total` is:
-- subtotal is BEFORE any discount, so it would report $24 for a $10 sale.
--
-- THE TAX NUMBER IS DISCARDED, NOT PERSISTED. The founder chose that over
-- storing both figures, so there is no tax column here, none on
-- credit_purchases, and none to add later — which is exactly why section 4
-- cannot simply subtract the tax back out of the rows already booked gross, and
-- has to identify them by other evidence instead.
--
-- APPLY THIS BEFORE DEPLOYING THE APP, exactly as 0092 said. The webhook's new
-- invoice branch writes public.subscription_invoices (created below) and
-- payments.ls_invoice_id (added below). Shipping the code first is survivable
-- and, unlike 0092's case, loud rather than silent: an invoice event grants no
-- access and no credits, so the handler is free to fail the delivery, LS marks
-- it red, and a resend after this migration lands recovers it in full.
--
-- ── THE RUNBOOK, IN ORDER. Section 6 is the reason this is three steps and not
-- two, and skipping step 3 costs real money:
--   1. APPLY THIS MIGRATION.
--   2. DEPLOY THE APP.
--   3. RE-RUN THIS MIGRATION (or just its final DELETE — see section 6), and
--      only THEN click "resend" in the Lemon Squeezy dashboard.
-- Step 3 exists because section 6 releases webhook_events idempotency claims,
-- and between step 1 and step 2 the OLD handler is still serving the endpoint:
-- any subscription_payment_* event delivered in that window is dropped by the
-- old code, which returns 200, which re-stamps processed_at on the very key
-- section 6 just released. A later resend of that payload then hits the route's
-- duplicate short-circuit and is waved through — a green delivery in LS and no
-- row written, exactly the silent success section 6 exists to prevent, and the
-- amount lives nowhere else. Steps 2 and 3 in that order close the window.
-- Everything else in this file is inert on a second run, by construction.
--
-- NOTHING HERE GRANTS OR REVOKES ACCESS. No entitlement, no credit balance, no
-- cap is touched. This is bookkeeping only.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. An idempotency key for invoices that CANNOT collide with an order id
-- ═══════════════════════════════════════════════════════════════════════════
-- The obvious shortcut — put the invoice id in payments.ls_order_id and reuse
-- payments_ls_order_uq (0023) — is a live data-loss bug, not a style question.
-- LS order ids and subscription-invoice ids are two INDEPENDENT global integer
-- sequences sharing one numeric space. Read from this store today: invoice id
-- 8235804 against order ids 9251234 / 9251647 / 9251763 / 9261749 / 9261766.
-- The invoice counter trails the order counter by ~1M and advances far more
-- slowly (invoices exist only for subscription payments), so it will in time
-- pass through values the order counter has ALREADY used. A future invoice
-- numbered 9261749 would collide with today's real order 9261749, and because
-- every writer treats 23505 as "already recorded", it would swallow a genuine
-- sale as a duplicate — silently, with no error anywhere.
--
-- So: its own column, its own unique index, its own namespace. A FULL unique
-- index (not partial) for the same reason 0023 gave — a full index is
-- INFERRABLE as an ON CONFLICT arbiter, which is what lets the backfill below
-- and the app's inserts name it. Postgres treats NULLs as DISTINCT, so every
-- existing pack row and every Stripe row keeps a NULL here and is unaffected.
alter table public.payments add column if not exists ls_invoice_id text;
drop index if exists public.payments_ls_invoice_uq;
create unique index if not exists payments_ls_invoice_uq on public.payments (ls_invoice_id);

comment on column public.payments.ls_invoice_id is
  'Lemon Squeezy SUBSCRIPTION-INVOICE id (data.id of a subscription_payment_* webhook). The idempotency key for subscription revenue. Deliberately NOT ls_order_id: LS order ids and invoice ids are separate sequences in the same numeric space and will eventually collide. Exactly one of ls_order_id (packs) / ls_invoice_id (subscriptions) / stripe_payment_intent_id (schools) is set on any row.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. subscription_invoices — the durable record subscriptions never had
-- ═══════════════════════════════════════════════════════════════════════════
-- THIS TABLE IS THE REASON THE FIX IS POSSIBLE, and its absence is the reason
-- section 3 cannot repair the sale already collected. payments.user_id is NOT
-- NULL, so a public-link purchase made while logged out has no owner at webhook
-- time and its revenue row must WAIT for the buyer to sign in and claim it —
-- the same two-sided shape packs have. For packs the money survives that wait
-- in credit_purchases (0086 + 0092's three money columns). Subscriptions had
-- nowhere: public.subscriptions carries no amount, no currency, no tax and no
-- order id, and webhook_events stores only an id, a type and two timestamps —
-- never the payload. An LS subscription's collected amount has therefore never
-- been persisted by this application anywhere, at any point.
--
-- So this is credit_purchases' mirror for subscriptions: one row per LS
-- invoice, parked by email when the buyer is unknown, bound by claim.ts when
-- they sign in, and carrying the money facts BOTH writers price from — the
-- single definition of "the amount" that 0092's comments were written to
-- protect. It is also where a refund's durable fact lives (refunded_at), which
-- is what lets a refund that lands while the sale is still parked stop the
-- claim from ever booking it as collected.
--
-- One row per invoice, and a renewal is a NEW invoice — so this table grows one
-- row per subscriber per billing period, which is exactly the granularity
-- "Collected to date" needs and the granularity public.subscriptions (one row
-- per subscription, overwritten in place) can never provide.
create table if not exists public.subscription_invoices (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid references auth.users(id) on delete cascade, -- NULL while parked
  claim_email        text,           -- set only while parked (public-link buy) — claim.ts binds it
  provider           text not null default 'lemonsqueezy',
  ls_invoice_id      text unique,    -- LS's own id; the idempotency key for every writer
  ls_subscription_id text,           -- the subscription it belongs to (and the plan_key source)
  plan_key           text,           -- resolved from public.subscriptions AT WRITE TIME (see below)
  billing_reason     text,           -- 'initial' | 'renewal' | 'updated' (LS's enum)
  total_minor        int,            -- what the business CHARGED, NET OF TAX (subtotal - discount_total) — never LS's `total`; see the column comment
  total_currency     text,           -- lower-cased, as LS reported it
  total_usd_minor    int,            -- LS's own USD conversion, netted the same way (subtotal_usd - discount_total_usd) — never attributes.total_usd
  invoice_status     text,           -- 'pending' | 'paid' | 'void' | 'refunded' | 'partial_refund'
  test_mode          boolean,        -- LS test_mode — a test charge is not money
  refunded_at        timestamptz,    -- the durable refund fact; a refunded invoice is never revenue
  invoiced_at        timestamptz,    -- the INVOICE's own created_at — the date the money was taken
  created_at         timestamptz not null default now(), -- when WE recorded it
  -- Every row must be attributable: bound to an account, or parked by email.
  -- Same check credit_purchases carries, for the same reason.
  constraint subscription_invoices_attributable check (owner_id is not null or claim_email is not null)
);

comment on table public.subscription_invoices is
  'One row per Lemon Squeezy subscription invoice (subscription_payment_* webhooks). THE source of subscription revenue: an invoice covers the initial charge AND every renewal, while an order covers only the initial charge — so booking orders as well would double-count the first month. Parked by claim_email until the buyer signs in (payments.user_id is NOT NULL), exactly like credit_purchases.';
comment on column public.subscription_invoices.ls_invoice_id is
  'LS subscription-invoice id (data.id). Stable across re-delivery, across the payment_success/payment_recovered pair that LS fires for one recovered payment, and across a later refund event — which is what lets the refund find this row. NOT an order id: separate sequences, same numeric space.';
comment on column public.subscription_invoices.billing_reason is
  'LS''s own reason: initial | renewal | updated. Kept because it is the ONLY field that proves an initial invoice is not a renewal — the evidence anyone must confront before wiring order_created into revenue and double-counting month one.';
comment on column public.subscription_invoices.total_minor is
  'What the business CHARGED, NET OF TAX, in MINOR UNITS of total_currency: LS invoice attributes.subtotal - discount_total. NOT attributes.total. LS is Merchant of Record, so total includes tax LS itself remits and the business never keeps — the live sale is $9.99 + $1.80 IGST = $11.79 and this column holds 999. NOT bare subtotal either: subtotal is BEFORE discount, so a FOUNDINGTEACHER sale ($14 off $24) would book 2400 for a $10 charge. The tax figure is DISCARDED, not stored (founder, 2026-08-22) — there is deliberately no tax column here or on credit_purchases, so this value is the whole of the record and handlers.ts lsNetOfTax is its only writer. The name is inherited from the gross era; the meaning is not.';
comment on column public.subscription_invoices.total_usd_minor is
  'LS''s own USD conversion, netted the same way (subtotal_usd - discount_total_usd), kept so a charge in a currency payments_currency_check (0023) cannot hold — anything but myr/usd — is still bookable at LS''s rate rather than dropped or mis-booked as dollars.';
comment on column public.subscription_invoices.plan_key is
  'Resolved from public.subscriptions via ls_subscription_id at write time, because a subscription INVOICE carries no variant_id, product_id or product_name — plan_key cannot be derived from the invoice itself. NULL when the subscription row had not arrived yet: revenue is still recorded (money first), only its MRR attribution is lost.';
comment on column public.subscription_invoices.test_mode is
  'LS test_mode. A test-mode charge is not money and is deliberately NOT booked into payments by the invoice writer. Note the inconsistency this leaves, flagged rather than hidden: the pack path has no such guard, and three legacy pack rows (ls_order_id 9251234 / 9251647 / 9251763, $8.00 each) 404 against the live API key — they are test-mode orders inflating "Collected to date" by $24.00. Whether to filter or delete those is a founder call and is NOT made here.';

create index if not exists subscription_invoices_owner_idx
  on public.subscription_invoices (owner_id);
-- The parked probe. claim.ts runs it on EVERY authenticated dashboard render,
-- so it must stay a handful of entries no matter how large this table grows:
-- the partial predicate drops a row out of the index the instant it is claimed.
-- Indexes the RAW column, matching PostgREST's .eq("claim_email", …) — the same
-- lesson 0092 §4 had to learn about the subscriptions lookup, applied up front
-- instead of after the fact.
create index if not exists subscription_invoices_claim_idx
  on public.subscription_invoices (claim_email) where owner_id is null;
create index if not exists subscription_invoices_subscription_idx
  on public.subscription_invoices (ls_subscription_id);

-- Same posture as credit_purchases (0086), credit_ledger (0059) and
-- credit_grants (0079): platform-owned truth. The webhook and the claim run as
-- service role; nothing user-facing reads this table.
alter table public.subscription_invoices enable row level security;
revoke all on public.subscription_invoices from anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Backfill: one payments row per already-bound, paid, non-refunded invoice
-- ═══════════════════════════════════════════════════════════════════════════
-- READ THIS BEFORE EXPECTING A NUMBER. Today this inserts ZERO rows, and that
-- is not a bug in the SQL — it is the honest report of a gap in what was ever
-- stored. The one subscription sold (ls_subscription_id 2448629, family_monthly,
-- $11.79 collected, of which 999 is revenue and 180 is IGST that LS remits) has
-- no recoverable amount ANYWHERE in this database:
-- public.subscriptions has no money columns, webhook_events keeps no payload,
-- and section 2's table starts empty. The figure exists only inside Lemon
-- Squeezy.
--
-- The two things this migration deliberately does NOT do about that, each
-- because doing it would be worse than the gap:
--   · It does not hard-code order 9261749 / 999 / that buyer's email. A
--     migration that names one sale is not a repair, it is a receipt, and it
--     silently does nothing for the second sale.
--   · It does not price from PLAN_PRICES_USD_MONTHLY (src/utils/financials.ts,
--     family_monthly = 9.99). Under the net-of-tax rule that constant would
--     happen to produce the RIGHT number for this one sale — 999 — and that is
--     the trap, not the argument for it. It is a TypeScript LIST price:
--     duplicating it in SQL creates exactly the second source of truth 0092
--     refused to create for packs.ts, and a list price cannot see a discount
--     code or a proration, so the first FOUNDINGTEACHER or mid-cycle change
--     would book $24 for a $10 charge with nothing to catch it. Right answer,
--     wrong reason, wrong on the next row.
-- The repair is a REPLAY instead, which section 6 makes possible: LS's webhook
-- settings retain recent deliveries and can resend them, and a resent
-- subscription_payment_success for invoice 8235804 writes this row from the
-- REAL payload — true amount, true date, real idempotency key, nothing invented.
--
-- Everything below is written generally, so it repairs whatever IS
-- reconstructible now and stays the standing repair tool for later: re-run it
-- after any webhook outage, any replay, or any refund.
--
-- RE-RUNNABLE BY CONSTRUCTION, two ways over — the NOT EXISTS skips invoices
-- that already have a row, and ON CONFLICT catches anything inserted between
-- the two (payments_ls_invoice_uq is a full unique index, hence inferrable).
--
-- THE PREDICATES, each load-bearing:
--   · owner_id is not null — payments.user_id is NOT NULL. A still-parked
--     invoice has no owner to attribute revenue to; claim.ts records it on
--     binding. Counted separately below so this can never report "nothing to
--     do" while an unrecorded sale sits in the table.
--   · refunded_at is null — money given back is not revenue, and inventing a
--     status='refunded' row here would also invent a "collected" figure for a
--     period that never kept it.
--   · invoice_status = 'paid' — LS's other statuses are pending (a delayed
--     method, not yet collected), void, refunded and partial_refund. Only
--     'paid' is money in hand; a pending invoice books itself when it is paid
--     and its success event arrives.
--   · not test_mode — a test charge is not money. See the column comment.
--   · ls_invoice_id is not null — it is both the join key and the idempotency
--     key. Postgres treats NULLs as DISTINCT, so a NULL-key row would
--     re-insert on every re-run: the exact opposite of idempotent.
--   · a usable amount — the NET charge (total_minor, already subtotal minus
--     discount: see section 2's column comment) when its currency is one
--     payments can hold (payments_currency_check admits only myr/usd), else
--     LS's own USD conversion netted the same way. A row with neither is
--     reported rather than guessed at. No tax arithmetic happens here or
--     anywhere in SQL — the netting was done once, at the webhook boundary.
--   · the profiles EXISTS — owner_id references auth.users, payments.user_id
--     references public.profiles. Same id in this schema, but an invoice whose
--     profile row was removed would abort the whole statement on an FK
--     violation. Skip and report it rather than failing a repair migration on
--     one orphan.
--
-- created_at is copied from invoiced_at, never defaulted to now(): "Collected
-- to date" is a time series, and dating an August charge to the day this runs
-- would move real revenue into the wrong period. claim.ts and the webhook copy
-- it the same way, so all three writers produce the same fact.
do $$
declare
  inserted_count      int;
  skipped_count       int;
  parked_count        int;
  refund_fixed        int;
  unrecoverable_count int;
begin
  insert into public.payments (
    user_id, school_id, provider, ls_invoice_id, amount, currency, plan_key, status, created_at
  )
  select
    si.owner_id,
    null::uuid,        -- LS subscriptions are personal (B2C) — never school-scoped
    'lemonsqueezy',
    si.ls_invoice_id,
    case
      when si.total_minor is not null and lower(coalesce(si.total_currency, 'usd')) in ('usd', 'myr')
        then si.total_minor          -- NET of tax, already MINOR UNITS
      else si.total_usd_minor        -- LS's own USD conversion, netted the same way
    end,
    case
      when si.total_minor is not null and lower(coalesce(si.total_currency, 'usd')) in ('usd', 'myr')
        then lower(coalesce(si.total_currency, 'usd'))
      else 'usd'
    end,
    si.plan_key,       -- may be NULL: revenue is right, only MRR attribution is lost
    'paid',            -- the predicate below admits nothing else
    coalesce(si.invoiced_at, si.created_at)
  from public.subscription_invoices si
  where si.provider       = 'lemonsqueezy'
    and si.owner_id      is not null
    and si.refunded_at   is null
    and si.ls_invoice_id is not null
    and lower(coalesce(si.invoice_status, 'paid')) = 'paid'
    and coalesce(si.test_mode, false) = false
    and (
      (si.total_minor is not null and lower(coalesce(si.total_currency, 'usd')) in ('usd', 'myr'))
      or si.total_usd_minor is not null
    )
    and exists (select 1 from public.profiles pr where pr.id = si.owner_id)
    and not exists (select 1 from public.payments p where p.ls_invoice_id = si.ls_invoice_id)
  on conflict (ls_invoice_id) do nothing;

  get diagnostics inserted_count = row_count;

  -- Attributable, collected, and deliberately NOT recorded. Expected to be 0;
  -- a non-zero count is real money needing a human, so it is surfaced.
  select count(*) into skipped_count
  from public.subscription_invoices si
  where si.provider     = 'lemonsqueezy'
    and si.owner_id    is not null
    and si.refunded_at is null
    and lower(coalesce(si.invoice_status, 'paid')) = 'paid'
    and coalesce(si.test_mode, false) = false
    and (
      si.ls_invoice_id is null
      or (
        (si.total_minor is null or lower(coalesce(si.total_currency, 'usd')) not in ('usd', 'myr'))
        and si.total_usd_minor is null
      )
      or not exists (select 1 from public.profiles pr where pr.id = si.owner_id)
    );

  -- STILL PARKED — correctly absent from both counts above (no owner to
  -- attribute to, and skipped_count only looks at bound rows), which is exactly
  -- how an operator could read "0 backfilled; 0 skipped" and conclude there was
  -- nothing to repair. Each of these records itself when its buyer next signs
  -- in and claim.ts binds it. Same three-number discipline as 0092.
  select count(*) into parked_count
  from public.subscription_invoices si
  where si.provider       = 'lemonsqueezy'
    and si.owner_id      is null
    and si.refunded_at   is null
    and si.ls_invoice_id is not null;

  -- THE GAP, named out loud rather than left as a silent zero: LS subscriptions
  -- this database knows about for which NO invoice was ever recorded. Today
  -- this is 1 — the sale of 2026-08-20, whose money lives only in Lemon Squeezy.
  -- Each of these needs its subscription_payment_success replayed from the LS
  -- dashboard (section 6 releases the idempotency claim that would otherwise
  -- swallow the replay), after which re-running this migration is a no-op
  -- because the webhook itself will have written the row — at 999, the net
  -- charge, read from the REAL payload's subtotal rather than invented here.
  select count(*) into unrecoverable_count
  from public.subscriptions s
  where s.provider = 'lemonsqueezy'
    and s.ls_subscription_id is not null
    and not exists (
      select 1 from public.subscription_invoices si
      where si.ls_subscription_id = s.ls_subscription_id
    );

  -- Refund/claim ordering repair, and why it is needed: the webhook's refund
  -- path stamps payments.status='refunded' BY ls_invoice_id, which matches
  -- nothing when the refund lands before the claim has written that row. The
  -- claim then inserts from the state it read and a 'paid' row survives for
  -- money that was given back. refunded_at on the invoice is the durable fact,
  -- so reconcile against it — and this is why the migration is worth re-running
  -- after any refund, not just once. (0092 does the same for packs.)
  update public.payments p
     set status = 'refunded'
    from public.subscription_invoices si
   where si.ls_invoice_id = p.ls_invoice_id
     and si.refunded_at  is not null
     and p.provider       = 'lemonsqueezy'
     and p.status        <> 'refunded';
  get diagnostics refund_fixed = row_count;

  raise notice '0093: backfilled % subscription payment row(s); % bound paid invoice(s) skipped (no invoice id / no usable amount / no profile); % still parked (each records when its buyer next signs in); % payment row(s) corrected to refunded; % LS subscription(s) have NO recorded invoice at all — their collected amount was never stored by this app and must be recovered by replaying subscription_payment_success from the Lemon Squeezy dashboard',
    inserted_count, skipped_count, parked_count, refund_fixed, unrecoverable_count;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Repair the rows already booked GROSS of tax
-- ═══════════════════════════════════════════════════════════════════════════
-- Everything above is new money. This section is the old money: the pack rows
-- 0092 booked, and the credit_purchases.total_minor it stamped, are LS's
-- `total` — tax included. Under the founder's 2026-08-22 rule they overstate
-- revenue by exactly the tax LS remits. Live today:
--     order 9261766   payments.amount 944 → 800   credit_purchases 944 → 800
--     orders 9251234 / 9251647 / 9251763   800 each, no tax was ever charged
--                                          on them — correct under either
--                                          policy, and NOT to be touched.
-- Getting that second line right is the whole difficulty. A blanket "reduce
-- everything by 18%" would quietly destroy $24 of real, correctly-booked money.
--
-- ── HOW A GROSS ROW IS IDENTIFIED, given that the tax figure does not exist.
-- "Includes tax" is not knowable from the amount alone: 944 and 944 look the
-- same whether the second one is $9.44 of genuine revenue or $8.00 plus IGST.
-- The tax was discarded by decision (see the header) and no column will ever
-- hold it. So the evidence has to come from somewhere else in the row, and it
-- does — credit_purchases.usd, the CATALOGUE LIST PRICE the webhook copies from
-- packs.ts at purchase time (0086: "list price at purchase time").
--
-- Lemon Squeezy can only ever charge   list - discount + tax.
-- A NET figure is                      list - discount,   which is ≤ list.
-- Therefore: total_minor > list ⟹ the stored figure contains tax. Always.
-- And equally: a correctly-net row can NEVER exceed its own list price, so no
-- correct row is reachable by this predicate — no false positive, which is what
-- makes it general rather than a receipt for one order. It repairs the gross
-- rows it can SEE, including anything sold in the window between step 1 and
-- step 2 of the runbook, when the OLD gross-writing handler is still serving
-- the endpoint. (That window is a real reason to re-run this migration, on top
-- of section 6's.) It rests on one assumption worth naming: `usd` is copied
-- from packs.ts, a TypeScript constant, not read back from LS — so a variant
-- repriced UPWARD in the LS dashboard without a matching packs.ts change would
-- make a genuinely-net row look gross and be repaired downward. packs.ts's own
-- header says LS is the authority and its catalogue must be re-read from the
-- API; that warning is load-bearing here.
--
-- ── WHAT IT CANNOT SEE, stated ahead of what it does because the comment here
-- used to claim the opposite. The predicate is `stored > list`, and expanding
-- it,
--
--     list - discount + tax > list   ⟺   TAX > DISCOUNT.
--
-- So a gross row is visible ONLY when its tax exceeds its discount. A gross row
-- whose DISCOUNT IS THE LARGER of the two still sits at or below list and is
-- indistinguishable, row for row, from a correctly-net discounted sale: both
-- store a number below list, the tax figure was discarded by decision, and
-- credit_purchases has no discount column to reconstruct it from. That is not a
-- predicate that could be sharpened — it is two unknowns and one equation, and
-- no re-writing of this SQL recovers the missing half. The live FOUNDINGTEACHER
-- code ($14 fixed, and created is_limited_to_products:false, so it applies to
-- every variant in the store) puts real numbers on it: a pack_18 sold gross in
-- the deploy window stores 2000 - 1400 + 108 = 708 against a 2000 list, and a
-- pack_36 stores 3600 - 1400 + 396 = 2596 against 3600. Neither is > list, so
-- neither is repaired, and both stay overstated by their tax. They are counted
-- by `below_list` in the notice — the only honest report available, because
-- that count cannot separate them from correct discounted sales either.
--
-- ── WHAT IT SETS. The repaired value is the list price — read from the row, not
-- invented, and EXACT whenever the sale carried no discount, which is every sale
-- this store has made. A visible-gross row that was ALSO discounted (tax >
-- discount > 0) is repaired to list too, which over-books by the discount but is
-- strictly closer than the gross figure it replaces; the alternative — leaving
-- it gross because it cannot be made perfect — keeps a knowably wrong number for
-- the sake of a hypothetically wrong one. It is folded into `fixed_purchases`
-- and CANNOT be reported separately: before the repair it looks exactly like an
-- undiscounted gross row, which is the same missing equation again. So any
-- reconcile of a non-zero `fixed_purchases` or `below_list` is an LS receipt and
-- a manual UPDATE, not another query against this database.
--
-- ── THE UPPER BOUND, which exists to protect a real sale rather than to model
-- tax. LS variants can enable a QUANTITY selector; nothing in this codebase
-- reads quantity (packForOrderItem matches on the product/variant name only), so
-- a two-unit order would also store more than list. Repairing that down to list
-- would delete half a genuine sale — the one outcome worse than leaving tax in.
-- No tax regime doubles a price, and every multi-unit order is at least double,
-- so the band (list, 2 × list) is precisely "list plus tax" and nothing else.
-- At or above 2 × list this reports and refuses to touch.
--
-- ── SCOPED TO USD, because the catalogue is USD-priced (packs.ts). A charge
-- stamped in another currency has no comparable list price, so it is reported
-- rather than measured against a number that does not describe it.
--
-- ── NOTHING EQUIVALENT IS NEEDED FOR SUBSCRIPTIONS, stated so the asymmetry is
-- a decision and not an omission. subscription_invoices is created empty by
-- this migration and only lsNetOfTax ever writes total_minor, so a gross
-- subscription row cannot exist: there is no earlier code path that could have
-- produced one (subscriptions were never recorded at all — that is the hole
-- section 3 exists for). A reconcile statement here would repair a state that
-- has no way to arise.
--
-- RE-RUNNABLE: every predicate is expressed against the CURRENT stored value, so
-- a second run finds total_minor already equal to list, `>` is false, and
-- nothing is written. Idempotent by construction, not by a guard flag.

-- 0092's comment describes the gross era and is now actively misleading —
-- the schema must not keep teaching the old meaning to the next reader.
comment on column public.credit_purchases.total_minor is
  'What the business CHARGED, NET OF TAX, in MINOR UNITS of total_currency: LS order attributes.subtotal - discount_total. NOT attributes.total — LS is Merchant of Record and remits the tax, so the business never keeps it and it is not revenue ("Collected to date" is net of tax, founder 2026-08-22). NOT bare subtotal either: subtotal is BEFORE discount, so a FOUNDINGTEACHER sale ($14 off $24) would book 2400 for a $10 charge. The live pack order 9261766 collected 944 ($8.00 + $1.44 IGST) and this column holds 800. The tax figure is DISCARDED, never stored. NULL for sales made before 0092 — price those from usd, the catalogue list price, which is itself a net-of-tax figure. Name inherited from 0092; meaning corrected by 0093. handlers.ts lsNetOfTax is the only writer.';

do $$
declare
  fixed_purchases int;
  fixed_payments  int;
  above_band      int;
  below_list      int;
  no_money_stamp  int;
  not_comparable  int;
begin
  -- 4a. The durable pack record first: it is what claim.ts prices a STILL-PARKED
  -- pack from, so repairing it also fixes sales that have not been booked yet.
  -- payments is repaired from it afterwards, in that order, so both writers end
  -- on the same figure — the invariant this whole file exists to protect.
  update public.credit_purchases cp
     set total_minor = round(cp.usd * 100)::int
   where cp.provider    = 'lemonsqueezy'
     and cp.usd        is not null
     and cp.total_minor is not null
     and lower(coalesce(cp.total_currency, 'usd')) = 'usd'
     and cp.total_minor >  round(cp.usd * 100)::int          -- contains tax
     and cp.total_minor <  round(cp.usd * 100)::int * 2;     -- and is not a multi-unit order
  get diagnostics fixed_purchases = row_count;

  -- 4b. The revenue row, reconciled to the figure above rather than recomputed.
  -- `p.amount > cp.total_minor` can only ever REDUCE an amount, and only down to
  -- a number LS itself reported: a row already at or below net is untouchable by
  -- construction, which is what keeps the three untaxed $8.00 rows exactly where
  -- they are. The currency match keeps the comparison honest — a pack booked
  -- through LS's USD conversion must not be measured against a foreign-currency
  -- stamp.
  update public.payments p
     set amount = cp.total_minor
    from public.credit_purchases cp
   where cp.ls_order_id  = p.ls_order_id
     and p.ls_order_id  is not null
     and p.provider      = 'lemonsqueezy'
     and cp.provider     = 'lemonsqueezy'
     and cp.total_minor is not null
     and lower(coalesce(cp.total_currency, 'usd')) = lower(p.currency)
     and p.amount        > cp.total_minor;
  get diagnostics fixed_payments = row_count;

  -- Stored above list by more than any tax can explain. Deliberately NOT
  -- repaired (see the upper bound above) and deliberately not silent: if this is
  -- ever non-zero it is either a multi-unit order this codebase cannot credit
  -- correctly either, or a catalogue price that changed after the sale — both
  -- need a human and an LS receipt, not a guess.
  select count(*) into above_band
  from public.credit_purchases cp
  where cp.provider    = 'lemonsqueezy'
    and cp.usd        is not null
    and cp.total_minor is not null
    and lower(coalesce(cp.total_currency, 'usd')) = 'usd'
    and cp.total_minor >= round(cp.usd * 100)::int * 2;

  -- BELOW LIST — the blind spot, counted so the notice can never print all
  -- zeros over a row this section left booked gross. Run AFTER the repair, so a
  -- row 4a just lifted to list is correctly not counted here.
  --
  -- Every one of these is a DISCOUNTED sale (nothing else stores under list),
  -- and a discounted sale is exactly the shape whose tax content cannot be
  -- decided: `stored > list` sees a gross row only when its tax exceeds its
  -- discount, so a bigger discount hides the tax completely. This count
  -- therefore mixes two populations it has NO way to separate — correct net
  -- discounted sales (the expected case once the new code is deployed: every
  -- FOUNDINGTEACHER pack lands here forever, and none of them is wrong) and any
  -- gross row sold in the step-1→step-2 window whose discount beat its tax.
  -- It is a "go and look" number, not an error count: reconcile a non-zero
  -- value against the LS receipts for those orders, and only then UPDATE.
  -- Reported rather than repaired because the repair would have to invent the
  -- tax, which is the one thing this migration refuses to do.
  select count(*) into below_list
  from public.credit_purchases cp
  where cp.provider    = 'lemonsqueezy'
    and cp.usd        is not null
    and cp.total_minor is not null
    and lower(coalesce(cp.total_currency, 'usd')) = 'usd'
    and cp.total_minor <  round(cp.usd * 100)::int;

  -- A BOOKED SALE WITH NO MONEY FACT. Every predicate above needs total_minor,
  -- so a pack whose money stamp never landed is invisible to all of them — and
  -- that stamp is deliberately best-effort (handlers.ts warns and continues, so
  -- a bookkeeping column can never fail a credit grant), so a NULL is a
  -- reachable state and not a theoretical one. Joined to payments because a
  -- NULL stamp only matters once a revenue row exists: while the pack is still
  -- parked, claim.ts prices it from `usd`, the catalogue LIST price, which is
  -- net of tax by construction. What it catches is the one bad combination —
  -- the old gross-writing handler booked payments.amount from LS's `total` and
  -- left nothing behind to measure it against. Not repairable from the row
  -- (there is no stored figure at all), so: reported, with the LS receipt as
  -- the only way to settle it.
  select count(*) into no_money_stamp
  from public.credit_purchases cp
  where cp.provider    = 'lemonsqueezy'
    and cp.total_minor is null
    and exists (
      select 1 from public.payments p
      where p.ls_order_id = cp.ls_order_id
        and p.provider    = 'lemonsqueezy'
    );

  -- No list price, or a charge in a currency the USD catalogue cannot be
  -- measured against. If any of these was booked gross it STAYS gross — there is
  -- no evidence in the row to prove it either way, and inventing one is the
  -- thing this migration refuses to do.
  select count(*) into not_comparable
  from public.credit_purchases cp
  where cp.provider     = 'lemonsqueezy'
    and cp.total_minor is not null
    and (cp.usd is null or lower(coalesce(cp.total_currency, 'usd')) <> 'usd');

  raise notice '0093 §4 net-of-tax repair: % credit_purchases row(s) re-stamped net; % payments row(s) reduced to match; % row(s) above 2x list left ALONE (multi-unit order or changed catalogue price — reconcile against Lemon Squeezy by hand); % DISCOUNTED row(s) below list, whose tax content this section CANNOT decide either way (correct net sales and gross-with-a-bigger-discount look identical — check the LS receipt before touching one); % booked row(s) carrying no money stamp at all (total_minor NULL — nothing to measure, check the LS receipt); % row(s) not comparable to the USD catalogue (no list price or foreign currency) and left as stored',
    fixed_purchases, fixed_payments, above_band, below_list, no_money_stamp, not_comparable;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Ownership already resolvable — nothing to re-bind
-- ═══════════════════════════════════════════════════════════════════════════
-- Stated so its absence is a decision and not an oversight: 0092 §3 had to
-- re-bind billing_customers rows the pack incident orphaned. Nothing equivalent
-- is needed here. The one live subscription is already bound (subscriptions
-- .user_id NOT NULL, claim_email NULL) because the subscription lifecycle
-- events and claim.ts have always handled that path correctly — it was only
-- ever the MONEY that was dropped, never the ownership. Any future parked
-- subscription binds through claim.ts's existing pass.

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Let the replay actually replay
-- ═══════════════════════════════════════════════════════════════════════════
-- Without this, the recovery described in section 3 silently does nothing.
--
-- The route (api/webhooks/lemonsqueezy) claims a key in webhook_events built as
-- lsEventKey(event_name, object_id, updated_at) and, if that key exists AND
-- carries processed_at, returns {duplicate:true} WITHOUT calling the handler.
-- Prod already holds
--     ls_subscription_payment_success_8235804_2026-08-20T07:20:33.000000Z
-- marked processed — processed by the code that DROPPED it. LS's "resend"
-- replays the stored payload, so it would arrive with that same updated_at,
-- hit that same key, and be waved through as a duplicate. The dashboard would
-- show a green delivery and no row would be written.
--
-- Releasing the claim is safe precisely because nothing downstream trusts it
-- for correctness: every write on the invoice path is idempotent on its own
-- unique key (subscription_invoices.ls_invoice_id, payments_ls_invoice_uq), so
-- reprocessing is a no-op by construction. That is the same property the route
-- already relies on when it deliberately reprocesses a claimed-but-unfinished
-- event after a crash.
--
-- Scoped to the invoice family only — subscription_payment_success / _failed /
-- _recovered / _refunded — because those are the exact events the old code
-- threw away. Lifecycle events (created/updated/cancelled) were handled
-- correctly and keep their claims.
--
-- ⚠️ RUN THIS AGAIN AFTER THE APP IS DEPLOYED, and before clicking resend. This
-- statement is the whole reason the runbook at the top of the file has three
-- steps. The migration is applied BEFORE the deploy (the new code needs the
-- table), so between the two the OLD handler still owns the endpoint: a
-- subscription_payment_* delivered in that window is routed to the
-- non-subscription-object guard, logged `ignored_non_subscription_object`, and
-- returned WITHOUT throwing — so the route stamps processed_at and returns 200,
-- re-claiming the very key this DELETE just released. A resend afterwards is
-- then short-circuited as {duplicate:true}, the handler never runs, and the
-- charge is unrecoverable: subscription_invoices has no row for it,
-- webhook_events keeps no payload, and public.subscriptions has no money
-- columns. Re-running closes that window. Doing so is safe and cheap — every
-- write on the invoice path is idempotent on its own unique key
-- (subscription_invoices.ls_invoice_id, payments_ls_invoice_uq), which is the
-- same property the route already relies on when it deliberately reprocesses a
-- claimed-but-unfinished event after a crash. To run it alone:
--     delete from public.webhook_events
--      where id like 'ls!_subscription!_payment%' escape '!';
--
-- ESCAPED `_`: in LIKE, an unescaped underscore is a single-character wildcard.
-- Harmless against today's key space (every id is either 'ls_…' or a Stripe
-- 'evt_…'), but a predicate that means what it says costs nothing. `!` rather
-- than the default backslash so the literal cannot depend on
-- standard_conforming_strings: '\' is one backslash under the standard and an
-- escaped quote without it, and a DELETE is not the place to find out.
delete from public.webhook_events
 where id like 'ls!_subscription!_payment%' escape '!';

-- ⚠️ NOT CLOSED BY THIS MIGRATION, listed so each is a decision rather than a
-- discovery:
--   · PARTIAL REFUNDS. LS's invoice status 'partial_refund' carries a
--     refunded_amount. collectedUsd() (src/utils/financials.ts) counts only
--     PAID_STATUSES and knows neither 'refunded' nor 'partial_refund', so a
--     partial refund currently drops the WHOLE sale out of the total instead of
--     reducing it by the refunded part. The invoice writer treats it as a full
--     refund — conservative (never overstates), but not right.
--   · A REFUND OF A SUBSCRIPTION'S INITIAL ORDER, if LS sends only
--     order_refunded for it. handleLsOrderEvent returns at
--     `order_ignored_not_pack` before its refund block, and nothing stored
--     links an order id to an invoice (see the deliberate absence of
--     subscriptions.ls_order_id at the top of this file), so that event is
--     inert on revenue. It is inert CORRECTLY only if LS also delivers
--     subscription_payment_refunded for the same money — which the invoice
--     object's refunded/refunded_at/refunded_amount fields and the live
--     webhook's own subscription_payment_refunded subscription both imply, but
--     which no refund on this store has ever demonstrated. Check it against the
--     first real refund; handlers.ts carries the same note at the return in
--     question, with the fix if the assumption turns out to be wrong.
--   · DISPUTES. dispute_created / dispute_resolved are already subscribed on
--     the live webhook and are entirely unhandled. A chargeback removes money
--     with no order_refunded and no subscription_payment_refunded, so "a refund
--     must stop counting" is not fully true until disputes do too.
--   · TEST-MODE LEGACY ROWS. See the test_mode column comment: $24.00 of the
--     console's current total is test-mode pack money. Not touched here.
--   · A DISCOUNTED SALE THAT WAS ALSO TAXED — the one class section 4 cannot
--     settle, in either direction, because the tax half of
--     `list - discount + tax` was discarded rather than stored:
--       – tax > discount: the row reads above list, so section 4 SEES it and
--         repairs it to list, over-booking by the discount. Indistinguishable
--         from an undiscounted gross row before the repair, so it is folded
--         into `fixed_purchases` and cannot be reported on its own.
--       – discount ≥ tax: the row reads at or below list and section 4 CANNOT
--         see it at all. It stays booked gross. It is counted by `below_list`,
--         alongside the correct net discounted sales it is identical to.
--     The fix for either is an LS receipt and a manual UPDATE. Applies to no
--     row this store holds today (every sale so far is undiscounted), and the
--     exposure closes the moment the new code owns the endpoint — the only way
--     to create one is the step-1→step-2 deploy window.
--   · TAX ON THE FIGURES SHOWN, as opposed to the figures stored. Every writer
--     now books subtotal - discount_total, so "Collected to date" is net of tax
--     end to end and the tax number exists nowhere in this database. The
--     consequence to accept knowingly: this database can no longer answer "how
--     much tax did LS remit on our behalf" at all. That is the founder's
--     decision of 2026-08-22 — one figure, not two — and reversing it would
--     mean a new column plus a re-fetch from LS, not a migration over what is
--     stored here.
