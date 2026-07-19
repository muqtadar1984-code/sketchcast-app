import { createClient } from "@/utils/supabase/server";

// The fair-use meter — the transparent face of the monthly caps (0047).
// Reads my_fair_use() (SECURITY DEFINER, auth.uid()-scoped); the DB triggers
// are the real guard, this card is the honest mirror: used / cap / carried-
// over / reset date. Renders nothing for unlimited tiers (schools, console-
// blessed accounts) or when the migration isn't applied yet.
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

function Row({ label, b }: { label: string; b: Bucket }) {
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
        {b.used} of {b.cap}
        {b.carry > 0 ? ` +${b.carry} carried` : ""}
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

  const dateLabel = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-MY", { month: "short", day: "numeric" });

  // Launch free-trial period (0060): every feature unlocked, a single
  // period-total budget of lessons that ends on the trial date (no monthly
  // reset, no rollover). Framed as a trial, not a monthly meter.
  if (fu.promo && fu.credits) {
    return (
      <section className="card px-5 py-3.5 mb-6 space-y-2 border-[#BDE8E2] bg-[#F1FBF9]" data-tour="fair-use">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-[#0C8175]">Free trial — every feature unlocked</span>
          {fu.trial_ends && (
            <span className="text-[10px] text-[#98A0A9]">trial ends {dateLabel(fu.trial_ends)}</span>
          )}
        </div>
        <Row label="Trial lessons" b={fu.credits} />
        <p className="text-[10px] text-[#98A0A9]">
          {fu.credits.available > 0
            ? `${fu.credits.available} of ${fu.credits.cap} lessons left — each brings its full document kit free. After the trial, the free plan covers one lesson at a time.`
            : `You've used all ${fu.credits.cap} trial lessons. Subscribe to keep generating — the free plan covers one lesson at a time.`}
        </p>
      </section>
    );
  }

  const resetLabel = dateLabel(fu.resets_on);
  return (
    <section className="card px-5 py-3.5 mb-6 space-y-2" data-tour="fair-use">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[#14181F]">Fair use this month</span>
        <span className="text-[10px] text-[#98A0A9]">
          resets {resetLabel} · unused allowance carries one month forward
        </span>
      </div>
      {fu.credits ? (
        <>
          <Row label="Lessons" b={fu.credits} />
          <p className="text-[10px] text-[#98A0A9]">
            Each lesson includes its full document kit — plan, activities, worksheet, test paper and case
            study — free.
          </p>
        </>
      ) : (
        // Pre-0059 DB (deploy window): the old two-pool shape.
        <>
          {fu.parts && <Row label="Lesson parts" b={fu.parts} />}
          {fu.docs && <Row label="Documents" b={fu.docs} />}
        </>
      )}
    </section>
  );
}
