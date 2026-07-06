# SketchCast Billing (Stripe) — Setup & Operations

**Merchant: Aethel Twin Sdn. Bhd. (Malaysia).** One Stripe account, settling
**MYR** to a Malaysian bank. SketchCast is the product line. Hosted Checkout +
Billing Customer Portal only — **card data never touches our servers, logs, or
database** (we store Stripe IDs and statuses only), keeping us out of PCI-DSS
scope.

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
| plan_key | mode | interval | who |
|---|---|---|---|
| `parent_monthly` | subscription | monthly | parents |
| `teacher_monthly` | subscription | monthly | teachers |
| `school_annual` | subscription | yearly | school admins (card) |
| `school_onetime` | one-off payment | 365-day licence | school admins (card) |

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
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PARENT_MONTHLY=price_...
STRIPE_PRICE_TEACHER_MONTHLY=price_...
STRIPE_PRICE_SCHOOL_ANNUAL=price_...
STRIPE_PRICE_SCHOOL_ONETIME=price_...
BILLING_ENABLED=false
APP_URL=https://app.sketchcast.app
# plus the existing Supabase vars (service key is used for webhook writes)
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

## Tax seam (deliberately out of scope)
No tax calculation/registration logic is included (OIDAR/GST/VAT/MoR is a
future decision). When that day comes, the seam is checkout-session creation
(`src/app/api/billing/checkout/route.ts`) — add `automatic_tax` or a tax-rate
lookup there; nothing else needs to change.

## Going live (later — NOT part of this build)
1. Aethel Twin's live Stripe account verified; swap `sk_live_...` keys.
2. Re-run the seed against live (or create live Prices in the Dashboard).
3. Live webhook endpoint + secret.
4. Dashboard settings above re-checked on the live account.
5. Flip `BILLING_ENABLED=true` (and set the price envs) in Vercel.
