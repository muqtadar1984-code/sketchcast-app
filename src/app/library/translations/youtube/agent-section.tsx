import { ago } from "@/utils/cloudflare-stats";
import { nextRoundLabel, queueByLanguage, runOnceAccepts } from "@/utils/catalogue/youtube-agent";
import { shortLanguageName, type VideoRow } from "@/utils/catalogue/youtube-videos";
import type { AgentLoad } from "./agent-load";
import { AgentButtons, RemoveItem } from "./agent-ui";

// The YouTube Publishing Agent panel at the top of the YouTube view: when the
// next round runs, what each language posts next, the round in progress, and
// the last outcomes. Buttons for admins only. Server Component: the state is
// read by agent-load.ts; the rules are utils/catalogue/youtube-agent.ts.

const STATUS_LABEL: Record<string, string> = {
  pending: "waiting",
  selected: "in this round",
  queued: "uploading",
  done: "posted",
  failed: "failed",
  skipped: "skipped",
  cancelled: "removed",
};

export function AgentSection({ agent, rows, nowMs, canControl }: { agent: AgentLoad; rows: VideoRow[]; nowMs: number; canControl: boolean }) {
  if (!agent.available) return null;
  const byKit = new Map(rows.map((r) => [r.kitId, r]));
  const title = (kitId: string) => byKit.get(kitId)?.title ?? kitId.slice(0, 8);
  const languages = queueByLanguage(agent.open);
  const pending = agent.open.filter((i) => i.status === "pending").length;
  const paused = !!agent.settings.paused;
  const runOnce = runOnceAccepts(agent.openRound, pending, paused);
  const now = new Date(nowMs);

  return (
    <section className="card p-4 mb-5">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
        <div>
          <h2 className="text-sm font-medium">Posting agent · one video per language per day</h2>
          <p className="text-xs text-[#5B6470] mt-0.5">
            {nextRoundLabel({ nowMs, settings: agent.settings, dailyDoneToday: agent.dailyDoneToday, openRound: agent.openRound, pending })}
            {agent.lastRound?.finished_at && ` Last round finished ${ago(agent.lastRound.finished_at, now)}.`}
          </p>
        </div>
        {canControl && <AgentButtons paused={paused} runOnce={runOnce.ok ? { ok: true } : { ok: false, why: runOnce.why }} />}
      </div>

      {languages.length === 0 ? (
        <p className="text-sm text-[#5B6470]">
          The queue is empty.{canControl ? " Tick ready translations below and choose “Add to posting queue…”." : ""}
        </p>
      ) : (
        <table className="text-sm tabular w-full">
          <thead>
            <tr className="text-left text-[#5B6470]">
              <th className="font-normal py-1 pr-4">Language</th>
              <th className="font-normal py-1 px-3">Waiting</th>
              <th className="font-normal py-1 px-3">Now</th>
              <th className="font-normal py-1 px-3">Next</th>
            </tr>
          </thead>
          <tbody>
            {languages.map((l) => (
              <tr key={l.language} className="border-t border-[#EEF0EC] align-top">
                <td className="py-1 pr-4">{shortLanguageName(l.language)}</td>
                <td className="py-1 px-3">{l.waiting}</td>
                <td className="py-1 px-3">
                  {l.inFlight ? (
                    <span>
                      {title(l.inFlight.kit_id)} <span className="text-[#5B3FBF] text-xs">· {STATUS_LABEL[l.inFlight.status]}</span>
                    </span>
                  ) : (
                    <span className="text-[#8A929C]">—</span>
                  )}
                </td>
                <td className="py-1 px-3">
                  {l.next ? (
                    <span>
                      {title(l.next.kit_id)}
                      {l.next.attempts > 0 && <span className="text-xs text-[#9A6400]" title={l.next.last_error ?? undefined}> · retry {l.next.attempts}</span>}
                      {canControl && (
                        <>
                          {" "}
                          <RemoveItem itemId={l.next.id} />
                        </>
                      )}
                    </span>
                  ) : (
                    <span className="text-[#8A929C]">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pending > languages.length && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-[#5B6470]">Everything waiting ({pending})</summary>
          <ul className="mt-1 space-y-0.5">
            {agent.open
              .filter((i) => i.status === "pending")
              .map((i) => (
                <li key={i.id}>
                  {shortLanguageName(i.language)} · {title(i.kit_id)}
                  {canControl && (
                    <>
                      {" "}
                      <RemoveItem itemId={i.id} />
                    </>
                  )}
                </li>
              ))}
          </ul>
        </details>
      )}

      {agent.recent.length > 0 && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-[#5B6470]">Recent outcomes</summary>
          <ul className="mt-1 space-y-0.5">
            {agent.recent.map((i) => (
              <li key={i.id} className={i.status === "failed" ? "text-[#B3401F]" : undefined} title={i.last_error ?? undefined}>
                {shortLanguageName(i.language)} · {title(i.kit_id)} — {STATUS_LABEL[i.status] ?? i.status} {ago(i.updated_at, now)}
                {i.last_error && i.status !== "done" ? ` · ${i.last_error.slice(0, 120)}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
