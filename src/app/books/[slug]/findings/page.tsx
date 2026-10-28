import Link from "next/link";
import RichText from "@/components/rich-text";
import { listFindings } from "@/utils/books/store";
import type { Finding } from "@/utils/books/types";
import { loadBook } from "../load";
import { Card, Chip, Empty } from "../../ui";

// /books/[slug]/findings — every recorded finding (the independent academic
// audits and their verification), with the other validator's ruling and what
// became of it. Read-only in Slice 1; triage (accept/reject with a reason)
// arrives with R1.
const PAGE = 50;
const FILTERS = ["rev", "ch", "severity", "agreement", "status"] as const;

export default async function FindingsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { work, revisions } = await loadBook(slug);
  const all = await listFindings(work.uid);
  const f: Partial<Record<(typeof FILTERS)[number], string>> = {};
  for (const k of FILTERS) if (typeof sp[k] === "string" && sp[k]) f[k] = sp[k] as string;
  const match = (x: Finding) =>
    (!f.rev || x.revision_key === f.rev) &&
    (!f.ch || String(x.chapter) === f.ch) &&
    (!f.severity || x.severity === f.severity) &&
    (!f.agreement || x.agreement === f.agreement) &&
    (!f.status || x.status === f.status);
  const rows = all.filter(match);
  const page = Math.max(1, Number(sp.page) || 1);
  const shown = rows.slice((page - 1) * PAGE, page * PAGE);
  const revLabel = new Map(revisions.map((r) => [r.key, r.label]));
  const link = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams();
    for (const k of FILTERS) if (f[k]) q.set(k, f[k]!);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    const s = q.toString();
    return `/books/${slug}/findings${s ? `?${s}` : ""}`;
  };
  const opts = (key: keyof Finding) => [...new Set(all.map((x) => x[key]).filter((v) => v !== null && v !== undefined).map(String))].sort();
  const facet = (k: (typeof FILTERS)[number], values: string[], label: (v: string) => string = (v) => v) => (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-[#7A7363] w-20">{k === "rev" ? "revision" : k === "ch" ? "chapter" : k}</span>
      <Link href={link({ [k]: null, page: null })} className={`rounded-full border px-2.5 py-0.5 text-xs ${!f[k] ? "border-[#B8862F] bg-[#B8862F] text-white" : "border-[#E4DCC8] bg-white"}`}>
        all
      </Link>
      {values.map((v) => (
        <Link key={v} href={link({ [k]: v, page: null })} className={`rounded-full border px-2.5 py-0.5 text-xs ${f[k] === v ? "border-[#B8862F] bg-[#B8862F] text-white" : "border-[#E4DCC8] bg-white"}`}>
          {label(v)} <span className="opacity-60">{all.filter((x) => String(x[k === "rev" ? "revision_key" : k === "ch" ? "chapter" : k]) === v).length}</span>
        </Link>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      <Card>
        <div className="space-y-2">
          {facet("rev", opts("revision_key"), (v) => revLabel.get(v) ?? v)}
          {facet("ch", opts("chapter").sort((a, b) => Number(a) - Number(b)))}
          {facet("severity", opts("severity"))}
          {facet("agreement", opts("agreement"))}
          {facet("status", opts("status"))}
        </div>
      </Card>
      <p className="text-sm text-[#5F5A4E]">
        {rows.length} finding{rows.length === 1 ? "" : "s"}
        {rows.length > PAGE ? ` · page ${page} of ${Math.ceil(rows.length / PAGE)}` : ""}
      </p>
      {shown.length === 0 ? (
        <Empty>No findings match.</Empty>
      ) : (
        <ul className="space-y-3">
          {shown.map((x) => (
            <li key={x.id} className="rounded-xl border border-[#E4DCC8] bg-white p-4">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {x.severity && <Chip label={x.severity} />}
                {x.agreement && <Chip label={x.agreement} />}
                <Chip label={x.status} />
                <span className="text-[#7A7363]">
                  {revLabel.get(x.revision_key) ?? x.revision_key} · Chapter {x.chapter} · {x.location} · {x.category} · {x.finding_key}
                </span>
              </div>
              {x.quote && (
                <blockquote className="mt-2 border-s-2 border-[#E4DCC8] ps-3 text-sm text-[#5F5A4E] italic">
                  <RichText text={x.quote} />
                </blockquote>
              )}
              {x.problem && <p className="mt-2 text-sm">{x.problem}</p>}
              {x.fix && (
                <p className="mt-1 text-sm text-[#24543A]">
                  <span className="text-xs uppercase tracking-wide">Proposed fix</span> — {x.fix}
                </p>
              )}
              <div className="mt-2 grid gap-1 text-xs text-[#5F5A4E]">
                {x.raised_by.length > 0 && <p>Raised by: {x.raised_by.join(" and ")}{x.confidence !== null ? ` · confidence ${x.confidence}` : ""}</p>}
                {x.ruling?.verdict && (
                  <p>
                    Other validator: <strong>{x.ruling.verdict}</strong>
                    {x.ruling.why ? ` — ${x.ruling.why}` : ""}
                  </p>
                )}
                {x.decision?.applied && (
                  <p>
                    Applied ({x.decision.unit}): {x.decision.applied}
                    {x.decision.verified === true ? " · verified by both validators" : x.decision.verified === false ? " · NOT verified as resolved" : ""}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {rows.length > PAGE && (
        <nav className="flex justify-between text-sm">
          {page > 1 ? <Link href={link({ page: String(page - 1) })}>← Previous</Link> : <span />}
          {page * PAGE < rows.length ? <Link href={link({ page: String(page + 1) })}>Next →</Link> : <span />}
        </nav>
      )}
    </div>
  );
}
