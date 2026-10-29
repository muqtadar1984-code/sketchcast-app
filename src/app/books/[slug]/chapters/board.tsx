import Link from "next/link";
import { listApprovals, listChapterSummaries, listCostLines, listFindings, listRuns } from "@/utils/books/store";
import type { BookRevision, Run, Work } from "@/utils/books/types";
import { approvalFor, latestGateD } from "../approval";
import { usd } from "../../ui";

// The chapter board: one row per chapter, its way through the pipeline.
//   drafted       the drafting runs that made it (a chapter that failed in one run and was finished in a later one
//                 shows both)
//   revisions     which revisions changed its text (● changed, · carried forward unchanged)
//   approval      what approves the CURRENT text, and whether the text still matches its Gate D stamp
//   findings      the latest audited revision's findings by status
//   last checks   the newest app run of each read-only stage that covered the chapter
//   spend         every recorded model cost for the chapter
const CHECK_STAGES: [string, string][] = [["coverage", "coverage"], ["academic_audit", "audit"]];

export default async function ChapterBoard({ slug, work, revisions }: { slug: string; work: Work; revisions: BookRevision[] }) {
  const [all, approvals, findings, costs, runs] = await Promise.all([
    listChapterSummaries(work.uid),
    listApprovals(work.uid),
    listFindings(work.uid),
    listCostLines(work.uid),
    listRuns(work.uid),
  ]);
  const current = work.current_revision ?? revisions[revisions.length - 1]?.key;
  const chapters = [...new Set(all.map((c) => c.chapter))].sort((a, b) => a - b);
  const sha = (rev: string, ch: number) => all.find((c) => c.revision_key === rev && c.chapter === ch)?.content_sha256;
  const auditedRev = [...new Set(findings.map((f) => f.revision_key))].sort().pop();
  const drafting = runs.filter((r) => r.stage_key === "drafting" || (r.stage_key === "draft_chapter" && r.status === "done"));
  const appRuns = runs.filter((r) => r.trigger === "app" || r.trigger === "cli").sort((a, b) => b.id - a.id);
  const lastCheck = (stage: string, ch: number): Run | undefined =>
    appRuns.find((r) => r.stage_key === stage && r.status === "done" && (r.chapters ?? []).includes(ch));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-[#7A7363]">
          <tr>
            <th className="py-2 pe-3 font-normal">#</th>
            <th className="py-2 pe-3 font-normal">Drafted</th>
            <th className="py-2 pe-3 font-normal">Text by revision</th>
            <th className="py-2 pe-3 font-normal">Approval of current text</th>
            <th className="py-2 pe-3 font-normal">Findings {auditedRev ? `(${auditedRev})` : ""}</th>
            <th className="py-2 pe-3 font-normal">Last checks</th>
            <th className="py-2 font-normal text-end">Spend</th>
          </tr>
        </thead>
        <tbody>
          {chapters.map((ch) => {
            const now = sha(current, ch);
            const ap = now ? approvalFor(approvals, ch, current, now) : null;
            const stamp = latestGateD(approvals, ch);
            const stampMatches = stamp ? stamp.content_sha256 === now : null;
            const made = drafting.filter((r) => (r.chapters ?? []).includes(ch));
            const failedThen = made.filter((r) => r.detail?._failed && String(ch) in r.detail._failed);
            const fs = findings.filter((f) => f.chapter === ch && f.revision_key === auditedRev);
            const count = (st: string) => fs.filter((f) => f.status === st).length;
            const spend = costs.filter((c) => c.chapter === ch).reduce((s, c) => s + Number(c.usd || 0), 0);
            return (
              <tr key={ch} className="border-t border-[#EFE8D8] align-top">
                <td className="py-2.5 pe-3">
                  <Link href={`/books/${slug}/chapters/${ch}`} className="font-medium hover:underline">{ch}</Link>
                </td>
                <td className="py-2.5 pe-3 text-xs">
                  {made.length ? (
                    <span title={made.map((r) => r.label).join("\n")}>
                      ✓ {made.length} run{made.length === 1 ? "" : "s"}
                      {failedThen.length > 0 && <span className="text-[#8A4B10]"> · failed once, finished later</span>}
                    </span>
                  ) : (
                    <span className="text-[#7A7363]" title="Drafted before run records were kept">✓ (no run record)</span>
                  )}
                </td>
                <td className="py-2.5 pe-3">
                  <span className="inline-flex gap-1.5 font-mono text-xs">
                    {revisions.map((r, i) => {
                      const s = sha(r.key, ch);
                      const prev = i ? sha(revisions[i - 1].key, ch) : undefined;
                      const changed = i === 0 ? !!s : !!s && s !== prev;
                      const href = i ? `/books/${slug}/changes?from=${encodeURIComponent(revisions[i - 1].key)}&to=${encodeURIComponent(r.key)}&ch=${ch}` : undefined;
                      const dot = <span className={changed ? "text-[#8A4B10]" : "text-[#C9C2B0]"}>{changed ? "●" : "·"}</span>;
                      return (
                        <span key={r.key} title={`${r.label}: ${changed ? (i ? "changed" : "first text") : "unchanged"}`}>
                          {changed && href ? <Link href={href}>{dot}</Link> : dot}
                        </span>
                      );
                    })}
                  </span>
                </td>
                <td className="py-2.5 pe-3 text-xs">
                  {ap ? (ap.kind === "book" ? `Book approval · ${ap.approved_on}` : `Gate D · ${ap.approved_on}`) : <span className="text-[#8A4B10]">not approved</span>}
                  {stamp && (
                    <div className={stampMatches ? "text-[#24543A]" : "text-[#8E2A21]"}>
                      {stampMatches ? "🔒 matches its Gate D stamp" : "⚠ changed since its Gate D stamp"}
                    </div>
                  )}
                </td>
                <td className="py-2.5 pe-3 text-xs">
                  {fs.length ? (
                    <Link href={`/books/${slug}/findings?rev=${encodeURIComponent(auditedRev ?? "")}&ch=${ch}`} className="hover:underline">
                      {count("applied")} applied · {count("deferred")} deferred
                      {count("accepted") > 0 && <span className="text-[#8A4B10]"> · {count("accepted")} accepted, not applied</span>}
                      {count("open") > 0 && <span className="text-[#8E2A21]"> · {count("open")} open</span>}
                    </Link>
                  ) : (
                    <span className="text-[#7A7363]">—</span>
                  )}
                </td>
                <td className="py-2.5 pe-3 text-xs">
                  {CHECK_STAGES.map(([stage, label]) => {
                    const r = lastCheck(stage, ch);
                    return r ? (
                      <div key={stage}>
                        <Link href={`/books/${slug}/runs/${r.id}`} className="hover:underline">{label} #{r.id}</Link>
                      </div>
                    ) : null;
                  })}
                  {!CHECK_STAGES.some(([s]) => lastCheck(s, ch)) && <span className="text-[#7A7363]">—</span>}
                </td>
                <td className="py-2.5 text-end tabular-nums text-xs">{usd(spend)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-[#7A7363]">
        Text by revision: one dot per revision ({revisions.map((r) => r.label).join(", ")}); ● the text changed there, · carried forward unchanged. Spend
        includes drafting, audits, corrections and app runs; image renders of the first draft were not recorded.
      </p>
    </div>
  );
}
