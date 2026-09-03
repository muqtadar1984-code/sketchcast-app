import { createClient } from "@/utils/supabase/server";
import BuyCreditsReturn from "./buy-credits-return";
import BuyCreditsModal, { type BuyCreditsCopy, type UsageLine } from "./buy-credits-modal";
import RequestActivationButton from "./request-activation-button";
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
  /** 0100: a self-serve school inside its 30-day trial — same period-total
   * shape as promo, under its own flag so the next step reads "ask us to
   * activate", never "subscribe". */
  school_trial?: boolean;
  /** 0100: school_expired / school_suspended — generation is blocked, everything
   * made stays readable. The bucket arrives as zeros. */
  locked?: boolean;
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

/** THE ONE PLACE THE CARD ANSWERS "how many more can I generate right now",
 * shared by the bar's segment widths, the amber warning, and the total-available
 * sentence so those three can never disagree.
 *
 * IT REPRODUCES enforce_fair_use EXACTLY, and the subtlety it exists for is that
 * the RPC payload does NOT. my_fair_use() returns `greatest(0, c.available)`
 * (0086), while fair_use_avail computes available = cap + carry - used
 * UNCLAMPED (0059) and the trigger gates on that raw, possibly-NEGATIVE value:
 *   if a.available < 1 and a.available + fair_use_purchased_remaining(...) < 1
 * The value goes negative for real: a chapter lesson is charged WHOLE to
 * whichever pool had any room left (the bounded one-chapter overshoot 0047
 * accepted by design), so 11 used of a cap of 12 plus a four-part chapter leaves
 * used = 15 and a raw available of -3. Reading the clamped 0 and adding a 6-pack
 * would promise 6 more generations where the database admits 3 — and would keep
 * the meter calm teal through the whole overstated window. The overdraft is a
 * genuine claim on the purchased pool, so it is subtracted there.
 *
 * `used`, `cap` and `carry` all ride in the payload, so the raw figure is
 * reconstructible with no migration and no new RPC field. */
function spendable(b: Bucket, purchased: number) {
  const monthly = b.cap + b.carry; // this month's allowance, carry-over included
  const overdraft = Math.max(0, b.used - monthly); // already charged against the purchased pool
  const monthlyLeft = Math.max(0, monthly - b.used); // === b.available (the clamped figure)
  const purchasedLeft = Math.max(0, purchased - overdraft);
  return { monthly, monthlyLeft, purchasedLeft, total: monthlyLeft + purchasedLeft };
}

/** The purchased pool's fill — deliberately NOT another flat colour.
 *
 * Same teal family, because these are the same currency as the monthly
 * allowance, but hatched, because they behave differently: they were paid for
 * separately and they do not reset. A texture rather than a second hue survives
 * greyscale and colour-blindness, and it cannot be mistaken for "more of the
 * same bar" the way a lighter teal could. The same fill paints the legend swatch
 * next to the purchased line below, which is what ties the two together without
 * needing a colour name in any of ten languages. */
const PURCHASED_FILL =
  "repeating-linear-gradient(135deg, #0C8175, #0C8175 3px, #8ED6CD 3px, #8ED6CD 6px)";

/**
 * One meter row. The bar spans MONTHLY ALLOWANCE + PURCHASED BALANCE, in that
 * order, as two visually distinct regions.
 *
 * ═══ WHY NOT ONE MERGED "0 of 18" ═══
 * Because the two pools have different lifetimes and merging them would lie
 * about paid credits once a month. The monthly allowance RESETS (the card says
 * "resets Sep 1") and carry-over rolls exactly one month forward; purchased
 * credits NEVER expire, and the database spends the monthly quota FIRST and
 * only then dips into the purchased pool (fair_use_purchased_remaining +
 * enforce_fair_use). A single "0 of 18" would therefore fall to "0 of 12" on the
 * 1st and read as though six PAID credits had vanished — a support ticket, and a
 * deserved one. Two segments in one bar say "these are all yours to spend" and
 * "these two things are not the same thing" at once, which is the whole point.
 *
 * The number on the right stays the MONTHLY figure. It is what "resets {date}"
 * refers to, and the buy dialog quotes the same composer (usageText), so
 * changing it here would silently change what the dialog claims.
 */
function Row({ label, b, t, purchased = 0 }: { label: string; b: Bucket; t: Messages; purchased?: number }) {
  const { monthly, monthlyLeft, purchasedLeft } = spendable(b, purchased);
  const span = monthly + purchased; // the full width the bar represents
  // Spent is clamped at the SPAN, not at `monthly`. A multi-unit kit is charged
  // whole to whichever pool had room left (0086), so `used` can overshoot the
  // monthly pool — and when it does those purchased credits really are
  // committed: enforce_fair_use settles the overdraft out of the purchased
  // balance before admitting the next generation. Stopping the spent segment at
  // `monthly` would draw the hatched region at full width while the number
  // beside it said three were left. Everything below derives from the same
  // spendable() split, so the picture and the figures cannot diverge.
  const spent = Math.min(b.used, span);
  const pct = (v: number) => (span > 0 ? (v / span) * 100 : 0);
  // "Low" means low on EVERYTHING that can actually be spent. Warning a
  // subscriber who is holding 36 purchased credits that they are nearly out
  // would be false, and the amber was only ever there to say "you are about to
  // be blocked" — so it has to use the figure the trigger uses.
  const low = monthlyLeft + purchasedLeft <= Math.max(2, Math.round(monthly * 0.1));
  return (
    // WRAPS ON A PHONE, and the bar is what moves. The label is w-28 (112px) and
    // the usage figure is a whole clause ("0 of 12 +12 carried" ≈ 130px in
    // JetBrains Mono at text-xs); inside the dashboard's own box — max-w-7xl
    // px-6 minus the card's px-5 — a 375px viewport leaves the row 287px, so a
    // flex-1 bar between two shrink-0 neighbours collapsed to ~15-25px. A bar
    // that narrow cannot show two segments: the purchased region measured ~3px,
    // less than one cycle of the 6px hatch, so it read as a solid nub. Giving
    // the bar its own full-width line below the label/figure pair (order-last +
    // basis-full, only below sm) restores the whole 287px and with it the whole
    // point of the second segment. Unchanged from sm up.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 min-w-0">
      <span className="text-xs text-[#5B6470] w-28 shrink-0">{label}</span>
      {/* flex, not one nested fill: the segments sit side by side and the track
          (#EEF0EC) shows through the untouched middle one. overflow-hidden on
          the rounded parent is what gives whichever segment lands at each end
          its cap, so the bar keeps its shape at every ratio. */}
      <div className="order-last basis-full sm:order-none sm:basis-auto h-1.5 flex-1 rounded-full bg-[#EEF0EC] overflow-hidden flex">
        <div
          className={`h-full shrink-0 ${low ? "bg-[#9A6400]" : "bg-[#0C8175]"}`}
          style={{ width: `${pct(spent)}%` }}
        />
        {/* the monthly allowance still unspent — track colour, no fill */}
        <div className="h-full shrink-0" style={{ width: `${pct(monthlyLeft)}%` }} />
        {purchasedLeft > 0 && (
          <div
            className="h-full shrink-0"
            style={{ width: `${pct(purchasedLeft)}%`, backgroundImage: PURCHASED_FILL }}
          />
        )}
      </div>
      {/* ms-auto, NOT ml-auto: on the wrapped mobile line this is what pushes
          the figure to the far end of the row, and "the far end" is the LEFT in
          Arabic and Jawi. margin-inline-start flips with the direction; a
          physical margin-left would strand the figure mid-row in RTL. */}
      <span className={`text-xs tabular shrink-0 ms-auto sm:ms-0 ${low ? "text-[#9A6400]" : "text-[#5B6470]"}`}>
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
// The school cards' second action (0100): the same address the marketing
// site's school CTA has always used — a school's next step is a conversation.
const BTN_GHOST = "btn-ghost min-h-[2.25rem] px-4 py-1.5 text-sm text-center";
const CONTACT_MAILTO = "mailto:sales@sketchcast.app";

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
  // The SPENDABLE split of that balance — see spendable(). `purchased` above is
  // the pool's stored balance and is what decides whether this account has a
  // purchased pool AT ALL (the render guards below); `avail` is what it can
  // actually spend right now, which is the only honest thing to put next to the
  // word "available". They differ only while the monthly pool is overdrawn, and
  // the guards stay on the stored balance so a fully-committed pack still shows
  // itself rather than silently disappearing from the card.
  const avail = fu.credits ? spendable(fu.credits, purchased) : null;
  // The month/day reads in the reader's own language and order — "1 Sept" is
  // not how every locale writes a date.
  const lang = htmlLang(locale);
  const dateLabel = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString(lang, { month: "short", day: "numeric" });

  // 0100: a school whose trial ended, or a suspended school. The DB refuses
  // every generation; this card says why and offers the one honest next step.
  // No plans link and no packs: a school does not subscribe on the marketing
  // page, it gets activated by us. The card is the dashboard's banner for
  // these states — it sits on every surface the meter does.
  if (fu.locked) {
    const suspended = fu.tier === "school_suspended";
    return (
      <section className="card px-5 py-3.5 mb-6 space-y-2 border-[#F3D3C8] bg-[#FFF6F2]" data-tour="fair-use">
        <span className="text-xs font-medium text-[#B3401F]">
          {suspended ? t.schoolSuspendedTitle : t.schoolExpiredTitle}
        </span>
        <p className="text-[10px] text-[#5B6470]">{suspended ? t.schoolSuspendedBody : t.schoolExpiredBody}</p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {/* Suspension is ours to lift, not theirs to request — contact only. */}
          {!suspended && (
            <RequestActivationButton label={t.requestActivation} done={t.activationRequested} className={BTN_PRIMARY} />
          )}
          <a href={CONTACT_MAILTO} className={BTN_GHOST}>
            {t.contactUs}
          </a>
        </div>
      </section>
    );
  }

  // 0100: the school trial — promo's shape (a period budget with an end date),
  // school's words. The next step is "ask us to activate", never "subscribe".
  if (fu.school_trial && fu.credits) {
    return (
      <section className="card px-5 py-3.5 mb-6 space-y-2 border-[#BDE8E2] bg-[#F1FBF9]" data-tour="fair-use">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-[#0C8175]">{t.schoolTrialTitle}</span>
          {fu.trial_ends && (
            <span className="text-[10px] text-[#98A0A9]">
              {fmt(t.trialEnds, { date: dateLabel(fu.trial_ends) })}
            </span>
          )}
        </div>
        <Row label={t.trialLessons} b={fu.credits} t={t} />
        <p className="text-[10px] text-[#98A0A9]">
          {fu.credits.available > 0
            ? fmt(t.schoolTrialLeft, { available: fu.credits.available, cap: fu.credits.cap })
            : fmt(t.schoolTrialSpent, { cap: fu.credits.cap })}
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <RequestActivationButton label={t.requestActivation} done={t.activationRequested} className={BTN_PRIMARY} />
          <a href={CONTACT_MAILTO} className={BTN_GHOST}>
            {t.contactUs}
          </a>
        </div>
      </section>
    );
  }

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
          {/* Purchased credits are ON the meter now, as the bar's second
              segment — see Row for why they are a segment and not merged into
              the monthly total. */}
          <Row label={t.lessons} b={fu.credits} t={t} purchased={purchased} />
          <p className="text-[10px] text-[#98A0A9]">{t.kitFree}</p>
        </>
      ) : (
        // Pre-0059 DB (deploy window): the old two-pool shape. No purchased
        // segment here on purpose — packs are 0086, so a DB old enough to
        // report this shape has no credit_purchases table for a balance to come
        // from, and the lines below still state the balance in words if one
        // somehow exists.
        <>
          {fu.parts && <Row label={t.parts} b={fu.parts} t={t} />}
          {fu.docs && <Row label={t.documents} b={fu.docs} t={t} />}
        </>
      )}
      {/* THE ANSWER TO "what can I generate right now" — monthly available +
          carried + purchased, as one number, because that is the question the
          bar alone cannot answer once it has two segments. Rendered ONLY when a
          balance exists, which keeps the meter byte-for-byte unchanged for the
          overwhelming majority of accounts (and keeps the one English-only
          string off their screens entirely).

          <bdi> because the string carries numbers into a sentence that renders
          in English inside an RTL page until the next translation round — the
          same wrapping the buy dialog's number-carrying strings use, for the
          same reason.

          The purchased LINE keeps its own swatch, painted from the same fill as
          the bar segment: that is what makes the hatched region self-explaining
          without naming a colour in ten languages. And the non-expiry statement
          is fairUse.buyHint — already written, already translated everywhere,
          and already the exact sentence required ("They never expire — your
          monthly allowance is used first"). Reused rather than re-authored so
          no reader of Telugu or Jawi meets a new English sentence on the card. */}
      {purchased > 0 && (
        <div className="space-y-1 pt-0.5">
          {avail && (
            <p className="text-[11px] font-medium text-[#14181F]">
              <bdi>
                {fmt(t.availableNow, {
                  n: avail.total,
                  monthly: avail.monthlyLeft,
                  purchased: avail.purchasedLeft,
                })}
              </bdi>
            </p>
          )}
          <p className="flex items-center gap-1.5 text-[10px] text-[#0C8175]">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-3 shrink-0 rounded-[2px]"
              style={{ backgroundImage: PURCHASED_FILL }}
            />
            <bdi>{fmt(t.purchased, { n: avail ? avail.purchasedLeft : purchased })}</bdi>
          </p>
          <p className="text-[10px] text-[#98A0A9]">{t.buyHint}</p>
        </div>
      )}
      {/* The decision, visible on the card itself. `packs` is already empty for
          every tier that may not buy (packsAllowedForTier) and for every pack
          without a checkout URL (purchasablePacks); `paidTier` is the same tier
          rule, passed separately so the row can tell "may not buy" apart from
          "nothing to buy yet". The usage line rides along because the dialog's
          backdrop hides the meter that was showing it. */}
      <MeterActions
        packs={packs}
        // The SPENDABLE figure, not the stored balance: the dialog prints the
        // same fairUse.purchased string the card does, over a backdrop that
        // hides the card, so the two must never quote different numbers.
        purchased={avail ? avail.purchasedLeft : purchased}
        usage={fu.credits ? { label: t.lessons, value: usageText(fu.credits, t) } : null}
        paidTier={paidTier}
        t={t}
      />
    </section>
  );
}
