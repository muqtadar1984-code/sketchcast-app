import Link from "next/link";
import { listRuns } from "@/utils/books/store";
import { canOn } from "@/utils/books-access";
import { CHECK_LABEL, gapTotals, groupGaps, libraryLink, STATE_LABEL, waivable, type Curriculum, type Gap } from "@/utils/books/gaps";
import { listWaivers } from "@/utils/books/waivers";
import { loadRecords } from "../load";
import { Card, Empty, day, usd } from "../../ui";
import { RevokeWaiver, WaiveCheck } from "./waive";

// /books/[slug]/gaps — what the book still needs before it can be drafted: every
// topic the latest readiness re-check found outstanding, its next steps with
// measured cost and review time, and a link to the Library page that does them.
// Nothing here changes the catalogue: the work is done in the Library, then a
// fresh Readiness re-check (Pipeline) updates this list.
export default async function GapsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { work, member } = await loadRecords(slug);
  const [runs, waivers] = await Promise.all([listRuns(work.uid), listWaivers(work.uid)]);
  const canWaive = canOn(member, work.uid, "edit");
  const readiness = runs.filter((r) => (r.stage_key === "readiness" || r.stage_key === "gate_r") && r.status === "done").sort((a, b) => b.id - a.id)[0];
  const rs = readiness?.detail?.summary as { pct?: number; ready?: boolean; gaps?: Gap[]; curriculum?: Curriculum | null } | undefined;

  if (!readiness || !rs) {
    return (
      <Card>
        <Empty>
          No readiness re-check yet. Run one from{" "}
          <Link href={`/books/${slug}/runs`} className="underline hover:text-[#1F2A24]">Pipeline → Readiness re-check</Link> (free); the gaps it finds are listed here.
        </Empty>
      </Card>
    );
  }
  if (!rs.gaps) {
    return (
      <Card>
        <Empty>
          The latest re-check (run #{readiness.id}, {day(readiness.created_at)}) is from before gaps were recorded. Run a fresh{" "}
          <Link href={`/books/${slug}/runs`} className="underline hover:text-[#1F2A24]">Readiness re-check</Link> to list them.
        </Empty>
      </Card>
    );
  }

  const { chapters, usd: total, reviewMin } = groupGaps(rs.gaps);
  const curriculum = rs.curriculum ?? null;
  const active = waivers.filter((w) => !w.revoked_at);
  const checkName = (code: string, language: string | null) => `${code}${language ? "/" + language : ""} · ${CHECK_LABEL[code] ?? code}`;
  return (
    <div className="space-y-4">
      <Card
        title="Before this book can be drafted"
        aside={
          <Link href={`/books/${slug}/runs/${readiness.id}`} className="text-xs text-[#7A7363] underline hover:text-[#1F2A24]">
            Checked {day(readiness.created_at)} · run #{readiness.id}
          </Link>
        }
      >
        {rs.ready || rs.gaps.length === 0 ? (
          <p className="text-sm text-[#24543A]">Nothing outstanding: every topic the book needs is ready ({rs.pct}%).</p>
        ) : (
          <div className="text-sm space-y-1">
            <p>
              <span className="font-display text-3xl">{rs.pct}%</span> <span className="text-[#7A7363]">ready</span>
            </p>
            <p className="text-[#5F5A4E]">
              {rs.gaps.length} topics outstanding · about {usd(total)} in model cost and {Math.round(reviewMin / 60)} h of review to close them (the planner&apos;s
              measured estimates).
            </p>
            <p className="text-xs text-[#7A7363]">
              Each step is done in the Library{curriculum ? ` (${curriculum.code} · ${curriculum.name})` : ""}. When they are done, run a fresh Readiness re-check
              on the Pipeline tab; this list updates from it.
            </p>
          </div>
        )}
      </Card>
      {waivers.length > 0 && (
        <Card title={`Waived for this book · ${active.length} active`}>
          <ul className="divide-y divide-[#EFE8D8] text-sm">
            {waivers.map((w) => (
              <li key={w.id} className={"py-2 first:pt-0 last:pb-0" + (w.revoked_at ? " text-[#7A7363]" : "")}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p>
                    <span className="font-medium">{w.topic_title ?? w.topic_id}</span> — {checkName(w.check_code, w.language)}
                    {w.sub_status ? <span className="text-xs text-[#7A7363]"> ({w.sub_status.replace(/_/g, " ")} only)</span> : null}
                  </p>
                  {!w.revoked_at && canWaive && <RevokeWaiver slug={slug} id={w.id} />}
                </div>
                <p className="text-xs text-[#5F5A4E] mt-0.5">&ldquo;{w.reason}&rdquo;</p>
                <p className="text-xs text-[#7A7363]">
                  {w.waived_by}, {day(w.waived_at)}
                  {w.revoked_at
                    ? ` · revoked by ${w.revoked_by}, ${day(w.revoked_at)}`
                    : new Date(w.waived_at) > new Date(readiness.created_at ?? 0)
                      ? " · applies from the next Readiness re-check or Gate R"
                      : ""}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {chapters.map((c) => (
        <Card key={String(c.chapter)} title={c.chapter != null ? `Chapter ${c.chapter}${c.title ? ` · ${c.title}` : ""}` : "Book-level"}>
          <ul className="divide-y divide-[#EFE8D8]">
            {c.gaps.map((g) => {
              const link = libraryLink(g, curriculum);
              const t = gapTotals(g);
              return (
                <li key={`${g.title}-${g.topic_id ?? ""}`} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-medium">{g.title}</p>
                    <p className="text-xs text-[#7A7363] tabular-nums">
                      {usd(t.usd)} · {t.reviewMin} min review
                    </p>
                  </div>
                  <p className="text-xs text-[#8A4B10] mt-0.5">
                    {STATE_LABEL[g.state] ?? g.state.replace(/_/g, " ")}
                    {g.failing?.length ? ` — ${g.failing.join(", ").replace(/_/g, " ")}` : ""}
                    {g.node_codes?.length ? <span className="text-[#7A7363]"> · objectives {g.node_codes.join(", ")}</span> : null}
                  </p>
                  {g.checks?.some((k) => k.detail) && (
                    <ul className="mt-1.5 space-y-0.5 text-xs text-[#5F5A4E]">
                      {g.checks.map((k, i) => (
                        <li key={i}>
                          <span className={k.verdict === "warn" ? "text-[#7A7363]" : "text-[#8E2A21]"}>{checkName(k.code, k.language)}</span>
                          {k.detail ? `: ${k.detail}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  {g.steps.length > 0 && (
                    <ol className="mt-2 space-y-1 text-sm text-[#5F5A4E] list-decimal ps-5">
                      {g.steps.map((s) => (
                        <li key={s.order}>
                          {s.step}
                          {s.note && <span className="text-xs text-[#7A7363]"> ({s.note})</span>}
                        </li>
                      ))}
                    </ol>
                  )}
                  {canWaive && waivable(g).length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {waivable(g)
                        .filter((k) => !active.some((w) => w.topic_id === g.topic_id && w.check_code === k.code && (w.language ?? null) === k.language && (w.sub_status ?? null) === k.sub_status))
                        .map((k) => (
                          <WaiveCheck
                            key={`${k.code}-${k.language}-${k.sub_status}`}
                            slug={slug}
                            topicId={g.topic_id!}
                            topicTitle={g.title}
                            check={k.code}
                            language={k.language}
                            subStatus={k.sub_status}
                            label={checkName(k.code, k.language)}
                          />
                        ))}
                    </div>
                  )}
                  {link && (
                    <a href={link.href} target="_blank" rel="noreferrer" className="inline-block mt-2 text-sm underline decoration-[#E4DCC8] underline-offset-2 hover:decoration-[#B8862F]">
                      {link.label} ↗
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      ))}
    </div>
  );
}
