import { createClient } from "@/utils/supabase/server";
import BuyCreditsReturn from "./buy-credits-return";
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
        {b.carry > 0
          ? fmt(t.usageCarried, { used: b.used, cap: b.cap, carry: b.carry })
          : fmt(t.usage, { used: b.used, cap: b.cap })}
      </span>
    </div>
  );
}

// The marketing site's plans page — the app itself has no pricing surface.
const PRICING_URL = "https://sketchcast.app/pricing";

/** The one-time pack list (paid tiers only). Renders nothing while no pack has
 * a checkout URL — the LS products ship dark until the founder creates them. */
function BuyCredits({ packs, t }: { packs: CreditPack[]; t: Messages }) {
  if (!packs.length) return null;
  const kitsLabel = (kits: number) =>
    kits === 1 ? fmt(t.packKitsOne, { n: kits }) : fmt(t.packKitsMany, { n: kits });
  return (
    <details>
      <summary className="cursor-pointer select-none text-xs font-medium text-[#0C8175] hover:underline">
        {t.buyTitle}
      </summary>
      <div className="mt-1.5 space-y-1">
        <p className="text-[10px] text-[#98A0A9]">{t.buyHint}</p>
        {/* The chips are plain links to the LS hosted checkout, opened in a new
            tab — so the app tab never reloads and the layout's claim-on-render
            never runs when the buyer comes back. BuyCreditsReturn watches for
            that return and refreshes the route so the credits appear; see its
            header. It is a wrapper, not a rewrite: the anchors stay server-
            rendered and keep working with JS disabled. */}
        <BuyCreditsReturn className="flex flex-wrap gap-2">
          {packs.map((p) => (
            <a
              key={p.key}
              href={p.checkoutUrl!}
              target="_blank"
              rel="noreferrer"
              className="chip font-sans normal-case tracking-normal bg-[#E2F4F1] text-[#0C8175] hover:bg-[#D2EEE9]"
            >
              {fmt(t.packLabel, { credits: p.credits, price: p.priceUsd, kits: kitsLabel(p.kits) })}
            </a>
          ))}
        </BuyCreditsReturn>
      </div>
    </details>
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
  const packs = packsAllowedForTier(fu.tier) ? purchasablePacks(creditPacks()) : [];

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
        {/* Trial accounts can't buy packs — the way to more credits is a plan. */}
        <a
          href={PRICING_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-xs font-medium text-[#0C8175] hover:underline"
        >
          {t.upgradeCta}
        </a>
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
      {packs.length > 0 ? (
        <BuyCredits packs={packs} t={t} />
      ) : (
        // Post-promo free/trial accounts on the standard meter: no packs —
        // the plans page is the honest next step when the cap runs out.
        !packsAllowedForTier(fu.tier) && (
          <a
            href={PRICING_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-xs font-medium text-[#0C8175] hover:underline"
          >
            {t.upgradeCta}
          </a>
        )
      )}
    </section>
  );
}
