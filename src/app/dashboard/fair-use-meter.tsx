import { createClient } from "@/utils/supabase/server";

// The fair-use meter — the transparent face of the monthly caps (0047).
// Reads my_fair_use() (SECURITY DEFINER, auth.uid()-scoped); the DB triggers
// are the real guard, this card is the honest mirror: used / cap / carried-
// over / reset date. Renders nothing for unlimited tiers (schools, console-
// blessed accounts) or when the migration isn't applied yet.
type Bucket = { cap: number; carry: number; used: number; available: number };
type FairUse = { tier: string; unlimited: boolean; parts: Bucket; docs: Bucket; resets_on: string };

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

  const resetLabel = new Date(`${fu.resets_on}T00:00:00Z`).toLocaleDateString("en-MY", {
    month: "short",
    day: "numeric",
  });
  return (
    <section className="card px-5 py-3.5 mb-6 space-y-2" data-tour="fair-use">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[#14181F]">Fair use this month</span>
        <span className="text-[10px] text-[#98A0A9]">
          resets {resetLabel} · unused allowance carries one month forward
        </span>
      </div>
      <Row label="Lesson parts" b={fu.parts} />
      <Row label="Documents" b={fu.docs} />
    </section>
  );
}
