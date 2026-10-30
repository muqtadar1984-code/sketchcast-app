import Link from "next/link";
import { listApprovals, listArtifacts, listOpenItems, listRuns, listStages } from "@/utils/books/store";
import type { Approval } from "@/utils/books/types";
import { canOn } from "@/utils/books-access";
import { listReleases, releaseState } from "@/utils/books/releases";
import { loadRecords } from "../load";
import { Card, Chip, day, usd } from "../../ui";
import WithdrawRelease from "../withdraw-release";

/** "reply hit the output cap (6000)" → "output cap"; the full error is in the tooltip. */
function shortError(e: string): string {
  if (/output cap/i.test(e)) return "output cap";
  if (/ForeignKeyViolation/.test(e)) return "database error";
  if (/CalledProcessError/.test(e)) return "print error";
  return e.split(":")[0];
}

// /books/[slug]/records (owner only) — where the book stands (facts, open items) and its whole life,
// stage by stage, with the approvals, runs and files each stage left.
export default async function BookOverview({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { work, revisions, member } = await loadRecords(slug);
  const [stages, approvals, runs, artifacts, openItems, releases] = await Promise.all([
    listStages(work.uid),
    listApprovals(work.uid),
    listRuns(work.uid),
    listArtifacts(work.uid),
    listOpenItems(work.uid),
    listReleases(work.uid),
  ]);
  const revLabel = new Map(revisions.map((r) => [r.key, r.label]));
  const approvalsFor = (stageKey: string, revisionKey: string | null): Approval[] =>
    approvals.filter((a) => a.stage_key === stageKey || (revisionKey && a.scope === "book" && a.kind === "book" && a.revision_key === revisionKey));
  const f = work.facts ?? {};
  // the latest readiness re-check (Pipeline → Readiness re-check): how ready the book is to draft
  const readiness = runs.filter((r) => (r.stage_key === "readiness" || r.stage_key === "gate_r") && r.status === "done").sort((a, b) => b.id - a.id)[0];
  const rs = readiness?.detail?.summary as { pct?: number; ready?: boolean; outstanding_by_state?: Record<string, number> } | undefined;
  const STATE_LABEL: Record<string, string> = {
    missing_topic: "topics with no catalogue article",
    needs_improvement: "articles needing improvement",
    kit_or_publication_incomplete: "kits or publications incomplete",
    missing_video_publication: "videos not published",
    missing_mapping: "topics not mapped to the curriculum",
    missing_translation: "translations missing",
  };
  const open = openItems.filter((o) => o.status !== "done");

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-6 min-w-0">
        <Card title="Life of the book">
          {stages.length === 0 && (
            <p className="text-sm text-[#7A7363]">Nothing recorded yet: the book is being planned. Its readiness to draft is on the right and on the Pipeline tab.</p>
          )}
          <ol className="relative border-s border-[#E4DCC8] ms-2">
            {stages.map((s) => {
              const ap = approvalsFor(s.key, s.revision_key);
              const rs = runs.filter((r) => r.stage_key === s.key);
              const files = artifacts.filter((a) => a.stage_key === s.key).length;
              return (
                <li key={s.key} className="ms-5 pb-6 last:pb-0">
                  <span className={`absolute -start-[7px] mt-1.5 h-3.5 w-3.5 rounded-full border-2 border-white ${s.status === "done" ? "bg-[#3F7D5A]" : "bg-[#D08A2E]"}`} />
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium">{s.title}</h3>
                    <Chip label={s.status} />
                    <span className="text-xs text-[#7A7363]">
                      {day(s.started_on)}
                      {s.finished_on && s.finished_on !== s.started_on ? ` – ${day(s.finished_on)}` : ""}
                    </span>
                  </div>
                  {s.summary && <p className="text-sm text-[#5F5A4E] mt-1">{s.summary}</p>}
                  {ap.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {ap.map((a) => (
                        <li key={a.id} className="text-sm flex flex-wrap items-center gap-2">
                          <span aria-hidden>✓</span>
                          <span className="font-medium">{a.label}</span>
                          <span className="text-[#7A7363]">
                            {a.approved_by}, {day(a.approved_on)}
                          </span>
                          {a.hash_verified === true && <Chip label="hash verified" tone="done" />}
                          {a.hash_verified === false && <Chip label="hash does not match" tone="failed" />}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#7A7363]">
                    {s.revision_key && (
                      <Link className="underline hover:text-[#1F2A24]" href={`/books/${slug}/chapters?rev=${encodeURIComponent(s.revision_key)}`}>
                        Read {revLabel.get(s.revision_key) ?? s.revision_key}
                      </Link>
                    )}
                    {rs.map((r) => (
                      <span key={r.id}>
                        Run: {r.label}
                        {r.usd !== null ? ` · ${usd(r.usd)}` : ""}
                        {r.status === "partial" && r.detail?._failed
                          ? Object.entries(r.detail._failed).map(([ch, err]) => (
                              <span key={ch} className="text-[#8A4B10]" title={err}>
                                {` · ch ${ch} failed here (${shortError(err)}), finished in a later run`}
                              </span>
                            ))
                          : r.status !== "done"
                            ? ` · ${r.status}`
                            : ""}
                      </span>
                    ))}
                    {files > 0 && (
                      <Link className="underline hover:text-[#1F2A24]" href={`/books/${slug}/files?stage=${s.key}`}>
                        {files} file{files === 1 ? "" : "s"}
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </Card>
      </div>

      <aside className="space-y-6">
        <Card title="Ready to draft">
          {rs?.pct !== undefined ? (
            <div className="text-sm space-y-2">
              <p className="font-display text-3xl">{rs.pct}%</p>
              {rs.ready ? (
                <p className="text-[#24543A]">Ready: every topic the book needs is in the catalogue.</p>
              ) : (
                <ul className="space-y-0.5 text-[#5F5A4E]">
                  {Object.entries(rs.outstanding_by_state ?? {}).map(([k, n]) => (
                    <li key={k}>
                      {n} {STATE_LABEL[k] ?? k.replace(/_/g, " ")}
                    </li>
                  ))}
                </ul>
              )}
              {!rs.ready && (
                <Link href={`/books/${slug}/gaps`} className="block text-sm underline decoration-[#E4DCC8] underline-offset-2 hover:decoration-[#B8862F]">
                  What to do next: the gaps →
                </Link>
              )}
              <Link href={`/books/${slug}/runs/${readiness.id}`} className="text-xs text-[#7A7363] underline hover:text-[#1F2A24]">
                Checked {day(readiness.created_at)} · run #{readiness.id}
              </Link>
            </div>
          ) : (
            <p className="text-sm text-[#7A7363]">
              Not checked from the app yet: Pipeline →{" "}
              <Link href={`/books/${slug}/runs`} className="underline hover:text-[#1F2A24]">Readiness re-check</Link> (free).
            </p>
          )}
        </Card>
        <Card title="Releases (Library and SK)">
          {releases.length ? (
            <ul className="space-y-2 text-sm">
              {releases.slice(0, 6).map((r) => {
                const state = releaseState(r);
                return (
                  <li key={r.id} className={state === "live" ? "" : "text-[#7A7363]"}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span>
                        <span className="font-medium">{r.release_kind === "final" ? "Final" : "Draft"}</span> {r.edition_key}
                      </span>
                      <Chip label={state} tone={state === "live" ? "done" : state === "withdrawn" ? "rejected" : "parked"} />
                    </div>
                    <p className="text-xs text-[#7A7363]">
                      Chapters {r.chapters.map((c) => c.chapter).join(", ")} · {r.revision_key} · {day(r.released_at)}
                      {r.withdrawn_reason ? ` · withdrawn: ${r.withdrawn_reason}` : ""}
                    </p>
                    {state === "live" && canOn(member, work.uid, "approve") && <WithdrawRelease slug={slug} id={r.id} />}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-[#7A7363]">
              Not released yet. Pipeline → <Link href={`/books/${slug}/runs`} className="underline hover:text-[#1F2A24]">Release the book</Link>: a draft (the
              Gate D approved chapters) or the final (after Gate E). SK and the Library read releases.
            </p>
          )}
        </Card>
        <Card title="At a glance">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            {[
              ["Chapters", f.chapters],
              ["Pages (KDP)", f.kdp_pages],
              ["Questions", f.questions],
              ["Pictures", f.figures],
              ["Words", f.words?.toLocaleString("en-GB")],
              ["Ages", work.age_band],
            ].map(([k, v]) => (
              <div key={String(k)}>
                <dt className="text-xs text-[#7A7363]">{k}</dt>
                <dd className="font-medium">{v ?? "—"}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-[#7A7363] mt-3">Curriculum: {work.curriculum_code}</p>
        </Card>
        <Card title={`Open items (${open.length})`}>
          <ul className="space-y-3">
            {open.map((o) => (
              <li key={o.id} className="text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{o.title}</span>
                  <Chip label={o.status} />
                </div>
                {o.detail && <p className="text-[#5F5A4E] mt-0.5">{o.detail}</p>}
                {o.owner && <p className="text-xs text-[#7A7363] mt-0.5">Owner: {o.owner}</p>}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Revisions">
          <ol className="space-y-2 text-sm">
            {revisions.map((r) => (
              <li key={r.key}>
                <Link href={`/books/${slug}/chapters?rev=${encodeURIComponent(r.key)}`} className="font-medium underline-offset-2 hover:underline">
                  {r.label}
                </Link>
                {r.key === work.current_revision && <span className="ms-2"><Chip label="current" tone="done" /></span>}
                {r.summary && <p className="text-xs text-[#7A7363]">{r.summary}</p>}
              </li>
            ))}
          </ol>
        </Card>
      </aside>
    </div>
  );
}
