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
| `family_monthly` / `family_annual` | Lemon Squeezy | family | monthly / yearly | parents (any adult) |
| `school_annual` | Stripe | school | yearly | school admins (card) |
| `school_onetime` | Stripe | school | 365-day licence | school admins (card) |

Each LS **product** (Teacher Pro, Teacher Pro+, Family) serves both cycles on one
hosted-checkout page; the six `plan_key`s map 1:1 to LS **variant ids** (via env).
The public pricing page carries no `plan_key`, so the webhook derives it from the
subscription's `variant_id` — see `planKeyForVariant()` in `plans.ts`.

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
- Create three **subscription products** priced in **USD**, each with a Monthly
  and an Annual variant: **Teacher Pro** ($24 / $240), **Teacher Pro+** ($49 /
  $490), **Family** ($9.99 / $99). Copy the six **Variant IDs** into the six
  `LEMONSQUEEZY_VARIANT_*` env vars (below). The webhook maps a subscription's
  `variant_id` back to a `plan_key`, so these must match the live store.
- Create the founding discount code **`FOUNDINGTEACHER`** on the Teacher Pro
  product (→ $10/mo, price-locked 24 months). It is a *discount*, not a separate
  product — the public pricing page shows the code and tells teachers to paste
  it at checkout. The webhook flags such subs `is_founding` (same access as
  Teacher Pro, tracked for grandfathering).
- **Settings → API** → create an API key → `LEMONSQUEEZY_API_KEY`. Copy the
  **Store ID** → `LEMONSQUEEZY_STORE_ID`.
- **Settings → Webhooks** → add `https://app.sketchcast.app/api/webhooks/lemonsqueezy`.
  In LS **you type your own signing secret** (it is NOT auto-generated) — use a
  long random string and put the SAME value in `LEMONSQUEEZY_WEBHOOK_SECRET`.
  Select the subscription **lifecycle** events: `subscription_created`,
  `subscription_updated`, `subscription_cancelled`, `subscription_resumed`,
  `subscription_paused`, `subscription_expired`. Payment health already flows
  through `subscription_updated` (→ `past_due`/`unpaid`), so the
  `subscription_payment_*` events are optional; the handler ignores
  invoice-shaped events (`data.type = "subscription-invoices"`) either way, so
  subscribing to them is harmless but unnecessary.
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

### Local dev (Lemon Squeezy)
```bash
# LS has no CLI forwarder — use a tunnel (e.g. `ngrok http 3000`) and point a
# TEST-mode LS webhook at https://<tunnel>/api/webhooks/lemonsqueezy, or replay
# a captured payload with a correctly-computed X-Signature.
```

## Tax seam (deliberately out of scope for direct code)
No tax calc/registration logic lives in our code — on the LS path it's handled
by LS as MoR; on the Stripe path B2B buyers self-account. Nothing to build.

## Going live (later — NOT part of this build)
1. Aethel Twin's live Stripe account verified; swap `sk_live_...` keys.
2. Re-run the seed against live (or create live Prices in the Dashboard).
3. Live webhook endpoint + secret.
4. Dashboard settings above re-checked on the live account.
5. Flip `BILLING_ENABLED=true` (and set the price envs) in Vercel.
