import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { selectAll } from "@/utils/supabase/select-all";
import { InkUnderline } from "@/components/ink-mark";
import { buildCatalogueFunnel, type EventRow, type UnlockRow } from "@/utils/catalogue-funnel";
import { lessonPageTotals, lessonPageViews, type PathRow } from "@/utils/cloudflare-paths";

// The catalogue funnel (plan §5.5, Phase E): unlock → download → copy to
// Library → assign, for the Ready-made kits. Read from catalogue_unlocks and
// catalogue_events (both written only by the database and server routes), plus
// the shares on Library copies. The step BEFORE this page — public lesson page
// → signup — is Cloudflare Web Analytics on sketchcast.app and
// profiles.signup_source; the release switch itself is shown at the top so
// the numbers are read against it.

export const dynamic = "force-dynamic";

export default async function ConsoleCataloguePage() {
  const admin = createAdminClient();

  const [releaseQ, unlocksQ, eventsQ, copiesQ, topicsQ, fromPagesQ] = await Promise.all([
    admin.from("platform_settings").select("value").eq("key", "catalogue_release").maybeSingle(),
    selectAll<UnlockRow>(() => admin.from("catalogue_unlocks").select("user_id, topic_id, source, week_start, unlocked_at")),
    selectAll<EventRow>(() => admin.from("catalogue_events").select("user_id, topic_id, event, meta, created_at")),
    selectAll<{ id: string }>(() => admin.from("generations").select("id").not("params->catalogue_ref", "is", null).is("removed_at", null)),
    admin.from("topics").select("id, title, subject, slug"),
    // Signups the public lesson pages brought: /signup?topic=<slug> is
    // recorded as signup_source "topic:<slug>" (utils/attribution.ts).
    admin.from("profiles").select("id", { count: "exact", head: true }).like("signup_source", "topic:%"),
  ]);
  const signupsFromPages = fromPagesQ.count ?? 0;
  // The funnel's first step (0139): lesson-page visits from Cloudflare, last 7 days.
  const now = new Date();
  const since7 = new Date(now.getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
  const pathsQ = await admin.from("cloudflare_path_stats").select("day, path, requests, visits").eq("zone", "sketchcast.app").gte("day", since7).limit(20_000);
  const lessonPages = lessonPageViews((pathsQ.data ?? []) as PathRow[], 7, now);
  const lessonVisits = lessonPageTotals(lessonPages).visits;
  const visitsBySlug = new Map(lessonPages.map((p) => [p.slug, p.visits]));

  const release = (releaseQ.data?.value ?? null) as { public?: boolean; preview_emails?: string[] } | null;
  const copies = (copiesQ.data ?? []).map((c) => c.id);
  let assigned: string[] = [];
  if (copies.length) {
    const { data: shares } = await selectAll<{ generation_id: string }>(() =>
      admin.from("generation_shares").select("generation_id").in("generation_id", copies),
    );
    assigned = (shares ?? []).map((s) => s.generation_id);
  }
  const f = buildCatalogueFunnel(unlocksQ.data ?? [], eventsQ.data ?? [], assigned);
  const topicName = new Map(((topicsQ.data ?? []) as { id: string; title: string; subject: string | null; slug: string | null }[]).map((t) => [t.id, t]));

  const cards: [string, number, string?][] = [
    ["Lesson page visits · 7d", lessonVisits, "Cloudflare, off-site referrers"],
    ["Signups from lesson pages", signupsFromPages, "signup_source topic:<slug>"],
    ["Unlockers", f.totals.unlockers, "people who unlocked ≥1 kit"],
    ["Unlocks", f.totals.unlocks, "permanent, one per topic per person"],
    ["Downloads", f.totals.downloads, "document files served"],
    ["Copied to Library", f.totals.adopts, `${f.totals.adopters} people`],
    ["Assigned", f.totals.assignedCopies, "copies shared to a class or child"],
    ["Weekly limit hit", f.totals.weeklyLimitHits, "an upgrade moment"],
  ];

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">Catalogue</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-[#5B6470] mb-6">
        Ready-made kits: unlock → download → copy to Library → assign. The step before this — public lesson page → signup — is in
        Cloudflare Web Analytics and <code className="text-xs">profiles.signup_source</code>.{" "}
        <Link href="/console/content" className="text-[#0C8175] hover:underline">
          Open the content desk
        </Link>
        .
      </p>

      <div className={`card px-5 py-3.5 mb-6 ${release?.public ? "border-[#BDE8E2] bg-[#F1FBF9]" : "border-[#F6D8A8] bg-[#FFF8EB]"}`}>
        <p className="text-sm">
          <span className="font-medium">{release?.public ? "Released to everyone." : "Not released."}</span>{" "}
          {release?.public
            ? "Every eligible account sees the kits."
            : `Kits are visible to the preview list only (${(release?.preview_emails ?? []).join(", ") || "nobody"}); everyone else sees "coming soon".`}{" "}
          <span className="text-[#5B6470]">
            Release = <code className="text-xs">update platform_settings set value = jsonb_set(value,&apos;{"{public}"}&apos;,&apos;true&apos;) where key=&apos;catalogue_release&apos;</code>, then flip
            KITS_RELEASED and kitsReleased on the landing site.
          </span>
        </p>
      </div>

      <div className="card px-5 py-4 mb-6">
        <p className="text-xs font-medium text-[#5B6470] mb-3">All time</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
          {cards.map(([label, n, hint]) => (
            <div key={label}>
              <p className="text-2xl tabular">{n}</p>
              <p className="text-xs text-[#5B6470]">{label}</p>
              {hint && <p className="text-[10px] text-[#98A0A9]">{hint}</p>}
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="card divide-y divide-[#EEF0EC] overflow-x-auto">
          <div className="grid grid-cols-[1.2fr_repeat(5,1fr)] gap-3 px-5 py-2 text-xs text-[#5B6470] font-medium min-w-[36rem]">
            <span>Week of (Mon UTC)</span>
            <span className="text-end">Unlockers</span>
            <span className="text-end">Unlocks</span>
            <span className="text-end">Downloads</span>
            <span className="text-end">Copied</span>
            <span className="text-end">Limit hit</span>
          </div>
          {f.weeks.map((w) => (
            <div key={w.week} className="grid grid-cols-[1.2fr_repeat(5,1fr)] gap-3 px-5 py-2.5 text-sm items-center min-w-[36rem]">
              <span className="font-mono text-xs">{w.week}</span>
              <span className="tabular text-end">{w.unlockers}</span>
              <span className="tabular text-end">{w.unlocks}</span>
              <span className="tabular text-end">{w.downloads}</span>
              <span className="tabular text-end">{w.adopts}</span>
              <span className="tabular text-end">{w.weeklyLimitHits}</span>
            </div>
          ))}
          {f.weeks.length === 0 && <div className="px-5 py-6 text-sm text-[#5B6470]">No unlocks yet — the table fills in from the first one.</div>}
        </div>

        <div className="space-y-6">
          <div className="card divide-y divide-[#EEF0EC]">
            <div className="grid grid-cols-[1.6fr_repeat(4,1fr)] gap-3 px-5 py-2 text-xs text-[#5B6470] font-medium">
              <span>Topic</span>
              <span className="text-end">Visits 7d</span>
              <span className="text-end">Unlocks</span>
              <span className="text-end">Downloads</span>
              <span className="text-end">Copied</span>
            </div>
            {f.topics.map((t) => {
              const meta = topicName.get(t.topic_id);
              return (
                <div key={t.topic_id} className="grid grid-cols-[1.6fr_repeat(4,1fr)] gap-3 px-5 py-2.5 text-sm items-center">
                  <span className="truncate" title={meta?.title ?? t.topic_id}>
                    {meta?.slug ? (
                      <a href={`https://sketchcast.app/topics/${meta.slug}`} target="_blank" rel="noreferrer" className="hover:underline">
                        {meta.title}
                      </a>
                    ) : (
                      (meta?.title ?? t.topic_id)
                    )}
                  </span>
                  <span className="tabular text-end">{meta?.slug ? (visitsBySlug.get(meta.slug) ?? 0) : "—"}</span>
                  <span className="tabular text-end">{t.unlocks}</span>
                  <span className="tabular text-end">{t.downloads}</span>
                  <span className="tabular text-end">{t.adopts}</span>
                </div>
              );
            })}
            {f.topics.length === 0 && <div className="px-5 py-6 text-sm text-[#5B6470]">No topic unlocked yet.</div>}
          </div>

          <div className="card divide-y divide-[#EEF0EC]">
            <div className="grid grid-cols-[1.6fr_repeat(2,1fr)] gap-3 px-5 py-2 text-xs text-[#5B6470] font-medium">
              <span>Plan tier</span>
              <span className="text-end">Unlocks</span>
              <span className="text-end">Limit hit</span>
            </div>
            {f.tiers.map((t) => (
              <div key={t.tier} className="grid grid-cols-[1.6fr_repeat(2,1fr)] gap-3 px-5 py-2.5 text-sm items-center">
                <span className="font-mono text-xs">{t.tier}</span>
                <span className="tabular text-end">{t.unlocks}</span>
                <span className="tabular text-end">{t.weeklyLimitHits}</span>
              </div>
            ))}
            {f.tiers.length === 0 && <div className="px-5 py-6 text-sm text-[#5B6470]">No unlock events yet.</div>}
          </div>
        </div>
      </div>
    </main>
  );
}
