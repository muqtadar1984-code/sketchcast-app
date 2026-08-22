# SketchCast Billing — Setup & Operations

**Two providers, one entitlements table.** The app gates paid access on the
provider-agnostic `entitlements` table, so which processor took the money is
invisible downstream.

| Audience | Provider | Model | Currency |
|---|---|---|---|
| **Schools** | **Stripe** | Aethel Twin is the **direct merchant** | MYR |
| **Parents / Teachers** | **Lemon Squeezy** | LS is the **Merchant of Record** | USD |

**Why the split.** Schools are few, large, and mostly invoiced (bank transfer)
— Aethel Twin bills them directly (Stripe card only for those who prefer it),
and the school handles its own tax. Parents/teachers are many small
international B2C transactions where being the merchant means a global
sales-tax/VAT/GST nightmare — so **Lemon Squeezy is the seller of record**: LS
charges the customer, handles all consumer tax worldwide, appears on their
statement, and pays Aethel Twin a payout (net of LS fees). **Card data never
touches our servers on either provider** (both use hosted checkout), keeping us
out of PCI-DSS scope.

---

## Part A — Stripe (schools · MYR · direct merchant)

**Merchant: Aethel Twin Sdn. Bhd. (Malaysia).** Settles **MYR** to a Malaysian
bank. Hosted Checkout + Billing Customer Portal only.

## Non-negotiables (enforced in code)
1. **MYR only** — every Price is denominated in MYR; checkout re-fetches the
   live Price and refuses anything else (`assertMyrPrice`). The `payments`
   table has a `currency = 'myr'` CHECK.
2. **Adults only** — `teacher`, `parent`, `school_admin` (and `coordinator`,
   a teacher under the multi-role model). A `student` gets `403` from every
   billing route, and RLS blocks students from every billing table.
3. **Entitlements are the single source of truth** — the app gates paid
   features on the `entitlements` table (written only by the webhook/checkout
   server code), never by calling Stripe inline.
4. **Flag-gated** — `BILLING_ENABLED=false` keeps every surface dead. There is
   also a per-school opt-out (`schools.billing_enabled = false`).

## Stripe Dashboard settings (do these by hand — not expressible in code)
- **Adaptive Pricing / presentment-currency conversion: OFF.** Foreign
  customers' own banks do any conversion; Aethel Twin receives pure MYR.
- **Settlement currency: MYR** to the Malaysian bank account.
- Business profile: Aethel Twin Sdn. Bhd.; statement descriptor mentioning
  SKETCHCAST.
- Billing → Customer Portal: enable card update, invoice history, and
  self-service cancellation.
- Webhook endpoint: `https://app.sketchcast.app/api/webhooks/stripe`, events:
  `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`,
  `invoice.paid`, `invoice.payment_failed`. Copy the signing secret into
  `STRIPE_WEBHOOK_SECRET`.

## Plans
| plan_key | provider | tier | interval | who |
|---|---|---|---|---|
| `teacher_pro_monthly` / `teacher_pro_annual` | Lemon Squeezy | teacher_pro | monthly / yearly | teachers |
| `teacher_pro_plus_monthly` / `teacher_pro_plus_annual` | Lemon Squeezy | teacher_pro_plus | monthly / yearly | teachers |
| `family_monthly` / `family_annual` | Lemon Squeezy | family | monthly / yearly | parents (any adult) — sold as **"Home Basic"** (display name only; keys never rename) |
| `homeschool_monthly` / `homeschool_annual` | Lemon Squeezy | homeschool | monthly / yearly | parents (any adult) — product **"SketchCast Homeschool"**, $34 / $340 |
| `school_annual` | Stripe | school | yearly | school admins (card) |
| `school_onetime` | Stripe | school | 365-day licence | school admins (card) |

Each LS **product** (Teacher Pro, Teacher Pro+, Home Basic, Homeschool) serves
both cycles on one hosted-checkout page; the eight `plan_key`s map 1:1 to LS
**variant ids** (via env). The public pricing page carries no `plan_key`, so the
webhook derives it from the subscription's `variant_id` — see
`planKeyForVariant()` in `plans.ts`. Homeschool only: if its variant envs are
unset, the webhook falls back to the **product name** `SketchCast Homeschool`
(+ variant name `Monthly`/`Annual`) rather than dropping the sale.

**One-time CREDIT PACKS** (top-ups, not plans — they never touch
`entitlements`): `pack_6` 6 credits $8 · `pack_18` 18 credits $20 · `pack_36`
36 credits $36. Config + the exact LS product names live in
`src/utils/billing/packs.ts`; accounting in migration `0086` (persistent
balance, consumed after the monthly quota). Sold only to paid tiers (UI gate);
ships dark until each pack's `checkoutUrl` is filled in.

**Most schools pay by bank transfer against a direct Aethel Twin invoice —
outside Stripe entirely.** The `school_*` plans exist only for schools that
*choose* card payment; never force schools through Stripe. Amounts are
placeholders in `scripts/stripe_seed.ts` (pricing not finalised).

## Run instructions

```bash
# Install
npm install

# Configure — fill Stripe TEST keys + the Price IDs the seed prints
#   (env vars listed below)

# Seed Products/Prices in MYR (idempotent; prints env lines)
npx tsx scripts/stripe_seed.ts

# Apply the DB migration: paste supabase/migrations/0022_billing.sql into the
# Supabase SQL editor and run it as ONE execution (this repo applies
# migrations manually — there is no `supabase db push` pipeline).

# Run the app
npm run dev

# Forward webhooks locally (separate terminal; Stripe CLI)
stripe listen --forward-to localhost:3000/api/webhooks/stripe
# → copy the whsec_... it prints into STRIPE_WEBHOOK_SECRET for local dev

# Simulate flows
stripe trigger checkout.session.completed
```

### Environment
```
# Stripe — SCHOOL plans only (MYR, direct merchant)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_SCHOOL_ANNUAL=price_...
STRIPE_PRICE_SCHOOL_ONETIME=price_...

# Lemon Squeezy — PARENT/TEACHER plans (USD, Merchant of Record). One variant id
# per product×cycle; the webhook maps variant_id → plan_key.
LEMONSQUEEZY_API_KEY=...
LEMONSQUEEZY_STORE_ID=...
LEMONSQUEEZY_WEBHOOK_SECRET=...
LEMONSQUEEZY_VARIANT_TEACHER_PRO_MONTHLY=...
LEMONSQUEEZY_VARIANT_TEACHER_PRO_ANNUAL=...
LEMONSQUEEZY_VARIANT_TEACHER_PRO_PLUS_MONTHLY=...
LEMONSQUEEZY_VARIANT_TEACHER_PRO_PLUS_ANNUAL=...
LEMONSQUEEZY_VARIANT_FAMILY_MONTHLY=...
LEMONSQUEEZY_VARIANT_FAMILY_ANNUAL=...
LEMONSQUEEZY_VARIANT_HOMESCHOOL_MONTHLY=...
LEMONSQUEEZY_VARIANT_HOMESCHOOL_ANNUAL=...
# The FOUNDINGTEACHER discount's id (LS dashboard URL, or GET /v1/discounts).
# Not a secret — an object id. Read only by /api/public/founding-places, which
# reports how many of the capped founding places are gone; unset just means that
# endpoint falls back to counting `subscriptions.is_founding`.
LEMONSQUEEZY_FOUNDING_DISCOUNT_ID=...
# Optional: EXTRA origins allowed to read the public marketing endpoints
# (comma-separated). sketchcast.app and www.sketchcast.app are always allowed;
# this is for a Cloudflare preview deployment. Never a wildcard.
MARKETING_ORIGINS=

BILLING_ENABLED=false
APP_URL=https://app.sketchcast.app
# plus the existing Supabase vars (service key is used for webhook writes + claim)
```

## Architecture
```
adult clicks upgrade → POST /api/billing/checkout ─► Stripe hosted Checkout
                                                        │ (card handled by Stripe)
Stripe ──signed webhook──► /api/webhooks/stripe ──► webhook_events (dedupe)
                                                └─► subscriptions / payments
                                                └─► entitlements  ◄── the app
                                                                      gates on
adult manages billing → POST /api/billing/portal ─► Stripe Customer Portal
```
- Webhook is Node-runtime, raw-body signature-verified, and idempotent via the
  `webhook_events` PK; a failed handler releases its claim so Stripe's retry
  reprocesses.
- Tenant/user on webhook objects come from metadata **we** set at session
  creation and are cross-checked against the stored `billing_customers`
  mapping — never unlocked from client-influencable data.
- `past_due` keeps access (grace); revocation happens when Stripe transitions
  the subscription to `canceled`/`unpaid`.

## Stripe tax note
Tax on the **Stripe/school** path stays out of scope — B2B buyers self-account
(reverse charge). The consumer-tax problem is solved on the Lemon Squeezy side
below (LS is MoR). If schools ever need Stripe-side tax, the seam is
`stripeCheckout()` in `src/app/api/billing/checkout/route.ts`.

---

## Part B — Lemon Squeezy (parents/teachers · USD · Merchant of Record)

**Lemon Squeezy is the merchant of record** for parent/teacher sales. It is the
seller on the customer's statement, it collects and remits all consumer tax
(VAT/GST/US sales tax) globally, and it pays Aethel Twin a payout net of LS
fees. Aethel Twin carries **no B2C consumer-tax liability** — that's the whole
reason for using LS here. Card data never touches us (LS hosted checkout).

### Lemon Squeezy Dashboard setup (by hand)
- Create/verify the LS **store** for Aethel Twin (LS onboards you as the
  software company; LS is MoR on top). Set the store currency to **USD**.
- Create four **subscription products** priced in **USD**, each with a Monthly
  and an Annual variant: **Teacher Pro** ($24 / $240), **Teacher Pro+** ($49 /
  $490), **Home Basic** ($9.99 / $99 — the family_* keys), and
  **SketchCast Homeschool** ($34 / $340 — name it EXACTLY that, variants
  `Monthly`/`Annual`, because the webhook's name fallback matches on it). Copy
  the eight **Variant IDs** into the eight `LEMONSQUEEZY_VARIANT_*` env vars
  (below). The webhook maps a subscription's `variant_id` back to a `plan_key`,
  so these must match the live store.
- Create the credit packs as **ONE single-payment product** named exactly
  `SketchCast Credits` with three variants (the same shape as the Homeschool
  product's Monthly/Annual):
  - variant `1 kit (6)` — $8
  - variant `3 kits (18)` — $20
  - variant `6 kits (36)` — $36
  The webhook identifies a pack by the `SketchCast Credits` product-name
  prefix plus the trailing credit count in parentheses, which may sit on the
  product name OR the variant name — so three separate products named
  `SketchCast Credits — 1 kit (6)` / `— 3 kits (18)` / `— 6 kits (36)` work
  identically if that layout is ever preferred. Either way the count in
  `(…)` is load-bearing; an order whose count matches no configured pack is
  logged and ignored, never guessed.
  Then paste **each pack's own** checkout URL into
  `LEMONSQUEEZY_CHECKOUT_PACK_6/18/36` or the literals in
  `src/utils/billing/packs.ts` — a null URL keeps that pack's buy button
  hidden, so the feature ships dark until this step.
  > ⚠️ **`/checkout/buy/<slug>` is a VARIANT share link. There is no
  > product-level link with a variant picker, so the same URL in all three
  > slots is NOT fine** — it is precisely the bug that shipped on 2026-08-18,
  > when all three chips carried the `1 kit (6)` slug and the $20 and $36
  > buttons opened an $8 checkout and credited 6. A variant link opens one
  > variant at one price and shows no chooser (its own page state reports
  > `isMultiVariant: false`). Nothing errors when this is wrong — the buyer is
  > simply charged by whatever variant the link opens, and crediting follows
  > the variant actually bought. **Verify every repoint by fetching the URL
  > and reading the subtotal it renders**, never by trusting a slug written in
  > a comment or a doc; LS mints a new slug whenever a variant is edited.
  > Note also that `LEMONSQUEEZY_CHECKOUT_PACK_6/18/36` **override** the
  > literals in `packs.ts` (`resolvedPacks()` reads env first), so one stale
  > value in Vercel silently defeats a correct `packs.ts` with no test failure
  > and no error. Audit these three alongside the variant ids.
- Create the founding discount code **`FOUNDINGTEACHER`** on the Teacher Pro
  product (→ $10/mo, price-locked 24 months). It is a *discount*, not a separate
  product — the public pricing page shows the code and tells teachers to paste
  it at checkout. The webhook flags such subs `is_founding` (same access as
  Teacher Pro, tracked for grandfathering).
  **The 50-place cap lives in LS and only in LS** (`is_limited_redemptions`
  + `max_redemptions`), so LS itself refuses the 51st teacher — "Only the first
  50 teachers" on /pricing is a mechanism, not an honour system. Put the
  discount's id in `LEMONSQUEEZY_FOUNDING_DISCOUNT_ID`; this repo holds no cap
  literal and no claimed-count literal anywhere.
  > ⚠️ **On store activation, re-point `LEMONSQUEEZY_FOUNDING_DISCOUNT_ID`.**
  > LS keeps test-mode and live-mode objects as separate data sets, so going
  > live creates a **new** FOUNDINGTEACHER discount with a **new id**. The old
  > test-mode id does not error — it keeps answering `0 redemptions` forever,
  > which would publish "0 of 50 claimed · 50 left" on /pricing while real
  > teachers consumed real places. `/api/public/founding-places` refuses a
  > test-mode discount in production for exactly this reason (it degrades to
  > counting `subscriptions.is_founding`, which is mode-agnostic), so the
  > symptom of a forgotten re-point is a **missing** counter, not a wrong one.
- **Settings → API** → create an API key → `LEMONSQUEEZY_API_KEY`. Copy the
  **Store ID** → `LEMONSQUEEZY_STORE_ID`.
- **Settings → Webhooks** → add `https://app.sketchcast.app/api/webhooks/lemonsqueezy`.
  In LS **you type your own signing secret** (it is NOT auto-generated) — use a
  long random string and put the SAME value in `LEMONSQUEEZY_WEBHOOK_SECRET`.
  Select the subscription **lifecycle** events: `subscription_created`,
  `subscription_updated`, `subscription_cancelled`, `subscription_resumed`,
  `subscription_paused`, `subscription_expired`; the order events for
  **credit packs**: `order_created` and `order_refunded`; and — **required
  since 0093, not optional** — the invoice events that carry subscription
  money: `subscription_payment_success` and `subscription_payment_refunded`
  (`subscription_payment_failed` / `_recovered` are recommended, so a delayed
  payment is recorded the moment it settles).
  > ⚠️ This bullet used to say the `subscription_payment_*` events were
  > *optional* because the handler ignored them. That was true and it was the
  > bug: **no subscription payment had ever reached the console**. Access flows
  > from `subscription_updated` (→ `past_due`/`unpaid`), but REVENUE does not —
  > a renewal produces an invoice and **no order at all**, so without these
  > events every recurring charge is invisible. Leaving them unsubscribed today
  > means "Collected to date" silently undercounts by the whole subscription
  > book.
- **Where subscription money comes from — invoices, never orders.** LS
  represents the *first* charge twice (an order **and** an invoice: order
  9261749 and invoice 8235804 are the same $11.79, field for field) and every
  later charge once (an invoice only). So `handleLsInvoiceEvent` books every
  subscription charge from `subscription_payment_success`, and `order_created`
  keeps **ignoring** subscription orders — that ignore is what makes it exactly
  once. Do not "fix" it. Credit packs are the other way round: they are orders,
  never invoices. Keys: `payments.ls_order_id` for packs,
  `payments.ls_invoice_id` for subscriptions — two LS id sequences in one
  numeric space, so they must never share a column.
- Enable the **Customer Portal** in the store so parents/teachers can manage
  and cancel their own subscription.

### How it flows — TWO purchase origins
```
PUBLIC pricing page (sketchcast.app/pricing) ─► LS hosted checkout (direct link)
   buyer may be LOGGED OUT · no custom_data · card at LS
                              │
IN-APP upgrade (rare) → POST /api/billing/checkout ─► LS hosted checkout
   authenticated · custom_data.{user_id, plan_key}
                              │
LS ──signed webhook (X-Signature, HMAC-SHA256)──► /api/webhooks/lemonsqueezy
      plan_key ← variant_id (trusted) · identity ← custom_data.user_id OR email
                              ├─► known user  → subscriptions + entitlements (access now)
                              └─► logged-out  → subscription PARKED by email (no access yet)
sign in with that verified email → claimLsPurchases() → entitlement created
manage → POST /api/billing/portal → fresh LS Customer Portal URL (24h-signed)
```
- **plan_key is derived from the trusted `variant_id`** on the subscription; the
  public checkout carries no `plan_key`. `custom_data.plan_key` is only a
  cross-checked fast-path (the variant wins on any mismatch).
- **Identity.** An authenticated in-app checkout sets `custom_data.user_id` — we
  trust and bind it. A public-link purchase carries no user and the buyer may be
  logged out, so the only signal is the LS **email**. We **never auto-bind a
  paid sub onto a pre-existing account from the webhook** (a buyer can type any
  email). Instead the subscription is **parked unclaimed** (`user_id` NULL,
  `claim_email` = the LS email) with **no entitlement** — money recorded, access
  withheld. When the account holder signs in with that Supabase-**verified**
  email, `claimLsPurchases()` binds the sub and creates the entitlement.
  Parked-but-unclaimed subs log `billing.ls.subscription_parked_unclaimed`
  (ops-visible); an unmapped variant logs `billing.ls.unmapped_variant`.
- **Revenue takes the same two-sided path, for the same reason.**
  `payments.user_id` is NOT NULL, so a parked purchase has nobody to attribute
  money to at webhook time. Every charge is therefore written twice over: the
  durable record first (`subscription_invoices` for subscriptions,
  `credit_purchases` for packs — written whether or not an owner is known), then
  the `payments` row either immediately (buyer already bound) or at **claim**
  time (`claimLsPurchases()`). Both writers price from ONE definition of "the
  amount" — `lsRevenueAmount()`, exported by `handlers.ts` — so "Collected to
  date" is a single series no matter which path recorded a sale. Every write
  tolerates 23505 as a no-op, because LS re-delivers, the recovered-payment pair
  fires twice for one charge, and the claim runs on every dashboard render.
- **Revenue is NET OF TAX** (founder, 2026-08-22). LS is Merchant of Record: it
  added $1.80 IGST to a $9.99 list price for an Indian buyer and remits that
  $1.80 itself, so the business never keeps it and it is not revenue. Amounts are
  MINOR UNITS of **`subtotal - discount_total`**, computed once by `lsNetOfTax()`
  at the webhook boundary and stored already-netted, so no other file does tax
  arithmetic:

  | LS object | subtotal | discount | tax | total | booked |
  |---|---|---|---|---|---|
  | invoice 8235804 (live sub) | 999 | 0 | 180 | 1179 | **999** |
  | order 9261766 (live pack) | 800 | 0 | 144 | 944 | **800** |
  | a FOUNDINGTEACHER order | 2400 | 1400 | 0 | 1000 | **1000** |

  Bare `subtotal` is wrong as often as `total` is — it is **before** the
  discount, so it would report $24 for a $10 founding sale. **The tax figure is
  discarded, never stored:** there is no tax column and none is to be added, so
  this database cannot answer "how much tax did LS remit for us" — that lives in
  Lemon Squeezy. `credit_purchases.total_minor` and
  `subscription_invoices.total_minor` keep names inherited from the gross era;
  0093 corrects their column comments and repairs the rows booked gross.

  **What the repair cannot see, because the tax was discarded rather than
  stored.** 0093 §4 spots a gross pack row by `stored > list` (`usd`, the
  catalogue price, is the only surviving evidence) — and that expands to
  `tax > discount`. So a gross row whose **discount beat its tax** sits at or
  below list and is *identical* to a correct net discounted sale: two unknowns,
  one equation, nothing in the schema to break the tie. Those rows are counted
  (`below_list`) and left alone rather than guessed at; settling one means
  pulling the LS receipt. The only way to create one is the window between
  applying the migration and deploying the app, while the old gross-writing
  handler still owns the endpoint — which is a third reason to keep that window
  short.
- **Shipping 0093 is three steps, not two.** Apply the migration → deploy the
  app → **re-run the migration** (or just its final
  `delete from public.webhook_events where id like 'ls!_subscription!_payment%'
  escape '!'`), and only then click *resend* in the LS dashboard. The delete
  releases the idempotency claims the old code stamped while it was throwing
  subscription payments away; between the migration and the deploy the OLD
  handler is still live, and anything it drops in that window re-stamps the very
  key that was just released, after which a resend is short-circuited as a
  duplicate and the charge is unrecoverable (its amount lives only in LS). The
  migration is inert on a second run in every other respect.
- Webhook is Node-runtime, raw-body HMAC-verified, idempotent via a constructed
  event key (LS has no persistent event id), monotonic (out-of-order-safe).
- Entitlement statuses: `on_trial`/`active`/`past_due`/`cancelled` keep access
  (`cancelled` until `ends_at`); `paused`/`unpaid`/`expired` revoke.

> **Deferred (product decision):** tier *capabilities* are not yet wired — the
> webhook stores the correct `plan_key`/`tier`, but the app does not yet grant
> Teacher Pro+ anything extra over Teacher Pro, nor cap Family by tier. Decide
> what each tier unlocks (seat/student caps, premium voices, book limits, Family
> child cap) and gate on `entitlement.plan_key`. Until then the three tiers
> unlock the same feature set.

### Founding places — the one PUBLIC billing-adjacent endpoint

`GET /api/public/founding-places` — how many of the capped Founding Teacher
places are gone. Unauthenticated by design: the static marketing site
(sketchcast.app/pricing) reads it cross-origin so its scarcity line can state a
**measured** number instead of a written-down one.

```
200 {"status":"ok","claimed":0,"max":50,"remaining":50,
     "source":"lemonsqueezy","asOf":"2026-08-19T…Z"}
200 {"status":"unknown"}          ← no numeric keys at all
```

- **Never 500.** Failure is a body, not a status code — a marketing page's fetch
  must not put a red line in a visitor's console.
- **`unknown` carries no numbers.** Not zeroes, not nulls. `0` is a publishable
  count; `unknown` is the absence of one, and the shapes must not be confusable
  — that is what makes a fabricated "0 of 50" impossible downstream.
- **Sources, in order:** LS `discount-redemptions` total (+ `max_redemptions`
  for the cap) → `count(subscriptions where is_founding)` (count only, no cap)
  → unknown. Never blended: the DB figure is a proxy that can lag a webhook.
- **The LS answer requires the discount to exist.** A redemption total alone is
  unfalsifiable — a deleted, mistyped or test-mode id also answers `0`, which
  reads exactly like a real zero. So `GET /discounts/{id}` must succeed (and,
  in production, must not be `test_mode`) before any count is published.
- **A cap below the count is dropped** (`max: null`): lowering `max_redemptions`
  after redemptions exist is a true pair that cannot be said in one sentence.
- **Timeouts** 2s per source; **cached** `s-maxage=300, stale-while-revalidate=86400`
  at the CDN plus a 60s in-process memo **and single-flight dedup** (concurrent
  cache misses share one resolve), so a busy — or hostile — pricing page never
  becomes an LS API amplifier. A `unknown` body is cached for 15s only, so a
  brief outage cannot pin a counter-less page in front of readers for minutes.
- **CORS** echoes one exact allow-listed origin (`src/utils/marketing/cors.ts`),
  never `*`, and grants no credentials.
- Logic + tests: `src/utils/lemonsqueezy/founding-places.ts`,
  `src/utils/lemonsqueezy/__tests__/founding-places.test.ts`.

### Local dev (Lemon Squeezy)
```bash
# LS has no CLI forwarder — use a tunnel (e.g. `ngrok http 3000`) and point a
# TEST-mode LS webhook at https://<tunnel>/api/webhooks/lemonsqueezy, or replay
# a captured payload with a correctly-computed X-Signature.
```

## Tax seam (deliberately out of scope for direct code)
No tax calc/registration logic lives in our code — on the LS path it's handled
by LS as MoR; on the Stripe path B2B buyers self-account. Nothing to build. The
one place tax touches code is **reporting**: LS's tax is subtracted out of every
booked amount (see the net-of-tax rule above) and then discarded, so it is never
calculated here, only dropped.

## Going live (later — NOT part of this build)
1. Aethel Twin's live Stripe account verified; swap `sk_live_...` keys.
2. Re-run the seed against live (or create live Prices in the Dashboard).
3. Live webhook endpoint + secret.
4. Dashboard settings above re-checked on the live account.
5. Flip `BILLING_ENABLED=true` (and set the price envs) in Vercel.
