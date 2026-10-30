import Link from "next/link";
import { canOn } from "@/utils/books-access";
import { PIPELINE, runnableStage } from "@/utils/books/stages";
import { estimateRun, listBookRuns, runnerConfig } from "@/utils/books/runs";
import { fixturePath, listStages } from "@/utils/books/store";
import type { Run } from "@/utils/books/types";
import { loadRecords } from "../load";
import { Card, Chip, Empty, day, usd } from "../../ui";
import RunForm from "./run-form";

export const dynamic = "force-dynamic";

const LAYER = { plan: "Plan", produce: "Produce", polish: "Polish" } as const;
const COMES = { S3: "comes with drafting on the server (S3)", S4: "comes with approvals and compile (S4)", R2: "comes with planning (R2)", R3: "comes with the editor (R3)" };

// /books/[slug]/runs — the pipeline: every stage of making a book, in order,
// what this book has done at each, and Run for the stages the books runner can
// carry out today. Below, every run started from the app or a terminal. A run
// executes on the books runner (one AWS Fargate task per run); this page only
// queues, watches and records (R1).
export default async function RunsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { member, work } = await loadRecords(slug);
  const [runs, bookStages] = await Promise.all([listBookRuns(work.uid), listStages(work.uid)]);
  const stageOf = new Map(bookStages.map((s) => [s.key, s]));
  const runnable = [...new Set(PIPELINE.flatMap((p) => p.run))].map((k) => runnableStage(k)!).filter(Boolean);
  const estimates = new Map(
    await Promise.all(
      runnable.map(async (s) => {
        const one = await estimateRun(work.uid, s, Object.fromEntries(s.params.map((p) => [p.key, p.key === "last" ? 1 : p.default])));
        return [s.key, one] as const;
      }),
    ),
  );
  const lastRun = (keys: string[]): Run | undefined => runs.find((r) => keys.includes(r.stage_key));
  const configured = !!runnerConfig() || !!fixturePath();

  return (
    <div className="space-y-4">
      {!configured && (
        <p className="rounded-lg border border-[#EDCB9C] bg-[#FBEBD5] px-4 py-2 text-sm text-[#8A4B10]">
          The books runner is not set up yet: a run you start is recorded and waits in the queue until it is.
        </p>
      )}

      <Card title="Pipeline">
        <ol className="divide-y divide-[#EFE8D8]">
          {PIPELINE.map((p, i) => {
            const before = p.book.map((k) => stageOf.get(k)).filter((s) => !!s);
            const last = lastRun(p.run);
            const layerStart = i === 0 || PIPELINE[i - 1].layer !== p.layer;
            return (
              <li key={p.key} className="py-3">
                {layerStart && <p className="text-[11px] uppercase tracking-wider text-[#9A9483] mb-2">{LAYER[p.layer]}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium">{p.title}</h3>
                  {p.run.length ? <Chip label="runs from the app" tone="done" /> : <span className="text-xs text-[#7A7363]">{p.comes ? COMES[p.comes] : ""}</span>}
                </div>
                <p className="text-sm text-[#5F5A4E] mt-0.5">{p.does}</p>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#7A7363]">
                  {before.map((s) => (
                    <span key={s!.key}>
                      This book: {s!.title} · {s!.status}
                      {s!.finished_on ? ` · ${day(s!.finished_on)}` : ""}
                    </span>
                  ))}
                  {last && (
                    <Link href={`/books/${slug}/runs/${last.id}`} className="underline hover:text-[#1F2A24]">
                      Last run #{last.id}: {last.status}
                      {last.usd !== null && last.usd !== undefined ? ` · ${usd(Number(last.usd))}` : ""} · {day(last.created_at)}
                    </Link>
                  )}
                </div>
                {p.run.map((k) => {
                  const s = runnableStage(k)!;
                  const est = estimates.get(k)!;
                  return (
                    <details key={k} className="mt-2 rounded-lg border border-[#EFE8D8] bg-[#FDFBF6] px-3 py-2">
                      <summary className="cursor-pointer text-sm font-medium">Run: {s.title}</summary>
                      <p className="text-sm text-[#5F5A4E] my-2">{s.summary}</p>
                      <RunForm slug={slug} stage={s} perChapterUsd={est.usd} basis={est.basis} allowed={canOn(member, work.uid, s.action)} />
                    </details>
                  );
                })}
              </li>
            );
          })}
        </ol>
      </Card>

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
