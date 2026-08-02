import { createClient } from "@/utils/supabase/server";
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

export default async function FairUseMeter() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("my_fair_use");
  if (error || !data) return null; // pre-0047 DB or signed-out — show nothing
  const fu = data as FairUse;
  if (fu.unlimited) return null;

  const locale: Locale = await resolveLocale();
  const dict = await getDictionary(locale);
  const t = dict.fairUse;
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
    </section>
  );
}
