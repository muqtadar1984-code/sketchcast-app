import Link from "next/link";
import { notFound } from "next/navigation";
import { canOn } from "@/utils/books-access";
import { runnableStage } from "@/utils/books/stages";
import { getBookRun, listRunArtifacts, listRunEvents } from "@/utils/books/runs";
import { listApprovals, listChapterSummaries } from "@/utils/books/store";
import { gateERefusal, printedApproval, type CompiledBook } from "@/utils/books/decide";
import ApproveGateE from "./gate-e";
import { loadBook } from "../../load";
import { Card, bytes } from "../../../ui";
import RunLive from "./run-live";

export const dynamic = "force-dynamic";

// /books/[slug]/runs/[id] — one run: live status, log and cost while it runs
// (the client part polls every few seconds), its files once it has finished.
export default async function RunPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const { member, work } = await loadBook(slug);
  const run = Number.isInteger(Number(id)) ? await getBookRun(work.uid, Number(id)) : null;
  if (!run) notFound();
  const stage = runnableStage(run.stage_key);
  const [events, files] = await Promise.all([listRunEvents(run.id), listRunArtifacts(work.uid, run.id)]);
  const fileHref = (id: number) => `/api/pub/file?book=${encodeURIComponent(slug)}&id=${id}`;
  const pictures = files.filter((a) => /\.png$/i.test(a.rel_path));
  const compiled = run.stage_key === "compile_book" && run.status === "done" ? (run.detail?.summary as CompiledBook | undefined) : undefined;
  const [approvals, texts] = compiled ? await Promise.all([listApprovals(work.uid), listChapterSummaries(work.uid)]) : [[], []];
  const gateE = compiled ? approvals.find((a) => a.kind === "gate_e" && a.content_sha256 === compiled.pdf_sha256) : undefined;
  const refusal = compiled && !gateE ? gateERefusal(compiled, approvals, texts) : null;

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link href={`/books/${slug}/runs`} className="text-[#7A7363] hover:text-[#1F2A24]">← All runs</Link>
      </p>
      <RunLive slug={slug} initialRun={run} initialEvents={events} canControl={!!stage && canOn(member, work.uid, stage.action)} />
      {compiled && (
        <Card title={`Compiled book · ${compiled.pages} pages`}>
          <ul className="text-sm divide-y divide-[#EFE8D8]">
            {compiled.chapters.map((c) => {
              const by = printedApproval(approvals, texts, c.number, c.content_sha256);
              const ok = !!by;
              return (
                <li key={c.number} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                  <span>
                    Chapter {c.number} · {c.title} <span className="text-xs text-[#7A7363]">p. {c.start}, {c.pages} pp</span>
                  </span>
                  <span className={"text-xs " + (ok ? "text-[#24543A]" : "text-[#8A4B10]")}>
                    {!by ? "not approved for this text" : by.kind === "book" ? `approved with the book (${by.revision_key})` : "Gate D approved"}
                  </span>
                </li>
              );
            })}
            {compiled.missing.length > 0 && <li className="py-1.5 text-xs text-[#8A4B10]">Not drafted yet: chapters {compiled.missing.join(", ")}</li>}
          </ul>
          <div className="mt-3">
            {gateE ? (
              <p className="text-sm text-[#24543A]">Approved at Gate E by {gateE.approved_by} on {gateE.approved_on}.</p>
            ) : refusal ? (
              <p className="text-sm text-[#7A7363]">Gate E: {refusal}</p>
            ) : canOn(member, work.uid, "approve") ? (
              <ApproveGateE slug={slug} run={run.id} sha={compiled.pdf_sha256} pages={compiled.pages} />
            ) : (
              <p className="text-sm text-[#7A7363]">Ready for Gate E; an approver approves it.</p>
            )}
          </div>
        </Card>
      )}
      {pictures.length > 0 && (
        <Card title="Pictures from this run">
          {/* e.g. the font proof's first pages, side by side: compare/<font>-p1.png */}
          <div className="grid gap-3 sm:grid-cols-3">
            {pictures.map((a) => (
              <a key={a.id} href={fileHref(a.id)} target="_blank" rel="noreferrer" className="block">
                {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link, not an optimisable asset */}
                <img src={fileHref(a.id)} alt={a.rel_path} className="w-full rounded-md border border-[#E4DCC8] bg-white" loading="lazy" />
                <span className="mt-1 block text-xs text-[#5F5A4E]">{a.rel_path.split("/").slice(-2).join(" / ")}</span>
              </a>
            ))}
          </div>
        </Card>
      )}
      {files.length > 0 && (
        <Card title="Files from this run">
          <ul className="text-sm space-y-1">
            {files.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3">
                <a href={fileHref(a.id)} className="underline decoration-[#E4DCC8] underline-offset-2 hover:decoration-[#B8862F]" target="_blank" rel="noreferrer">
                  {a.rel_path.replace(/^runs\/run-\d+\//, "")}
                </a>
                <span className="text-xs text-[#7A7363]">{bytes(a.bytes)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
