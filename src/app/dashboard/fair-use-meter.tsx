import { createClient } from "@/utils/supabase/server";
import BuyCreditsReturn from "./buy-credits-return";
import BuyCreditsModal, { type BuyCreditsCopy, type UsageLine } from "./buy-credits-modal";
import { creditPacks, packsAllowedForTier, purchasablePacks, type CreditPack } from "@/utils/credit-packs";
import { getDictionary, type Dictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { htmlLang, type Locale } from "@/i18n/locales";
import { fmt } from "@/i18n/format";

// The fair-use meter — the transparent face of the monthly caps (0047).
// Reads my_fair_use() (SECURITY DEFINER, auth.uid()-scoped); the DB triggers
// are the real guard, this card is the honest mirror: used / cap / carried-
// over / reset date. Renders nothing for unlimited tiers (schools, console-
// blessed accounts) or when the migration isn't applied yet.
//
// It renders on three surfaces — the Library, Test Papers, and the parent home
// — so it resolves its OWN locale and dictionary rather than taking them as
// props. resolveLocale() and getDictionary() are both React-cached per request,
// so asking here costs nothing beyond what the page already paid, and a new
// call site needs no plumbing.
type Bucket = { cap: number; carry: number; used: number; available: number };
type FairUse = {
  tier: string;
  unlimited: boolean;
  /** 0059 shape: one pool — lessons. Docs ride free with their lesson. */
  credits?: Bucket;
  /** pre-0059 shape (deploy window): two pools. */
  parts?: Bucket;
  docs?: Bucket;
  /** 0060: the launch free-trial period — every feature, a period-total cap. */
  promo?: boolean;
  trial_ends?: string;
  resets_on: string;
  /** 0086 (homeschool release): the purchased-pack balance, once the metering
   * side exposes it. Shape defensively unknown until that lands — a number or
   * a bucket both read correctly, anything else is ignored. */
  purchased?: number | Partial<Bucket>;
};

type Messages = Dictionary["fairUse"];

// The used/cap figure is ONE message, not "{used} of {cap}" glued to a carried
// clause: where the carry-over phrase sits in the sentence is a translator's
// call, and in Arabic it moves.
//
// Lifted out of Row because the buy dialog quotes the same figure: the dialog's
// backdrop dims the meter, so the number that decides which pack to buy has to
// travel with it. One composer, so the two surfaces can never disagree about
// what this month looks like.
const usageText = (b: Bucket, t: Messages) =>
  b.carry > 0
    ? fmt(t.usageCarried, { used: b.used, cap: b.cap, carry: b.carry })
    : fmt(t.usage, { used: b.used, cap: b.cap });

function Row({ label, b, t }: { label: string; b: Bucket; t: Messages }) {
  const total = b.cap + b.carry;
  const pct = total > 0 ? Math.min(100, Math.round((b.used / total) * 100)) : 0;
  const low = b.available <= Math.max(2, Math.round(total * 0.1));
  return (
    <div className="flex items-center gap-3 min-w-0">
      <span className="text-xs text-[#5B6470] w-28 shrink-0">{label}</span>
      <div className="h-1.5 flex-1 rounded-full bg-[#EEF0EC] overflow-hidden">
        <div
          className={`h-full rounded-full ${low ? "bg-[#9A6400]" : "bg-[#0C8175]"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-xs tabular shrink-0 ${low ? "text-[#9A6400]" : "text-[#5B6470]"}`}>
        {usageText(b, t)}
      </span>
    </div>
  );
}

// The marketing site's plans page — the app itself has no pricing surface.
const PRICING_URL = "https://sketchcast.app/pricing";

// The card's one solid action. Whatever a given tier's honest next step is, it
// is a BUTTON now, not the bare underlined sentence it used to be: the founder's
// report (2026-08-19) was that the credit path was invisible, and half the cure
// is simply that the control reads as a control.
//
// min-height, never a fixed height. `h-9` pins 2.25rem, and btn-primary is an
// inline-flex box with no overflow rule, so a label wider than the pill wraps to
// two 20px lines and paints OUTSIDE its own dark background. That is not
// hypothetical: upgradeCta is a whole sentence ("Need more? See plans and
// pricing"), and measured at 375-390px — iPhone 12 through 15 — the French,
// Spanish and Portuguese translations each need ~310px against ~285px of card,
// while at 320px English wraps too, and ar/te are worse again because
// globals.css raises their --text-sm--line-height to 1.65/1.75. The old markup
// was an inline-block text link, where wrapping was harmless; promoting it to a
// pill is what made the height load-bearing. A floor plus real vertical padding
// lets the pill grow instead of spilling. whitespace-nowrap would NOT be the
// fix — it only trades a vertical overflow for a horizontal one.
const BTN_PRIMARY = "btn-primary min-h-[2.25rem] px-4 py-1.5 text-sm text-center";

/** The strings the client dialog needs, copied out FIELD BY FIELD rather than
 * spread. dict.fairUse is a server-side object; listing the ten keys by hand is
 * what guarantees that a future key added to the meter is not silently shipped
 * into the browser bundle by a `{...t}` nobody re-read. */
function buyCopy(t: Messages): BuyCreditsCopy {
  return {
    buyTitle: t.buyTitle,
    buyHint: t.buyHint,
    buyNewTab: t.buyNewTab,
    buyClose: t.buyClose,
    packCredits: t.packCredits,
    packPrice: t.packPrice,
    packKitsOne: t.packKitsOne,
    packKitsMany: t.packKitsMany,
    packLabel: t.packLabel,
    purchased: t.purchased,
  };
}

/**
 * The meter's action row. Exactly one solid button, chosen by what this account
 * can honestly do next: "Buy credits" for a paying tier whose packs have live
 * checkouts, the plans page for an account that does not pay yet.
 *
 * WHAT REPLACED WHAT. The packs used to hide inside a <details>Buy credits</…>
 * disclosure and the plans link was a bare underlined sentence under the bar —
 * a footnote and a footnote. The disclosure is gone; the packs moved into
 * BuyCreditsModal and the choice of pack now happens in a dialog instead of on
 * this strip, which keeps the meter card the same calm height it always was.
 *
 * ═══ WHY A SUBSCRIBER IS NOT OFFERED A "CHANGE PLAN" BUTTON ═══
 * A first pass at this row gave every paying tier a second, outline button to
 * PRICING_URL labelled "Change plan". It was removed, and the tier rule below
 * restores the pre-2026-08-19 behaviour deliberately, because that button could
 * not do what its label said and could cost the buyer real money:
 * sketchcast.app/pricing is the MARKETING page. Its wireCard() points every CTA
 * at a Lemon Squeezy hosted checkout once the launch trial's endsAt has passed
 * (it has), so the only controls a Teacher Pro subscriber finds there are
 * "Choose Teacher Pro+" and friends — each of which opens a NEW subscription
 * alongside the one they already pay for. Downgrading or cancelling is not on
 * that page at all, and pro_plus/homeschool have nothing above them to buy.
 *
 * The right destination already exists and has no UI caller anywhere in src/:
 * POST /api/billing/portal returns a fresh Lemon Squeezy (or Stripe, for
 * schools) customer-portal URL for the caller's own subscription, which is
 * where a plan is actually changed or cancelled. Wiring it is a small feature,
 * not a copy tweak — it needs a client control, a failure path for accounts
 * with no billing_customers row (console-comped tiers), and a decision about
 * navigating away vs opening a tab (an `await` before window.open loses
 * transient activation and Safari blocks the popup — this codebase has been
 * bitten by activation loss before). Until that lands, a paying tier sees only
 * "Buy credits". Do not re-point this at the marketing page in the meantime.
 *
 * WHY BuyCreditsReturn STILL WRAPS EVERYTHING. Its whole mechanism is a native
 * click listener on its own container that arms when the click landed inside
 * `a[href]`; on the buyer's return it calls router.refresh() so the dashboard
 * layout re-runs claimLsPurchases() and the credits appear. The pack anchors now
 * live inside the dialog — so the dialog is rendered INLINE, as a child of this
 * wrapper, and `position: fixed` moves it out of flow WITHOUT moving it out of
 * the DOM subtree. The arming click therefore still bubbles through the
 * container exactly as before. A React portal (or a top-layer <dialog>) would
 * detach the anchors from the listener and silently reintroduce the "I paid and
 * nothing happened" bug; buy-credits-modal.tsx says so at the top of the file
 * so the next person to reach for createPortal reads it first.
 *
 * The upgrade link is deliberately OUTSIDE the wrapper: it is also an
 * `a[href]`, so putting it inside would arm the refresh on every trip to the
 * pricing page — harmless but pointless work on every return to the tab.
 */
function MeterActions({
  packs,
  purchased,
  usage,
  paidTier,
  t,
}: {
  packs: CreditPack[];
  purchased: number;
  usage: UsageLine | null;
  /** packsAllowedForTier(fu.tier) — "this account already pays for a plan".
   *  Passed rather than re-derived so the tier vocabulary stays in one place,
   *  and kept SEPARATE from `packs.length`: a paying tier whose LS products are
   *  not configured yet has no packs either, and must still not be sent to a
   *  checkout page for a plan it is already on. */
  paidTier: boolean;
  t: Messages;
}) {
  const canBuy = packs.length > 0;
  // A subscriber whose packs are dark has no honest action here at all — the
  // meter still tells them where they stand, which is what it is for.
  if (paidTier && !canBuy) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      {canBuy && (
        // display:contents — the wrapper must exist in the DOM (it carries the
        // listener) but must not become a flex item, or it would box the button
        // out of the row's alignment. It changes box generation only; event
        // bubbling through it is untouched, which is the whole point.
        <BuyCreditsReturn className="contents">
          <BuyCreditsModal packs={packs} purchased={purchased} usage={usage} t={buyCopy(t)} />
        </BuyCreditsReturn>
      )}
      {/* Only for accounts that do not pay yet — post-trial free, and any tier
          my_fair_use() names that we cannot place (fail open to "show them the
          plans", never to "sell them a top-up"). For those the marketing page
          is exactly right: they have no subscription for its checkout to
          collide with. See the block comment above for why a subscriber does
          NOT get this link. */}
      {!paidTier && (
        <a href={PRICING_URL} target="_blank" rel="noreferrer" className={BTN_PRIMARY}>
          {t.upgradeCta}
        </a>
      )}
    </div>
  );
}

export default async function FairUseMeter() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("my_fair_use");
  if (error || !data) return null; // pre-0047 DB or signed-out — show nothing
  const fu = data as FairUse;
  if (fu.unlimited) return null;

  const locale: Locale = await resolveLocale();
  const dict = await getDictionary(locale);
  const t = dict.fairUse;

  // Credit packs (homeschool release): a one-time top-up for tiers that
  // already pay; trial/promo get the plans link instead — a pack must never be
  // a way to generate without ever subscribing. purchasablePacks drops any
  // pack whose LS product (checkout URL) doesn't exist yet, so this whole
  // affordance ships dark until the founder creates the products.
  const paidTier = packsAllowedForTier(fu.tier);
  const packs = paidTier ? purchasablePacks(creditPacks()) : [];

  // Purchased balance — shown only when > 0. my_fair_use() reports it as
  // fu.purchased.available since 0086: total non-refunded credit_purchases
  // minus non-voided purchase-sourced ledger rows (the DB consumes the
  // monthly quota FIRST, then this balance — the meter just mirrors it). A
  // pre-0086 DB has no `purchased` key AND no credit_purchases table, so no
  // pack can exist and 0 is the truth, not a fallback.
  let purchased = 0;
  if (typeof fu.purchased === "number") purchased = fu.purchased;
  else if (fu.purchased && typeof fu.purchased.available === "number") purchased = fu.purchased.available;
  // The month/day reads in the reader's own language and order — "1 Sept" is
  // not how every locale writes a date.
  const lang = htmlLang(locale);
  const dateLabel = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString(lang, { month: "short", day: "numeric" });

  // Launch free-trial period (0060): every feature unlocked, a single
  // period-total budget of lessons that ends on the trial date (no monthly
  // reset, no rollover). Framed as a trial, not a monthly meter.
  if (fu.promo && fu.credits) {
    return (
      <section className="card px-5 py-3.5 mb-6 space-y-2 border-[#BDE8E2] bg-[#F1FBF9]" data-tour="fair-use">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-[#0C8175]">{t.trialTitle}</span>
          {fu.trial_ends && (
            <span className="text-[10px] text-[#98A0A9]">
              {fmt(t.trialEnds, { date: dateLabel(fu.trial_ends) })}
            </span>
          )}
        </div>
        <Row label={t.trialLessons} b={fu.credits} t={t} />
        <p className="text-[10px] text-[#98A0A9]">
          {fu.credits.available > 0
            ? fmt(t.trialLeft, { available: fu.credits.available, cap: fu.credits.cap })
            : fmt(t.trialSpent, { cap: fu.credits.cap })}
        </p>
        {/* Trial accounts can't buy packs — packsAllowedForTier() refuses promo
            and trial outright, because a pack must never become a way to keep
            generating without ever subscribing. So there is no buy affordance
            here at all, and the plans button is the prominent one. */}
        <div className="pt-1">
          <a href={PRICING_URL} target="_blank" rel="noreferrer" className={BTN_PRIMARY}>
            {t.upgradeCta}
          </a>
        </div>
      </section>
    );
  }

  return (
    <section className="card px-5 py-3.5 mb-6 space-y-2" data-tour="fair-use">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[#14181F]">{t.title}</span>
        <span className="text-[10px] text-[#98A0A9]">{fmt(t.resets, { date: dateLabel(fu.resets_on) })}</span>
      </div>
      {fu.credits ? (
        <>
          <Row label={t.lessons} b={fu.credits} t={t} />
          <p className="text-[10px] text-[#98A0A9]">{t.kitFree}</p>
        </>
      ) : (
        // Pre-0059 DB (deploy window): the old two-pool shape.
        <>
          {fu.parts && <Row label={t.parts} b={fu.parts} t={t} />}
          {fu.docs && <Row label={t.documents} b={fu.docs} t={t} />}
        </>
      )}
      {/* Purchased packs outlive the month, so they sit OUTSIDE the monthly
          row — a separate line that only appears once there is a balance. */}
      {purchased > 0 && (
        <p className="text-[10px] text-[#0C8175]">{fmt(t.purchased, { n: purchased })}</p>
      )}
      {/* The decision, visible on the card itself. `packs` is already empty for
          every tier that may not buy (packsAllowedForTier) and for every pack
          without a checkout URL (purchasablePacks); `paidTier` is the same tier
          rule, passed separately so the row can tell "may not buy" apart from
          "nothing to buy yet". The usage line rides along because the dialog's
          backdrop hides the meter that was showing it. */}
      <MeterActions
        packs={packs}
        purchased={purchased}
        usage={fu.credits ? { label: t.lessons, value: usageText(fu.credits, t) } : null}
        paidTier={paidTier}
        t={t}
      />
    </section>
  );
}
