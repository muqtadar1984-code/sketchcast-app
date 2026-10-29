import Link from "next/link";
import { getChapter, listAnnotations, listChapterSummaries } from "@/utils/books/store";
import { diffChapter, type BlockChange, type WordOp } from "@/utils/books/diff";
import { loadBook, pickRevision } from "../load";
import NotDrafted from "../not-drafted";
import RevisionPicker from "../revision-picker";
import { BlockView, type FigureCtx } from "../blocks";
import { Card, Chip, Empty } from "../../ui";

// /books/[slug]/changes?from=&to=&ch= — what changed between two revisions:
// first the chapters that changed, then (with ch) that chapter block by block.
function Words({ ops }: { ops: WordOp[] }) {
  return (
    <p className="leading-relaxed">
      {ops.map((o, i) =>
        o.op === "same" ? (
          <span key={i}>{o.text}</span>
        ) : o.op === "del" ? (
          <del key={i} className="bg-[#F6D9D5] text-[#8E2A21] decoration-[#8E2A21]/60">
            {o.text}
          </del>
        ) : (
          <ins key={i} className="bg-[#D9EEDD] text-[#1E5A35] no-underline">
            {o.text}
          </ins>
        ),
      )}
    </p>
  );
}

function ChangeRow({ c, ctx }: { c: BlockChange; ctx: FigureCtx }) {
  if (c.op === "same") return null;
  const tag = { added: "Added", removed: "Removed", changed: "Changed" }[c.op];
  const tone = { added: "border-[#BCD5C2] bg-[#F3F9F4]", removed: "border-[#E2BAB5] bg-[#FCF3F2]", changed: "border-[#EDCB9C] bg-[#FFFAF2]" }[c.op];
  const type = c.op === "changed" ? c.after.type : c.block.type;
  return (
    <div className={`rounded-lg border ${tone} px-4 py-2 my-2`}>
      <p className="text-xs text-[#7A7363] mb-1">
        {tag} · {type.replace(/_/g, " ")}
      </p>
      {c.op === "changed" ? (
        c.words.some((w) => w.op !== "same") ? (
          <Words ops={c.words} />
        ) : (
          <p className="text-sm text-[#5F5A4E]">Layout or picture settings changed; the words are the same.</p>
        )
      ) : (
        <div className={c.op === "removed" ? "opacity-70" : ""}>
          <BlockView b={c.block} ctx={ctx} />
        </div>
      )}
    </div>
  );
}

export default async function ChangesPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { work, revisions } = await loadBook(slug);
  if (!revisions.length) return <NotDrafted slug={slug} />;
  const to = pickRevision(work, revisions, sp.to);
  const toIdx = revisions.findIndex((r) => r.key === to.key);
  const from = typeof sp.from === "string" ? pickRevision(work, revisions, sp.from) : revisions[Math.max(0, toIdx - 1)];
  const ch = typeof sp.ch === "string" ? Number(sp.ch) : null;
  const summaries = await listChapterSummaries(work.uid);
  const sha = (rev: string) => new Map(summaries.filter((s) => s.revision_key === rev).map((s) => [s.chapter, s]));
  const a = sha(from.key), b = sha(to.key);
  const chapters = [...b.values()].sort((x, y) => x.chapter - y.chapter);
  const href = (f: string, t: string, c?: number | null) => `/books/${slug}/changes?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}${c ? `&ch=${c}` : ""}`;

  let detail: React.ReactNode = null;
  if (ch && Number.isInteger(ch)) {
    const [before, after, annotations] = await Promise.all([getChapter(work.uid, from.key, ch), getChapter(work.uid, to.key, ch), listAnnotations(work.uid)]);
    if (before && after) {
      const d = diffChapter(before.body, after.body);
      const ann = new Map(annotations.map((x) => [x.figure_ref, x.body]));
      const ctxFor = (rev: string, figures: FigureCtx["figures"]): FigureCtx => ({
        src: (ref) => `/api/pub/figure?book=${encodeURIComponent(slug)}&rev=${encodeURIComponent(rev)}&ch=${ch}&ref=${encodeURIComponent(ref)}`,
        figures: figures ?? {},
        annotations: ann,
      });
      const ctxAfter = ctxFor(to.key, after.body.figures ?? {});
      const ctxBefore = ctxFor(from.key, before.body.figures ?? {});
      detail = (
        <Card title={`Chapter ${ch}: ${after.title}`} aside={<span className="text-xs text-[#7A7363]">{from.label} → {to.label}</span>}>
          <p className="text-sm text-[#5F5A4E] mb-3">
            {d.counts.blocksChanged} changed, {d.counts.blocksAdded} added, {d.counts.blocksRemoved} removed block(s); {d.counts.exercisesChanged} question(s) changed or added.
          </p>
          {d.figuresRemoved.length > 0 && (
            <div className="rounded-lg border border-[#E2BAB5] bg-[#FCF3F2] px-4 py-2 mb-3 text-sm">
              <strong className="text-[#8E2A21]">{d.figuresRemoved.length} picture(s) no longer in the chapter.</strong> Check each was meant to go (a correction round once dropped 8 figures).
              <ul className="text-xs mt-1 break-all">{d.figuresRemoved.map((r) => <li key={r}>{r}</li>)}</ul>
            </div>
          )}
          {d.figuresAdded.length > 0 && <p className="text-sm mb-3 text-[#1E5A35]">{d.figuresAdded.length} picture(s) added.</p>}
          {d.sections.filter((s) => s.status !== "same").length === 0 && d.counts.exercisesChanged === 0 ? (
            <Empty>The teaching text and questions are identical.</Empty>
          ) : null}
          {d.sections
            .filter((s) => s.status !== "same")
            .map((s) => (
              <section key={s.sid} className="mt-4">
                <h3 className="font-medium">
                  {s.heading} <Chip label={s.status} tone={s.status === "removed" ? "failed" : s.status === "added" ? "done" : "open"} />
                </h3>
                {s.headingBefore && <p className="text-xs text-[#7A7363]">Heading was: {s.headingBefore}</p>}
                {s.blocks.map((c, i) => (
                  <ChangeRow key={i} c={c} ctx={c.op === "removed" ? ctxBefore : ctxAfter} />
                ))}
              </section>
            ))}
          {d.counts.exercisesChanged > 0 && (
            <section className="mt-6">
              <h3 className="font-medium">Questions</h3>
              {d.exercises
                .filter((x) => x.status !== "same")
                .map((x) => (
                  <div key={x.xid} className="rounded-lg border border-[#E4DCC8] px-4 py-2 my-2 text-sm">
                    <p className="text-xs text-[#7A7363] mb-1">
                      {x.xid} · {x.status}
                    </p>
                    {x.words ? <Words ops={x.words} /> : <p>{(x.after ?? x.before)?.stem}</p>}
                  </div>
                ))}
            </section>
          )}
        </Card>
      );
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-xs text-[#7A7363]">From</p>
        <RevisionPicker revisions={revisions} active={from.key} hrefFor={(k) => href(k, to.key, ch)} />
        <p className="text-xs text-[#7A7363] pt-1">To</p>
        <RevisionPicker revisions={revisions} active={to.key} hrefFor={(k) => href(from.key, k, ch)} />
      </div>
      <Card title={`Chapters: ${from.label} → ${to.label}`}>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {chapters.map((c) => {
            const changed = a.get(c.chapter)?.content_sha256 !== c.content_sha256;
            return (
              <li key={c.chapter}>
                <Link
                  href={href(from.key, to.key, c.chapter)}
                  aria-current={ch === c.chapter ? "page" : undefined}
                  className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm ${ch === c.chapter ? "border-[#B8862F] bg-[#FBF5E8]" : "border-[#EFE8D8] hover:border-[#C9A96B]"}`}
                >
                  <span className="truncate">
                    {c.chapter}. {c.title}
                  </span>
                  {changed ? <Chip label="changed" tone="open" /> : <span className="text-xs text-[#9A9383]">same</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>
      {detail}
    </div>
  );
}
