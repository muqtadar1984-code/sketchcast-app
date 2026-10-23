import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { isDryRun, nextDailyRound, nextRoundPreview, pinUrl, runOnceAccepts, type PinView } from "@/utils/catalogue/pinterest";
import { ErrorBanner } from "../../catalogue-ui";
import { languageName, MissingPinterestBanner, PinStatusChip, PinterestHeading, PinterestNav } from "../chrome";
import { AgentControls, RetryPin } from "../controls";
import { loadPinterest } from "../load";

// /library/pinterest/posting — what the agent will post and what it posted
// (build plan §4.1): the agent's state and controls, the next round per
// language, approved pins waiting, scheduled ones, failures with Retry, and
// posted pins with their 7- and 30-day numbers. Every member can look; the
// controls are for platform admins.

export const dynamic = "force-dynamic";

const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC" : "—";

export default async function PinterestPostingPage() {
  const member = await requireLibraryMember();
  const admin = createAdminClient();
  const nowMs = Date.now();
  let load;
  try {
    load = await loadPinterest(admin, nowMs);
  } catch (e) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <PinterestHeading />
        <PinterestNav active="posting" />
        <ErrorBanner message={e instanceof Error ? e.message : "Could not load the Pinterest pins."} />
      </main>
    );
  }
  if (!load.available) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <PinterestHeading />
        <PinterestNav active="posting" />
        <MissingPinterestBanner />
      </main>
    );
  }

  const { settings } = load;
  const canAct = libraryAllows(member.role, "publish");
  const accepts = runOnceAccepts(load.openRound, load.approved.length, settings);
  const preview = nextRoundPreview(load.approved, load.lastPostedByTopicLang, settings, nowMs);
  const nextAt = nextDailyRound(settings, nowMs, load.dailyDoneToday);

  return (
    <main className="max-w-6xl mx-auto px-6 py-10 space-y-8">
      <div>
        <PinterestHeading settings={settings} />
        <PinterestNav active="posting" counts={load.counts} />
      </div>

      <section aria-labelledby="agent-h" className="rounded-xl border border-[#E3E6E0] bg-white px-5 py-4 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="agent-h" className="font-medium">The posting agent</h2>
          <p className="text-sm text-[#5B6470]">
            {settings.enabled
              ? load.openRound
                ? `A ${load.openRound.trigger} round is running.`
                : `Next daily round: ${fmt(new Date(nextAt).toISOString())}.`
              : "Switched off — turning it on is a go-live step."}
            {" "}Up to {settings.per_language_per_day ?? 1} per language per day; a topic waits {settings.min_topic_gap_days ?? 7} days between pins.
          </p>
        </div>
        {settings.breaker?.tripped ? (
          <ErrorBanner message={`Breaker tripped${settings.breaker.reason ? `: ${settings.breaker.reason}` : ""}. Nothing posts until it is cleared.`} />
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-[#5B6470]">
              <tr><th className="py-1 pr-4 font-normal">Language</th><th className="py-1 pr-4 font-normal">Next round posts</th><th className="py-1 pr-4 font-normal tabular-nums">Approved waiting</th><th className="py-1 font-normal tabular-nums">Held by topic gap</th></tr>
            </thead>
            <tbody>
              {preview.map((p) => (
                <tr key={p.language} className="border-t border-[#EEF0EC]">
                  <td className="py-1.5 pr-4">{languageName(p.language)}</td>
                  <td className="py-1.5 pr-4">{p.pins.length ? p.pins.map((x) => x.title).join(" · ") : <span className="text-[#98A0A9]">nothing ready</span>}</td>
                  <td className="py-1.5 pr-4 tabular-nums">{p.waiting}</td>
                  <td className="py-1.5 tabular-nums">{p.heldByGap}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canAct ? <AgentControls settings={settings} runOnceWhy={accepts.ok ? null : accepts.why} /> : null}
      </section>

      <PinList title="Scheduled" pins={load.scheduled} empty="Nothing scheduled right now." />
      <PinList title="Approved, waiting for a round" pins={load.approved} empty="No approved pins waiting." />
      <PinList
        title="Failed"
        pins={load.failed}
        empty="No failures."
        extra={(p) => (
          <>
            {p.last_error ? <span className="text-xs text-[#B42318]">{p.last_error}</span> : null}
            {canAct && p.approved_at && !p.pinterest_pin_id ? <RetryPin pinId={p.id} /> : null}
          </>
        )}
      />

      <section aria-labelledby="posted-h" className="space-y-2">
        <h2 id="posted-h" className="font-medium">Posted</h2>
        {load.posted.length === 0 ? (
          <p className="text-sm text-[#5B6470]">Nothing posted yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-[#E3E6E0] bg-white">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-[#5B6470] bg-[#F7F8F5]">
                <tr>
                  <th className="px-3 py-2 font-normal">Pin</th>
                  <th className="px-3 py-2 font-normal">Language</th>
                  <th className="px-3 py-2 font-normal">Posted</th>
                  <th className="px-3 py-2 font-normal text-right">Impressions 7d / 30d</th>
                  <th className="px-3 py-2 font-normal text-right">Saves 30d</th>
                  <th className="px-3 py-2 font-normal text-right">Outbound clicks 30d</th>
                </tr>
              </thead>
              <tbody>
                {load.posted.map((p) => {
                  const s = load.stats[p.id];
                  const url = pinUrl(p.pinterest_pin_id);
                  return (
                    <tr key={p.id} className="border-t border-[#EEF0EC]">
                      <td className="px-3 py-2 min-w-0">
                        {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="underline decoration-[#C9CEC6] hover:decoration-current">{p.title}</a> : p.title}
                        {isDryRun(p.pinterest_pin_id) ? <span className="ml-2 chip bg-[#FFF1D6] text-[#9A6400]">dry run</span> : null}
                        <span className="block text-xs text-[#5B6470]">{p.topicTitle ?? ""}{p.boardName ? ` · ${p.boardName}` : ""}</span>
                      </td>
                      <td className="px-3 py-2">{languageName(p.language)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{fmt(p.posted_at)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s ? `${s.d7.impression} / ${s.d30.impression}` : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s ? s.d30.save : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s ? s.d30.outbound : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function PinList({ title, pins, empty, extra }: { title: string; pins: PinView[]; empty: string; extra?: (p: PinView) => React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="font-medium">{title} <span className="text-sm text-[#5B6470] tabular-nums">{pins.length || ""}</span></h2>
      {pins.length === 0 ? (
        <p className="text-sm text-[#5B6470]">{empty}</p>
      ) : (
        <ul className="divide-y divide-[#EEF0EC] rounded-xl border border-[#E3E6E0] bg-white">
          {pins.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <PinStatusChip status={p.status} />
              <span className="min-w-0 flex-1 truncate">{p.title}</span>
              <span className="text-xs text-[#5B6470]">{languageName(p.language)} · {p.template}</span>
              {extra ? extra(p) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
