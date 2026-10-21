import type { ReactNode } from "react";
import Link from "next/link";
import AutoRefresh from "@/components/auto-refresh";
import { ago } from "@/utils/cloudflare-stats";
import { fmtDate } from "../../catalogue-ui";
import { Heading } from "../translations-view";
import { TranslationsNav } from "../sub-nav";
import { pollIsLate, POLL_DEFAULT_MINUTES } from "@/utils/catalogue/youtube-channels";
import {
  FLAG_LABEL,
  STATE_LABEL,
  VIEW_LABEL,
  buildVideoRows,
  inView,
  scheduledFor,
  scopeRows,
  shortLanguageName,
  videoFiltersHref,
  videoTotals,
  viewCounts,
  type VideoFilters,
  type VideoInput,
  type VideoRow,
  type VideoState,
  type VideoView,
} from "@/utils/catalogue/youtube-videos";

// The YouTube view's screen: the freshness line, the totals per language, the
// category chips, the filters and the list. A Server Component with no reads
// of its own — page.tsx authenticates and loads, then hands the rows here.
//
// BULK POSTING (plan-yt-bulk-post) plugs in through `selection`: a header
// cell and a per-row cell (a client checkbox), drawn as the first column only
// when passed. Which rows may carry a checkbox is `row.postable`
// (selectableForPost in youtube-videos.ts) — the one rule; do not copy it.

const TONE: Record<VideoState, string> = {
  public: "bg-[#0F7A68] text-white",
  unlisted: "bg-[#E6F6F2] text-[#0F7A68]",
  private: "bg-[#EEF0EC] text-[#3D4652]",
  removed: "bg-[#FFE9E3] text-[#B3401F]",
  rejected: "bg-[#FFE9E3] text-[#B3401F]",
  scheduled: "bg-[#E3EEFB] text-[#1F5FA8]",
  partial: "bg-[#FFF1D6] text-[#9A6400]",
  posting: "bg-[#EDE7FB] text-[#5B3FBF]",
  post_failed: "bg-[#FFE9E3] text-[#B3401F]",
  awaiting_approval: "bg-[#E3EEFB] text-[#1F5FA8]",
  no_channel: "bg-[#FFF1D6] text-[#9A6400]",
  ready: "bg-[#F4F5F2] text-[#14181F]",
};

const STATE_HELP: Record<VideoState, string> = {
  public: "On YouTube, public — as of the last check.",
  unlisted: "On YouTube, unlisted — anyone with the link can watch.",
  private: "On YouTube, private.",
  scheduled: "On YouTube, private until its scheduled time, then public.",
  removed: "Posted, but YouTube no longer lists it — it was deleted or removed on YouTube.",
  rejected: "YouTube rejected the upload or could not process it — the reason is on hover; fix it in YouTube Studio.",
  partial: "Some parts are on YouTube, some are not — Finish posting from the review inbox.",
  posting: "A post is queued or uploading now.",
  post_failed: "The last upload failed — the error is on the part; Retry from the review inbox.",
  awaiting_approval: "The translation is in review; it can be posted once a reviewer approves it.",
  no_channel: "This language has no YouTube channel yet; translations are posted only on their own language's channel.",
  ready: "Approved and not on YouTube yet — post it from the review inbox.",
};

const POSTED_SUB: VideoView[] = ["public", "unlisted", "private", "scheduled"];
const NOT_POSTED_SUB: VideoView[] = ["ready", "posting", "failed", "awaiting"];

function Chip({ view, f, count, sub = false }: { view: VideoView; f: VideoFilters; count: number; sub?: boolean }) {
  const active = f.view === view;
  return (
    <Link
      href={videoFiltersHref({ ...f, view })}
      aria-current={active ? "page" : undefined}
      className={
        (active ? "bg-[#14241E] text-white" : sub ? "bg-white text-[#5B6470] hover:bg-[#EEF0EC]" : "bg-[#F4F5F2] text-[#14181F] hover:bg-[#EEF0EC]") +
        ` rounded-full border border-[#E3E6E0] px-3 py-1 ${sub ? "text-xs" : "text-sm font-medium"} whitespace-nowrap`
      }
    >
      {VIEW_LABEL[view]} <span className={active ? "opacity-80" : "text-[#8A929C]"}>{count}</span>
    </Link>
  );
}

function YouTubeLinks({ row }: { row: VideoRow }) {
  const posted = row.parts.filter((p) => p.videoId);
  if (!posted.length) return <span className="text-[#8A929C]">—</span>;
  return (
    <ul className="space-y-0.5">
      {posted.map((p) => (
        <li key={p.part} className="whitespace-nowrap">
          {row.parts.length > 1 && <span className="text-[#8A929C]">Part {p.part} · </span>}
          <a href={`https://youtu.be/${p.videoId}`} target="_blank" rel="noreferrer" className="underline text-[#1F5B99] font-mono text-xs" title="Watch on YouTube">
            {p.videoId}
          </a>{" "}
          <a href={`https://studio.youtube.com/video/${p.videoId}/edit`} target="_blank" rel="noreferrer" className="text-xs text-[#5B6470] hover:text-[#14181F]" title="Open in YouTube Studio">
            Studio
          </a>
          {p.missing && <span className="text-xs text-[#B3401F]"> · not listed</span>}
        </li>
      ))}
    </ul>
  );
}

export function YouTubeVideosView({
  input,
  filters: f,
  selection,
  top,
}: {
  input: VideoInput;
  filters: VideoFilters;
  /** bulk posting's checkbox column — absent until that feature passes it.
   *  `header` receives the rows listed under the current filters, so "select
   *  all" can only ever select what is on screen. */
  selection?: { header: (listed: VideoRow[]) => ReactNode; cell: (row: VideoRow) => ReactNode };
  /** the YouTube Publishing Agent's panel, drawn above the totals */
  top?: ReactNode;
}) {
  const now = new Date(input.nowMs);
  const minutes = input.pollMinutes ?? POLL_DEFAULT_MINUTES;
  const all = buildVideoRows(input);
  const languages = [...new Set(all.map((r) => r.language))];
  const subjects = [...new Set(all.map((r) => (r.subject ?? "").trim()).filter(Boolean))].sort();
  const scoped = scopeRows(all, f);
  const rows = scoped.filter((r) => inView(r, f.view));
  const counts = viewCounts(scoped);
  const totals = videoTotals(scopeRows(all, { lang: "", subject: f.subject, q: f.q }), input.channels);
  const posting = all.some((r) => r.state === "posting");
  const cols = 7 + (selection ? 1 : 0);

  return (
    <main className="px-6 py-10 max-w-[96rem] mx-auto">
      <AutoRefresh active={posting} seconds={30} />
      <Heading />
      <TranslationsNav active="youtube" />
      <p className="text-[#5B6470] mb-4 max-w-3xl">
        Every translated video and where it stands on YouTube. Platform admins tick ready translations to queue them for the posting agent (one video
        per language per day), or open a row&apos;s topic to post, retry or re-word it in the review inbox. A translation is posted only on its own
        language&apos;s channel.
      </p>

      <p className="text-xs text-[#5B6470] mb-4 flex flex-wrap gap-x-4 gap-y-1">
        <span>YouTube status is checked every {minutes} min by the worker.</span>
        {input.channels.length === 0 && <span className="text-[#9A6400]">No channel has been polled yet.</span>}
        {input.channels.map((c) => {
          const late = pollIsLate(c.lastPoll, input.nowMs, minutes);
          return (
            <span key={c.language} className={late ? "text-[#9A6400]" : undefined} title={`${c.title ?? c.language} — last checked ${fmtDate(c.lastPoll)} ${c.lastPoll.slice(11, 16)} UTC`}>
              {shortLanguageName(c.language)} channel{c.title ? ` “${c.title}”` : ""}: checked {ago(c.lastPoll, now)}
              {late ? " — late, statuses may be old" : ""}
            </span>
          );
        })}
      </p>

      {top}

      <section className="card p-4 mb-5 overflow-x-auto">
        <h2 className="text-sm font-medium mb-2">By language{f.subject ? ` · ${f.subject}` : ""}</h2>
        <table className="text-sm tabular">
          <thead>
            <tr className="text-left text-[#5B6470]">
              <th className="pr-4 py-1 font-normal">Language</th>
              <th className="px-3 py-1 font-normal">Channel</th>
              <th className="px-3 py-1 font-normal">Posted</th>
              <th className="px-3 py-1 font-normal">Public</th>
              <th className="px-3 py-1 font-normal">Unlisted</th>
              <th className="px-3 py-1 font-normal">Private</th>
              <th className="px-3 py-1 font-normal">Not posted</th>
              <th className="px-3 py-1 font-normal">Awaiting approval</th>
              <th className="px-3 py-1 font-normal">Attention</th>
            </tr>
          </thead>
          <tbody>
            {totals.map((t) => (
              <tr key={t.language} className="border-t border-[#EEF0EC]">
                <td className="pr-4 py-1">
                  <Link href={videoFiltersHref({ ...f, lang: t.language })} className="hover:underline">
                    {t.name}
                  </Link>{" "}
                  <span className="text-[#8A929C]">{t.language}</span>
                </td>
                <td className={`px-3 py-1 ${t.channel ? "text-[#0F7A68]" : "text-[#9A6400]"}`}>{t.channel ? "✓" : "none yet"}</td>
                <td className="px-3 py-1 font-medium">
                  {t.posted}/{t.total}
                </td>
                <td className="px-3 py-1 text-[#0F7A68]">{t.public}</td>
                <td className="px-3 py-1">{t.unlisted}</td>
                <td className="px-3 py-1">{t.private}</td>
                <td className="px-3 py-1">{t.notPosted}</td>
                <td className="px-3 py-1 text-[#1F5FA8]">{t.awaiting}</td>
                <td className={`px-3 py-1 ${t.attention ? "text-[#9A6400] font-medium" : "text-[#8A929C]"}`}>{t.attention}</td>
              </tr>
            ))}
            {totals.length === 0 && (
              <tr>
                <td colSpan={9} className="py-2 text-[#5B6470]">
                  No translated videos yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <div className="flex flex-wrap items-center gap-2 mb-2" aria-label="Categories">
        <Chip view="all" f={f} count={counts.all} />
        <Chip view="posted" f={f} count={counts.posted} />
        {POSTED_SUB.map((v) => (
          <Chip key={v} view={v} f={f} count={counts[v]} sub />
        ))}
        <span className="w-2" />
        <Chip view="not_posted" f={f} count={counts.not_posted} />
        {NOT_POSTED_SUB.map((v) => (
          <Chip key={v} view={v} f={f} count={counts[v]} sub />
        ))}
        <span className="w-2" />
        <Chip view="attention" f={f} count={counts.attention} />
      </div>

      <form method="get" className="card p-4 mb-4 flex flex-wrap items-center gap-3 text-sm">
        {f.view !== "all" && <input type="hidden" name="view" value={f.view} />}
        <select name="lang" defaultValue={f.lang} className="field h-9 px-2" aria-label="Language">
          <option value="">Every language</option>
          {languages.map((l) => (
            <option key={l} value={l}>
              {shortLanguageName(l)}
            </option>
          ))}
        </select>
        <select name="subject" defaultValue={f.subject} className="field h-9 px-2" aria-label="Subject">
          <option value="">Any subject</option>
          {subjects.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input name="q" defaultValue={f.q} placeholder="Find a topic" className="field h-9 px-2 w-48" aria-label="Find a topic" />
        <button className="btn-primary h-9 px-4">Show</button>
        {(f.lang || f.subject || f.q || f.view !== "all") && (
          <Link href="/library/translations/youtube" className="text-[#5B6470] hover:text-[#14181F] underline">
            Clear
          </Link>
        )}
        <span className="text-[#5B6470] ml-auto">
          {rows.length} of {all.length} videos
        </span>
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-[#F4F5F2] text-[#5B6470]">
            <tr className="text-left">
              {selection && <th className="px-3 py-2 w-8">{selection.header(rows)}</th>}
              <th className="font-normal px-3 py-2 min-w-[16rem]">Topic</th>
              <th className="font-normal px-3 py-2">Language</th>
              <th className="font-normal px-3 py-2">YouTube status</th>
              <th className="font-normal px-3 py-2">Channel</th>
              <th className="font-normal px-3 py-2">Video</th>
              <th className="font-normal px-3 py-2">Posted</th>
              <th className="font-normal px-3 py-2" title="When the worker's hourly poll last saw the video, and its views then">
                Checked
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const posted = r.parts.filter((p) => p.videoId);
              const checked = posted.map((p) => p.checkedAt).filter((x): x is string => !!x).sort()[0] ?? null;
              const views = posted.reduce((n, p) => n + (p.views ?? 0), 0);
              const postedAt = posted.map((p) => p.publishedAt).filter((x): x is string => !!x).sort()[0] ?? null;
              const failed = r.parts.find((p) => p.error && !p.videoId);
              const rejected = r.state === "rejected" ? (posted.find((p) => p.uploadStatus)?.uploadStatus ?? null) : null;
              return (
                <tr key={r.kitId} className="border-t border-[#EEF0EC] align-top hover:bg-[#FBFCFA]">
                  {selection && <td className="px-3 py-2">{selection.cell(r)}</td>}
                  <td className="px-3 py-2">
                    <Link href={r.inboxHref} className="font-medium hover:underline" title="Open in the review inbox">
                      {r.title}
                    </Link>
                    <div className="text-xs text-[#8A929C]">{r.subject ?? "No subject"}</div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.languageName} <span className="text-[#8A929C]">{r.language}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span title={rejected ?? failed?.error ?? (r.postable.ok ? STATE_HELP[r.state] : `${STATE_HELP[r.state]} ${r.postable.why}`)} className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONE[r.state]}`}>
                      {r.state === "no_channel"
                        ? `No ${r.languageName} channel yet`
                        : r.state === "scheduled"
                          ? `Scheduled · ${fmtDate(scheduledFor(r, input.nowMs))}`
                          : STATE_LABEL[r.state]}
                    </span>
                    {r.flags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {r.flags.map((fl) => (
                          <span
                            key={fl}
                            className="rounded bg-[#FFF8EA] px-1 text-[0.68rem] text-[#9A6400]"
                            title={fl === "posted_with_notes" ? (posted.find((p) => p.error)?.error ?? undefined) : undefined}
                          >
                            {FLAG_LABEL[fl]}
                          </span>
                        ))}
                      </div>
                    )}
                    {failed && <div className="mt-1 text-xs text-[#B3401F] max-w-xs truncate" title={failed.error ?? undefined}>{failed.error}</div>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {shortLanguageName(r.channel.language)}
                    {!r.channel.exists && <span className="text-[#9A6400]"> · none yet</span>}
                  </td>
                  <td className="px-3 py-2">
                    <YouTubeLinks row={r} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-[#5B6470]" title={postedAt ?? undefined}>
                    {postedAt ? fmtDate(postedAt) : "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-[#5B6470]">
                    {posted.length ? (
                      <>
                        {checked ? ago(checked, now) : "never"}
                        {checked && <div className="text-xs text-[#8A929C]">{views} views</div>}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={cols} className="px-3 py-8 text-center text-[#5B6470]">
                  No translated videos match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
