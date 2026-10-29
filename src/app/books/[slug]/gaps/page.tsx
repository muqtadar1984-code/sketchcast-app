import Link from "next/link";
import { listRuns } from "@/utils/books/store";
import { gapTotals, groupGaps, libraryLink, STATE_LABEL, type Curriculum, type Gap } from "@/utils/books/gaps";
import { loadBook } from "../load";
import { Card, Empty, day, usd } from "../../ui";

// /books/[slug]/gaps — what the book still needs before it can be drafted: every
// topic the latest readiness re-check found outstanding, its next steps with
// measured cost and review time, and a link to the Library page that does them.
// Nothing here changes the catalogue: the work is done in the Library, then a
// fresh Readiness re-check (Pipeline) updates this list.
export default async function GapsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { work } = await loadBook(slug);
  const runs = await listRuns(work.uid);
  const readiness = runs.filter((r) => r.stage_key === "readiness" && r.status === "done").sort((a, b) => b.id - a.id)[0];
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
