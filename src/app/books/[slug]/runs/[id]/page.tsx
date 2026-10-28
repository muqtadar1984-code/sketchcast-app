import Link from "next/link";
import { notFound } from "next/navigation";
import { canOn } from "@/utils/books-access";
import { runnableStage } from "@/utils/books/stages";
import { getBookRun, listRunArtifacts, listRunEvents } from "@/utils/books/runs";
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

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link href={`/books/${slug}/runs`} className="text-[#7A7363] hover:text-[#1F2A24]">← All runs</Link>
      </p>
      <RunLive slug={slug} initialRun={run} initialEvents={events} canControl={!!stage && canOn(member, work.uid, stage.action)} />
      {files.length > 0 && (
        <Card title="Files from this run">
          <ul className="text-sm space-y-1">
            {files.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3">
                <a href={`/api/pub/file?book=${encodeURIComponent(slug)}&id=${a.id}`} className="underline decoration-[#E4DCC8] underline-offset-2 hover:decoration-[#B8862F]" target="_blank" rel="noreferrer">
                  {a.title}
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
