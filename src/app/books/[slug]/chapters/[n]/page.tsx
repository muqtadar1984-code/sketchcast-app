import Link from "next/link";
import { notFound } from "next/navigation";
import { getChapter, listAnnotations, listApprovals, listChapterSummaries } from "@/utils/books/store";
import { loadRecords, pickRevision } from "../../load";
import NotDrafted from "../../not-drafted";
import { approvalFor, latestGateD } from "../../approval";
import { canOn } from "@/utils/books-access";
import ApproveGateD from "./approve-gate-d";
import RevisionPicker from "../../revision-picker";
import { BlockView, ExerciseView, type FigureCtx } from "../../blocks";
import { Card, Chip, day } from "../../../ui";

// /books/[slug]/chapters/[n]?rev= — one chapter, as written, at one revision.
export default async function ChapterPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; n: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, n } = await params;
  const sp = await searchParams;
  const num = Number(n);
  if (!Number.isInteger(num)) notFound();
  const { member, work, revisions } = await loadRecords(slug);
  if (!revisions.length) return <NotDrafted slug={slug} />;
  const rev = pickRevision(work, revisions, sp.rev);
  const [chapter, approvals, annotations, summaries] = await Promise.all([
    getChapter(work.uid, rev.key, num),
    listApprovals(work.uid),
    listAnnotations(work.uid),
    listChapterSummaries(work.uid),
  ]);
  if (!chapter) notFound();
  const body = chapter.body;
  const chapters = summaries.filter((c) => c.revision_key === rev.key).map((c) => c.chapter).sort((a, b) => a - b);
  const prevCh = chapters.filter((c) => c < num).pop();
  const nextCh = chapters.find((c) => c > num);
  const ap = approvalFor(approvals, num, rev.key, chapter.content_sha256);
  const lock = latestGateD(approvals, num);
  const ctx: FigureCtx = {
    src: (ref) => `/api/pub/figure?book=${encodeURIComponent(slug)}&rev=${encodeURIComponent(rev.key)}&ch=${num}&ref=${encodeURIComponent(ref)}`,
    figures: body.figures ?? {},
    annotations: new Map(annotations.map((a) => [a.figure_ref, a.body])),
  };
  const gates = body.review?.gates ?? {};

  return (
    <div className="space-y-4">
      <RevisionPicker revisions={revisions} active={rev.key} hrefFor={(k) => `/books/${slug}/chapters/${num}?rev=${encodeURIComponent(k)}`} />
      <div className="grid gap-6 lg:grid-cols-[1fr_17rem]">
        <article className="min-w-0 rounded-xl border border-[#E4DCC8] bg-white px-5 sm:px-8 py-6">
          <p className="text-xs uppercase tracking-wide text-[#7A7363]">Chapter {num}</p>
          <h2 className="font-display text-2xl mb-2">{chapter.title}</h2>
          {body.chapter?.purpose && <p className="text-sm text-[#5F5A4E] mb-4">{body.chapter.purpose}</p>}
          {body.sections.map((s) => (
            <section key={s.sid} className="mt-6">
              <h3 className="font-display text-lg border-b border-[#EFE8D8] pb-1">{s.heading}</h3>
              {s.blocks.map((b, i) => (
                <BlockView key={i} b={b} ctx={ctx} />
              ))}
            </section>
          ))}
          <section className="mt-8">
            <h3 className="font-display text-lg border-b border-[#EFE8D8] pb-1">Practice questions ({body.exercises.length})</h3>
            <ol>
              {body.exercises.map((x, i) => (
                <ExerciseView key={x.xid} x={x} n={i + 1} ctx={ctx} />
              ))}
            </ol>
          </section>
          <nav className="flex justify-between mt-8 text-sm">
            {prevCh ? <Link href={`/books/${slug}/chapters/${prevCh}?rev=${encodeURIComponent(rev.key)}`}>← Chapter {prevCh}</Link> : <span />}
            {nextCh ? <Link href={`/books/${slug}/chapters/${nextCh}?rev=${encodeURIComponent(rev.key)}`}>Chapter {nextCh} →</Link> : <span />}
          </nav>
        </article>

        <aside className="space-y-4">
          <Card title="Approval">
            {ap ? (
              <div className="text-sm space-y-1">
                <Chip label={ap.kind === "book" ? "Approved with the book" : "Gate D approved"} tone="approved" />
                <p className="font-medium mt-1">{ap.label}</p>
                <p className="text-[#7A7363]">
                  {ap.approved_by}, {day(ap.approved_on)}
                </p>
                {ap.basis && <p className="text-xs text-[#5F5A4E]">{ap.basis}</p>}
              </div>
            ) : (
              <p className="text-sm text-[#7A7363]">No approval covers this revision of the chapter.</p>
            )}
            {!ap && rev.key === work.current_revision && canOn(member, work.uid, "approve") && (
              <ApproveGateD slug={slug} chapter={num} rev={rev.key} sha={chapter.content_sha256} />
            )}
            {lock && (
              <p className="text-xs text-[#24543A] mt-3">
                🔒 Gate D approved text. Any change to it is a controlled revision with a diff and the approver&apos;s sign-off.
              </p>
            )}
            {lock?.open_flags?.length ? (
              <div className="mt-2 text-xs">
                <p className="text-[#8A4B10] font-medium">Open flags at approval</p>
                <ul className="list-disc ms-4 text-[#5F5A4E]">
                  {lock.open_flags.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>
          <Card title="This chapter">
            <dl className="text-sm grid grid-cols-2 gap-2">
              <div>
                <dt className="text-xs text-[#7A7363]">Words</dt>
                <dd>{chapter.words?.toLocaleString("en-GB")}</dd>
              </div>
              <div>
                <dt className="text-xs text-[#7A7363]">Pictures</dt>
                <dd>{chapter.figure_refs.length}</dd>
              </div>
            </dl>
            {body.chapter?.node_codes?.length ? <p className="text-xs text-[#7A7363] mt-2">Objectives: {body.chapter.node_codes.join(", ")}</p> : null}
            {Object.keys(gates).length > 0 && (
              <div className="mt-3 space-y-1 text-xs">
                <p className="text-[#7A7363]">Gates at the engine&apos;s last run on this text</p>
                {Object.entries(gates)
                  .filter(([, v]) => typeof v === "string")
                  .map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-2">
                      <span className="text-[#5F5A4E]">{k.replace(/_/g, " ")}</span>
                      <Chip label={String(v)} tone={v === "pass" ? "done" : "open"} />
                    </div>
                  ))}
              </div>
            )}
            <p className="text-[11px] text-[#9A9383] mt-3 break-all">sha256 {chapter.content_sha256.slice(0, 16)}…</p>
          </Card>
        </aside>
      </div>
    </div>
  );
}
