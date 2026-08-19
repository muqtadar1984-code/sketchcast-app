-- 0092 — Record what a credit pack actually COLLECTED, backfill the missing
-- pack revenue rows, re-bind the customer mappings the incident orphaned, and
-- give claim.ts's parked-subscription lookup an index it can actually use.
--
-- THE INCIDENT (verified against prod 2026-08-19). payments.user_id is NOT
-- NULL, so the LS webhook (handlers.ts) can only write a pack's revenue row
-- when the buyer is already bound at webhook time. Its comment justified that
-- as "the rare fallback", because packs are "sold from inside the app to
-- signed-in paid users" — which is not true and never was. The in-app buy chip
-- (src/app/dashboard/fair-use-meter.tsx) is a plain <a href> to the LS hosted
-- checkout with NO custom_data, so the webhook only ever sees a buyer-typed
-- email: every pack sale arrives PARKED (credit_purchases.owner_id NULL,
-- claim_email set), and parked is the only path a pack can take. Consequently
-- EVERY pack ever sold is missing from the console's "Collected to date".
--
-- Going forward, claim.ts writes the payments row at the moment it binds the
-- pack — the first instant a user_id exists for that order. This migration
-- repairs the sales made before that fix and gives both writers the columns
-- they need to agree on the amount.
--
-- APPLY THIS BEFORE DEPLOYING THE APP. claim.ts reads the three columns added
-- below when it binds a pack. Shipping the code first is survivable — it falls
-- back to the old blind bind so credits still land, loudly logged — but the
-- revenue row waits until this runs, and the subscriptions lookup stays a seq
-- scan until section 4 exists.
--
-- NOTHING HERE CHANGES A BALANCE. No credit_purchases row loses or gains
-- credits; the credits were always correct. This is bookkeeping only: it makes
-- the revenue view agree with money that was genuinely collected.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. What LS actually charged — the fact nobody was keeping
-- ═══════════════════════════════════════════════════════════════════════════
-- credit_purchases.usd is the catalogue LIST price: 0086 calls it
-- "display/reconciliation only", and handlers.ts writes it from a TypeScript
-- constant (src/utils/billing/packs.ts), so it cannot see a discount code. The
-- webhook's own payments row, meanwhile, prefers LS's `total` — the amount
-- actually collected. With parked as the only path a pack can take, the claim
-- path became the sole writer, and every pack would have been booked at list
-- forever while the code claimed to mirror the webhook "field-for-field".
--
-- So persist the money at the moment LS reports it. handlers.ts stamps these
-- in a SEPARATE best-effort statement, deliberately not in the insert that
-- grants the credits: a missing column must never be able to fail a credit
-- grant. Every row that predates this migration keeps NULLs and is priced from
-- the catalogue, which is the best available answer for those sales.
alter table public.credit_purchases add column if not exists total_minor    int;
alter table public.credit_purchases add column if not exists total_currency text;
alter table public.credit_purchases add column if not exists order_status   text;

comment on column public.credit_purchases.total_minor is
  'What Lemon Squeezy actually collected for this order, in MINOR UNITS of total_currency (LS order attributes.total). NULL for sales made before 0092 — price those from usd, the catalogue list price. LS is Merchant of Record, so this can include tax the business does not keep.';
comment on column public.credit_purchases.total_currency is
  'Currency of total_minor, lower-cased, as LS reported it. payments_currency_check admits only myr/usd, so a charge in anything else is booked at the USD list price instead and logged (claim.ts).';
comment on column public.credit_purchases.order_status is
  'LS order status at the time of the event ("paid", "pending", ...). Echoed onto payments.status so a pending or failed order is not counted by collectedUsd(); NULL (pre-0092) reads as "paid".';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Backfill: one payments row per already-bound, non-refunded pack
-- ═══════════════════════════════════════════════════════════════════════════
-- RE-RUNNABLE BY CONSTRUCTION, two ways over: the NOT EXISTS skips orders that
-- already have a row, and ON CONFLICT catches anything that slips in between
-- (payments_ls_order_uq is a FULL unique index on ls_order_id, so it is
-- inferrable as the arbiter). Running this twice inserts nothing the second
-- time.
--
-- THE PREDICATES, each load-bearing:
--   · owner_id is not null — payments.user_id is NOT NULL. A still-parked pack
--     has no owner to attribute revenue to; claim.ts records it on binding.
--     Those rows are counted separately below so this migration cannot report
--     "nothing to do" while an unrecorded sale is sitting right there.
--   · refunded_at is null — a refunded order was collected and given back. It
--     is not revenue, and inventing a status='refunded' row here would also
--     invent a "collected" figure for a period that never kept the money. The
--     webhook's refund path stamps rows that exist; for these it correctly has
--     nothing to stamp.
--   · ls_order_id is not null — it is both the join key to payments and the
--     idempotency key. Postgres treats NULLs as DISTINCT in a unique index, so
--     a NULL-order row would re-insert on every re-run: the exact opposite of
--     idempotent. Every LS-written pack carries one.
--   · a usable price — total_minor when LS stamped one in a currency payments
--     can hold, else the catalogue list price in usd. A row with neither is
--     reported below rather than guessed at: an invented amount corrupts the
--     revenue total silently, and duplicating packs.ts in SQL would create a
--     second source of truth that drifts.
--   · the profiles EXISTS — credit_purchases.owner_id references auth.users,
--     but payments.user_id references public.profiles. They are the same id in
--     this schema, yet a purchase whose profile row was removed would abort the
--     whole statement on an FK violation. Skip it and report it instead of
--     failing a repair migration on one orphan.
--
-- created_at is copied from the PURCHASE, not defaulted to now(): "Collected to
-- date" is a time series, and dating an August sale to the day this migration
-- runs would move real revenue into the wrong period. claim.ts copies it the
-- same way, so backfilled rows and go-forward rows are the same fact.
do $$
declare
  inserted_count int;
  skipped_count  int;
  parked_count   int;
  refund_fixed   int;
begin
  insert into public.payments (
    user_id, school_id, provider, ls_order_id, amount, currency, plan_key, status, created_at
  )
  select
    cp.owner_id,
    null::uuid,      -- LS packs are personal (B2C) — never school-scoped
    'lemonsqueezy',
    cp.ls_order_id,
    case
      when cp.total_minor is not null and coalesce(cp.total_currency, 'usd') = 'usd'
        then cp.total_minor                 -- what LS collected, already MINOR UNITS
      else round(cp.usd * 100)::int         -- numeric(8,2) list dollars -> MINOR UNITS
    end,
    'usd',           -- packs are a USD-priced catalogue; payments_currency_check allows it
    cp.pack_key,     -- 'pack_6' | 'pack_18' | 'pack_36', exactly as the webhook writes it
    coalesce(cp.order_status, 'paid'),      -- pre-0092 rows carry no status and were paid
    cp.created_at
  from public.credit_purchases cp
  where cp.provider = 'lemonsqueezy'
    and cp.owner_id    is not null
    and cp.refunded_at is null
    and cp.ls_order_id is not null
    and (
      cp.usd is not null
      or (cp.total_minor is not null and coalesce(cp.total_currency, 'usd') = 'usd')
    )
    and exists (select 1 from public.profiles pr where pr.id = cp.owner_id)
    and not exists (select 1 from public.payments p where p.ls_order_id = cp.ls_order_id)
  on conflict (ls_order_id) do nothing;

  get diagnostics inserted_count = row_count;

  -- Anything attributable that we deliberately did NOT price or attribute.
  -- Expected to be 0; a non-zero count is a real sale needing a human, so it is
  -- surfaced rather than swallowed.
  select count(*) into skipped_count
  from public.credit_purchases cp
  where cp.provider = 'lemonsqueezy'
    and cp.owner_id    is not null
    and cp.refunded_at is null
    and (
      cp.ls_order_id is null
      or (cp.usd is null and (cp.total_minor is null or coalesce(cp.total_currency, 'usd') <> 'usd'))
      or not exists (select 1 from public.profiles pr where pr.id = cp.owner_id)
    );

  -- STILL PARKED — the very state the incident produces, and the reason this
  -- block reports three numbers instead of two. Such a row is correctly absent
  -- from the insert above (no owner to attribute it to) AND from skipped_count
  -- (which only looks at bound rows), so an operator reading "0 backfilled; 0
  -- skipped" would conclude there was nothing to repair while an unrecorded
  -- sale sat in the table. Each of these records itself when its buyer next
  -- signs in and claim.ts binds it.
  select count(*) into parked_count
  from public.credit_purchases cp
  where cp.provider = 'lemonsqueezy'
    and cp.owner_id    is null
    and cp.refunded_at is null
    and cp.ls_order_id is not null;

  -- Refund/claim ordering repair, and the reason it is needed: the webhook's
  -- refund path stamps payments.status='refunded' by ls_order_id, which matches
  -- nothing if the refund lands before the claim has written that row. The
  -- claim then inserts from the state it read and a 'paid' row survives for
  -- money that was given back. credit_purchases.refunded_at is the durable
  -- fact, so reconcile against it — and this is why the migration is worth
  -- re-running after any refund, not just once.
  update public.payments p
     set status = 'refunded'
    from public.credit_purchases cp
   where cp.ls_order_id  = p.ls_order_id
     and cp.refunded_at is not null
     and p.provider      = 'lemonsqueezy'
     and p.status       <> 'refunded';
  get diagnostics refund_fixed = row_count;

  raise notice '0092: backfilled % pack payment row(s); % bound non-refunded pack(s) skipped (no order id / no price / no profile); % still parked (each records when its buyer next signs in); % payment row(s) corrected to refunded',
    inserted_count, skipped_count, parked_count, refund_fixed;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Re-bind the customer mappings the incident orphaned
-- ═══════════════════════════════════════════════════════════════════════════
-- A public-link purchase parks a billing_customers row with user_id NULL too,
-- and claim.ts binds it in the same pass that binds the purchase. The pack sold
-- during the incident was bound to its owner BY HAND, so its mapping never went
-- through that pass and is still orphaned — and claim.ts cannot repair it,
-- because it only reaches that write when something is parked RIGHT NOW, which
-- for an already-bound pack is never. Left alone the buyer gets a 404 from
-- /api/billing/portal when they go looking for their own receipts, and
-- resolveIdentity keeps reading them as "unclaimed" on every future purchase.
--
-- SAME SECURITY RULE AS THE RUNTIME, not a looser one: bind only to an account
-- whose email Supabase has CONFIRMED (email_confirmed_at), matched on the
-- lower-cased address both sides already normalise to. A buyer can type any
-- email at LS checkout, so the confirmed account is the only proof of control
-- we accept — here exactly as in claim.ts.
--
-- The profiles EXISTS is an FK guard, not a filter: billing_customers.user_id
-- references public.profiles(id) (0022) while the email lives on auth.users.
-- Binding multiple LS rows to one user is legal — 0023 narrowed the
-- (user_id, provider) unique index to Stripe only.
do $$
declare
  mapped_count int;
begin
  update public.billing_customers bc
     set user_id = u.id
    from auth.users u
   where bc.user_id  is null
     and bc.provider  = 'lemonsqueezy'
     and bc.email    is not null
     and lower(bc.email) = lower(u.email)
     and u.email_confirmed_at is not null
     and exists (select 1 from public.profiles pr where pr.id = u.id);
  get diagnostics mapped_count = row_count;
  raise notice '0092: bound % orphaned lemonsqueezy customer mapping(s) to their verified account', mapped_count;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. An index claim.ts's parked-subscription lookup can actually use
-- ═══════════════════════════════════════════════════════════════════════════
-- 0023 created subscriptions_claim_email_idx on lower(claim_email), but
-- claim.ts queries the RAW column: PostgREST's .eq("claim_email", email) emits
-- `claim_email = $1`, and the planner will not match that to a FUNCTIONAL index
-- on lower(claim_email). The lookup has therefore always been a seq scan — and
-- it now runs on every authenticated adult dashboard render, not once per OAuth
-- callback, which is what turns a harmless one into something worth indexing.
--
-- WHY THE INDEX AND NOT THE QUERY. Reaching the functional index needs the
-- predicate to be written `lower(claim_email) = $1`, and the supabase-js client
-- cannot express that — .eq() always names a bare column. Matching it would
-- mean adding an RPC or a generated column: new API surface and, for an RPC, a
-- new security boundary on the single most identity-sensitive lookup we have,
-- all to avoid one small partial index. Results are already CORRECT either way
-- (emails are normalised lower-case on both write paths, so the raw equality
-- and the lower() equality select the same rows) — only the access path was
-- wrong. So: index the column the query actually filters on, and leave the
-- query, its security posture, and its call signature untouched.
--
-- Same partial predicate as 0023's, which is the point: it indexes only rows
-- that are PARKED, so it stays a handful of entries no matter how large
-- subscriptions grows, and it disappears from the index the instant a row is
-- claimed.
create index if not exists subscriptions_claim_email_raw_idx
  on public.subscriptions (claim_email)
  where claim_email is not null and user_id is null;

comment on index public.subscriptions_claim_email_raw_idx is
  'Parked (unclaimed) LS subscriptions by raw claim_email — serves claim.ts''s .eq("claim_email", ...) equality, which cannot use the lower(claim_email) functional index from 0023. Emails are stored lower-cased, so the two agree on results.';

-- The 0023 functional index is now redundant for this access path but is left
-- in place: subscriptions is small and webhook-write-only, so the cost is
-- negligible, and dropping an index no longer referenced by any code we can see
-- is a change worth making on its own evidence, not as a side effect of a
-- revenue backfill.
