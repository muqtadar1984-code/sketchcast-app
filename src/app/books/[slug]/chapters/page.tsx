import Link from "next/link";
import { listApprovals, listChapterSummaries } from "@/utils/books/store";
import { loadRecords, pickRevision } from "../load";
import NotDrafted from "../not-drafted";
import { approvalFor, latestGateD } from "../approval";
import RevisionPicker from "../revision-picker";
import ChapterBoard from "./board";
import { Card, Chip } from "../../ui";

// /books/[slug]/chapters?rev= — the book's chapters at one revision.
// /books/[slug]/chapters?view=board — the chapter board: each chapter's way through the pipeline.
export default async function ChaptersPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { work, revisions } = await loadRecords(slug);
  if (!revisions.length) return <NotDrafted slug={slug} />;
  const board = sp.view === "board";
  const toggle = (
    <div className="flex gap-1.5 text-xs">
      {[["Table", `/books/${slug}/chapters`, !board], ["Board", `/books/${slug}/chapters?view=board`, board]].map(([label, href, on]) => (
        <Link key={String(label)} href={String(href)} aria-current={on ? "page" : undefined}
          className={`rounded-full border px-2.5 py-0.5 ${on ? "border-[#B8862F] bg-[#B8862F] text-white" : "border-[#E4DCC8] bg-white"}`}>
          {label}
        </Link>
      ))}
    </div>
  );
  if (board) {
    return (
      <div className="space-y-4">
        {toggle}
        <Card>
          <ChapterBoard slug={slug} work={work} revisions={revisions} />
        </Card>
      </div>
    );
  }
  const rev = pickRevision(work, revisions, sp.rev);
  const [all, approvals] = await Promise.all([listChapterSummaries(work.uid), listApprovals(work.uid)]);
  const prev = revisions[revisions.findIndex((r) => r.key === rev.key) - 1];
  const rows = all.filter((c) => c.revision_key === rev.key);
  const prevSha = new Map(all.filter((c) => c.revision_key === prev?.key).map((c) => [c.chapter, c.content_sha256]));

  return (
    <div className="space-y-4">
      {toggle}
      <RevisionPicker revisions={revisions} active={rev.key} hrefFor={(k) => `/books/${slug}/chapters?rev=${encodeURIComponent(k)}`} />
      {rev.summary && <p className="text-sm text-[#5F5A4E]">{rev.summary}</p>}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-[#7A7363]">
              <tr>
                <th className="py-2 pe-3 font-normal">#</th>
                <th className="py-2 pe-3 font-normal">Chapter</th>
                <th className="py-2 pe-3 font-normal text-end">Words</th>
                <th className="py-2 pe-3 font-normal text-end">Questions</th>
                <th className="py-2 pe-3 font-normal text-end">Pictures</th>
                <th className="py-2 pe-3 font-normal">{prev ? `vs ${prev.label}` : ""}</th>
                <th className="py-2 font-normal">Approval</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const ap = approvalFor(approvals, c.chapter, rev.key, c.content_sha256);
                const locked = latestGateD(approvals, c.chapter);
                const changed = prev ? prevSha.get(c.chapter) !== c.content_sha256 : false;
                return (
                  <tr key={c.chapter} className="border-t border-[#EFE8D8]">
                    <td className="py-2.5 pe-3 text-[#7A7363]">{c.chapter}</td>
                    <td className="py-2.5 pe-3">
                      <Link href={`/books/${slug}/chapters/${c.chapter}?rev=${encodeURIComponent(rev.key)}`} className="font-medium hover:underline">
                        {c.title}
                      </Link>
                      {locked && <span className="ms-2 text-xs text-[#24543A]" title="Gate D approved text: any change is a controlled revision">🔒 Gate D</span>}
                    </td>
                    <td className="py-2.5 pe-3 text-end tabular-nums">{c.words?.toLocaleString("en-GB") ?? "—"}</td>
                    <td className="py-2.5 pe-3 text-end tabular-nums">{c.questions ?? "—"}</td>
                    <td className="py-2.5 pe-3 text-end tabular-nums">{c.figure_refs.length}</td>
                    <td className="py-2.5 pe-3">
                      {prev &&
                        (changed ? (
                          <Link href={`/books/${slug}/changes?from=${encodeURIComponent(prev.key)}&to=${encodeURIComponent(rev.key)}&ch=${c.chapter}`} className="text-[#8A4B10] underline">
                            changed
                          </Link>
                        ) : (
                          <span className="text-[#7A7363]">unchanged</span>
                        ))}
                    </td>
                    <td className="py-2.5">{ap ? <Chip label={ap.kind === "book" ? `book · ${ap.approved_on}` : `Gate D · ${ap.approved_on}`} tone="approved" /> : <span className="text-xs text-[#7A7363]">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
