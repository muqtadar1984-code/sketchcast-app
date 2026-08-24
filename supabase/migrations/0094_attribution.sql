-- 0094_attribution.sql — persist the two attribution signals already arriving.
--
-- Neither of these is new data. Both are already being delivered and discarded:
-- Lemon Squeezy stamps affiliate_id + referral_amount on every order and every
-- invoice, and nothing has ever written them down. The console financials page
-- was built to read them and has rendered a dash since the day it shipped.
--
-- ── payments.affiliate_id / referral_amount_minor ──────────────────────────
-- The financials page already SELECTs both names, through a deliberately
-- ISOLATED probe query: PostgREST 42703s the WHOLE select on one unknown
-- column, so putting these in the main payments select would have taken
-- "Collected to date" down with them. That probe is what makes this migration
-- a pure addition — affiliateCac() starts computing with no page change.
--
-- Both NULLABLE by construction, and NULL means "not known", never "zero
-- commission":
--   · a direct (non-referred) sale genuinely has no affiliate, and
--   · every row written before this migration has no answer that can be
--     recovered — LS sent the fields, the webhook dropped them, they are gone.
-- affiliateCac() filters on non-null precisely so those two cases cannot be
-- averaged together into a fake CAC.

alter table public.payments
  add column if not exists affiliate_id text,
  add column if not exists referral_amount_minor integer;

comment on column public.payments.affiliate_id is
  'Lemon Squeezy affiliate credited with this sale, or NULL for a direct sale. Stamped from the order/invoice attributes by the LS webhook (0094). NULL on every pre-0094 row means NOT KNOWN, never "no affiliate".';

comment on column public.payments.referral_amount_minor is
  'Commission LS paid the affiliate on this sale, MINOR UNITS. UNIT UNVERIFIED AGAINST A REAL REFERRED SALE: every LS money field on the same objects (subtotal/total/tax) is minor units, and referral_amount is stored on that assumption, but referral_amount has been null on all sales to date so it has never been observed. The open question of whether LS commissions the DISCOUNTED or the LIST price is settled by the same one test: self-refer a discounted purchase and read this column.';

-- ── the same two columns on the DURABLE rows ───────────────────────────────
-- payments alone would have captured nothing in practice. A pack's webhook
-- branch that writes payments directly needs an already-bound user, and the
-- handler's own comment records that this "effectively never runs" — PARKED is
-- the only path a pack actually takes today. The real writer is claim.ts, which
-- books from credit_purchases / subscription_invoices long after the webhook
-- has returned and the LS payload is gone.
--
-- So the affiliate has to be captured where the durable row is FIRST written
-- (that is the only moment the payload exists) and carried across the claim,
-- exactly as amount/currency already are. Same nullability contract as above.

alter table public.credit_purchases
  add column if not exists affiliate_id text,
  add column if not exists referral_amount_minor integer;

alter table public.subscription_invoices
  add column if not exists affiliate_id text,
  add column if not exists referral_amount_minor integer;

comment on column public.credit_purchases.affiliate_id is
  'LS affiliate credited with this pack order, captured at webhook time because the payload is gone by the time claim.ts books it. Copied to payments.affiliate_id on claim. NULL = direct sale, or a pre-0094 row.';

comment on column public.subscription_invoices.affiliate_id is
  'LS affiliate credited with this invoice, captured at webhook time and copied to payments.affiliate_id on claim. NULL = direct sale, or a pre-0094 row.';

-- ── profiles.signup_source ─────────────────────────────────────────────────
-- Where this account came from, resolved on FIRST TOUCH and written once.
--
-- A COLUMN, not a key in profiles.profile, for a concrete reason: /api/onboarding
-- replaces that jsonb WHOLESALE with a whitelisted object, so anything stored
-- there would survive right up until the user finished onboarding and then
-- silently vanish — losing the value for exactly the users who became real
-- accounts. A column is also groupable, which is the entire point of collecting
-- it.
--
-- NOT granted to `authenticated`. Every other profiles column the user may edit
-- is something they are stating about themselves (country, full_name,
-- ui_locale); this is something we observed about them, and it is written by
-- /api/attribution with the service role. Leaving it out of the grant means a
-- user cannot rewrite their own provenance.
--
-- 'direct' is a REAL and common value, not a null-ish one: assistants and
-- WhatsApp forwards send no referrer at all, so the largest channels land here.
-- Read it as "no signal", never as "typed the URL in".

alter table public.profiles
  add column if not exists signup_source text;

comment on column public.profiles.signup_source is
  'First-touch origin, written once by /api/attribution and never revised. utm:<x> = a link we tagged; a bare name (chatgpt, google, linkedin) = a recognised referrer; a bare domain = an unrecognised one; ''direct'' = NO SIGNAL, which is what assistants and messenger forwards look like, not a direct navigation. NULL on every pre-0094 account. Corroborates the self-reported profile->>''heard_from'', it does not replace it.';
