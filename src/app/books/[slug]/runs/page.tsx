import Link from "next/link";
import { canOn } from "@/utils/books-access";
import { RUNNABLE_STAGES } from "@/utils/books/stages";
import { estimateRun, listBookRuns, runnerConfig } from "@/utils/books/runs";
import { fixturePath } from "@/utils/books/store";
import { loadBook } from "../load";
import { Card, Chip, Empty, day, usd } from "../../ui";
import RunForm from "./run-form";

export const dynamic = "force-dynamic";

// /books/[slug]/runs — start a stage, and every run started from the app or a
// terminal, newest first. A run executes on the books runner (one AWS Fargate
// task per run); this page only queues, watches and records (R1, S1).
export default async function RunsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { member, work } = await loadBook(slug);
  const runs = await listBookRuns(work.uid);
  const estimates = await Promise.all(
    RUNNABLE_STAGES.map(async (s) => {
      const one = await estimateRun(work.uid, s, Object.fromEntries(s.params.map((p) => [p.key, p.key === "last" ? 1 : p.default])));
      return { perChapter: one.usd, basis: one.basis };
    }),
  );
  const configured = !!runnerConfig() || !!fixturePath();

  return (
    <div className="space-y-4">
      {!configured && (
        <p className="rounded-lg border border-[#EDCB9C] bg-[#FBEBD5] px-4 py-2 text-sm text-[#8A4B10]">
          The books runner is not set up yet: a run you start is recorded and waits in the queue until it is.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {RUNNABLE_STAGES.map((s, i) => (
          <Card key={s.key} title={s.title}>
            <p className="text-sm text-[#5F5A4E] mb-3">{s.summary}</p>
            <RunForm slug={slug} stage={s} perChapterUsd={estimates[i].perChapter} basis={estimates[i].basis} allowed={canOn(member, work.uid, s.action)} />
          </Card>
        ))}
      </div>

      <Card title="Runs">
        {runs.length === 0 ? (
          <Empty>No runs yet. Runs from before the app (drafting, audits, corrections) are on the Overview and Costs tabs.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-[#7A7363]">
                <tr className="text-start">
                  <th className="py-1.5 pe-3 text-start font-normal">Run</th>
                  <th className="py-1.5 pe-3 text-start font-normal">Status</th>
                  <th className="py-1.5 pe-3 text-start font-normal">Started by</th>
                  <th className="py-1.5 pe-3 text-start font-normal">When</th>
                  <th className="py-1.5 text-end font-normal">Cost</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-t border-[#EFE8D8]">
                    <td className="py-1.5 pe-3">
                      <Link href={`/books/${slug}/runs/${r.id}`} className="underline decoration-[#E4DCC8] underline-offset-2 hover:decoration-[#B8862F]">
                        #{r.id} · {r.label}
                      </Link>
                    </td>
                    <td className="py-1.5 pe-3"><Chip label={r.status} /></td>
                    <td className="py-1.5 pe-3 text-[#5F5A4E]">{r.requested_by ?? r.trigger}</td>
                    <td className="py-1.5 pe-3 text-[#5F5A4E] whitespace-nowrap">{day(r.created_at)}</td>
                    <td className="py-1.5 text-end tabular-nums">{r.usd !== null && r.usd !== undefined ? usd(Number(r.usd)) : r.estimate_usd ? `≈ ${usd(Number(r.estimate_usd))}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
