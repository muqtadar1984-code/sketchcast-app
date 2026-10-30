// The book workbench (founder 2026-10-30, direction C "Focus page"): ONE view per book — a thin stage spine on the
// left, the reader in the middle, the changes and the approval on the right. Pure: what each chapter and each stage
// is showing, from the records the app already keeps. Logs, runs and costs live in Records (owner only).

export type PlanChapter = { chapter: number; title: string };
export type ChapterRow = { chapter: number; title: string; content_sha256: string; revision_key: string };
export type ApprovalLite = { id: number; kind: string; chapter: number | null; revision_key: string | null; content_sha256: string | null; hash_verified?: boolean | null; approved_on?: string | null };
export type RunLite = { id: number; stage_key: string; status: string; params?: Record<string, number>; chapters?: number[]; created_at?: string; detail?: { summary?: Record<string, unknown> } | null };
export type ReleaseLite = { id: number; release_kind: string; edition_key: string; gate_e_approval_id: number | null; superseded_by: number | null; withdrawn_at: string | null };

export type ChapterState = "approved" | "ready" | "drafting" | "not_drafted";
export type WorkChapter = { chapter: number; title: string; state: ChapterState; sha: string | null };

export type StageState = "done" | "ready" | "running" | "waiting";
export type Stage = { key: "ready" | "chapters" | "book" | "audit" | "final" | "publish"; state: StageState; value?: string; action?: StageAction };
export type StageAction =
  | { kind: "run"; stage: string; params: Record<string, number>; label: string; usd?: number }
  | { kind: "view"; view: "book" }
  | { kind: "gate_e"; run: number };

const LIVE = new Set(["queued", "running"]);

/** A chapter text is approved by a Gate D approval of exactly that text, or by the book approval of a revision in which
 * the chapter had exactly this text (approvals follow the TEXT: a chapter carried unchanged into a newer revision keeps
 * the approval it had). `texts` is every revision's chapter rows. */
export function isApproved(approvals: ApprovalLite[], row: ChapterRow, texts: ChapterRow[] = [row]): boolean {
  return approvals.some(
    (a) =>
      (a.kind === "gate_d" && a.chapter === row.chapter && a.content_sha256 === row.content_sha256) ||
      (a.kind === "book" && texts.some((t) => t.revision_key === a.revision_key && t.chapter === row.chapter && t.content_sha256 === row.content_sha256)),
  );
}

/** The latest done run of these stages that carried a chapter plan. */
export function latestPlan(runs: RunLite[]): PlanChapter[] {
  const r = runs
    .filter((x) => (x.stage_key === "readiness" || x.stage_key === "gate_r") && x.status === "done" && Array.isArray(x.detail?.summary?.plan))
    .sort((a, b) => b.id - a.id)[0];
  return (r?.detail?.summary?.plan as PlanChapter[] | undefined) ?? [];
}

/** Every chapter the book plans or has, in order, with its state. */
export function workChapters(plan: PlanChapter[], rows: ChapterRow[], approvals: ApprovalLite[], runs: RunLite[], texts: ChapterRow[] = rows): WorkChapter[] {
  const byN = new Map<number, WorkChapter>();
  for (const p of plan) byN.set(p.chapter, { chapter: p.chapter, title: p.title, state: "not_drafted", sha: null });
  for (const r of rows) byN.set(r.chapter, { chapter: r.chapter, title: r.title, state: isApproved(approvals, r, texts) ? "approved" : "ready", sha: r.content_sha256 });
  for (const run of runs) {
    if (!LIVE.has(run.status) || !["draft_chapter", "adopt_trial"].includes(run.stage_key)) continue;
    const n = Number(run.params?.chapter ?? run.chapters?.[0]);
    const c = byN.get(n);
    if (c && c.state !== "approved") c.state = "drafting";
  }
  return [...byN.values()].sort((a, b) => a.chapter - b.chapter);
}

/** The chapter the reader opens by default: the first one waiting for approval, else the first drafted, else 1. */
export function defaultChapter(chapters: WorkChapter[]): number | null {
  return (chapters.find((c) => c.state === "ready") ?? chapters.find((c) => c.state === "approved") ?? chapters[0])?.chapter ?? null;
}

function latest(runs: RunLite[], keys: string[], status?: string): RunLite | undefined {
  return runs.filter((r) => keys.includes(r.stage_key) && (!status || r.status === status)).sort((a, b) => b.id - a.id)[0];
}

/** The six stages, top to bottom, each with at most one action. */
export function stages(input: { chapters: WorkChapter[]; runs: RunLite[]; approvals: ApprovalLite[]; releases: ReleaseLite[]; draftUsd: number; auditUsd: number; frontChangedAt?: string | null }): Stage[] {
  const { chapters, runs, approvals, releases } = input;
  const total = chapters.length;
  const approved = chapters.filter((c) => c.state === "approved").length;
  const drafted = chapters.filter((c) => c.state !== "not_drafted").length;
  const out: Stage[] = [];

  const readyRun = latest(runs, ["gate_r", "readiness"]);
  const passed = runs.some((r) => r.stage_key === "gate_r" && r.status === "done" && r.detail?.summary?.passed === true);
  const pct = (latest(runs, ["gate_r", "readiness"], "done")?.detail?.summary?.pct as number | undefined) ?? null;
  out.push({
    key: "ready",
    state: passed || drafted > 0 ? "done" : readyRun && LIVE.has(readyRun.status) ? "running" : "ready",
    value: passed || drafted > 0 ? undefined : pct != null ? `${pct}%` : undefined,
    action: passed || drafted > 0 ? undefined : { kind: "run", stage: pct === 100 ? "gate_r" : "readiness", params: {}, label: pct === 100 ? "Pin sources" : "Check" },
  });

  const nextToDraft = chapters.find((c) => c.state === "not_drafted");
  out.push({
    key: "chapters",
    state: total > 0 && approved === total ? "done" : chapters.some((c) => c.state === "drafting") ? "running" : passed || drafted > 0 ? "ready" : "waiting",
    value: total ? `${approved}/${total}` : undefined,
    action: nextToDraft && (passed || drafted > 0) ? { kind: "run", stage: "draft_chapter", params: { chapter: nextToDraft.chapter }, label: `Draft ${nextToDraft.chapter}`, usd: input.draftUsd } : undefined,
  });

  out.push({ key: "book", state: drafted ? "ready" : "waiting", action: drafted ? { kind: "view", view: "book" } : undefined });

  const audit = latest(runs, ["academic_audit"]);
  const last = total || 1;
  out.push({
    key: "audit",
    state: audit && LIVE.has(audit.status) ? "running" : audit?.status === "done" ? "done" : drafted ? "ready" : "waiting",
    action: drafted && !(audit && LIVE.has(audit.status)) ? { kind: "run", stage: "academic_audit", params: { first: 1, last }, label: audit?.status === "done" ? "Audit again" : "Run audit", usd: input.auditUsd * last } : undefined,
  });

  // a final approval counts only while every chapter is approved and the front matter has not changed since the last
  // compile (a newer draft, chapter edit or front-matter edit reopens the book)
  const allApproved = total > 0 && approved === total;
  const compile = latest(runs, ["compile_book"]);
  const lastCompiled = latest(runs, ["compile_book"], "done");
  const frontNewer = !!input.frontChangedAt && !!lastCompiled?.created_at && input.frontChangedAt > lastCompiled.created_at;
  const gateE = allApproved && !frontNewer ? approvals.filter((a) => a.kind === "gate_e").sort((a, b) => b.id - a.id)[0] : undefined;
  const compiledDone = frontNewer ? undefined : lastCompiled;
  const compiledApprovedText = compiledDone && !gateE ? (compiledDone.detail?.summary?.pdf_sha256 as string | undefined) : undefined;
  let final: Stage = { key: "final", state: "waiting" };
  if (gateE) final = { key: "final", state: "done", value: gateE.approved_on ?? undefined };
  else if (compile && LIVE.has(compile.status)) final = { key: "final", state: "running" };
  else if (compiledApprovedText && compiledDone) final = { key: "final", state: "ready", action: { kind: "gate_e", run: compiledDone.id } };
  else if (total > 0 && approved === total) final = { key: "final", state: "ready", action: { kind: "run", stage: "compile_book", params: { first: 1, last: total }, label: "Compile" } };
  out.push(final);

  const live = releases.find((r) => r.release_kind === "final" && !r.superseded_by && !r.withdrawn_at);
  const releasing = latest(runs, ["release"]);
  let publish: Stage = { key: "publish", state: "waiting" };
  if (live && (!gateE || live.gate_e_approval_id === gateE.id)) publish = { key: "publish", state: "done", value: live.edition_key };
  else if (releasing && LIVE.has(releasing.status)) publish = { key: "publish", state: "running" };
  else if (gateE) publish = { key: "publish", state: "ready", action: { kind: "run", stage: "release", params: { final: 1, reissue: 0 }, label: "Publish" } };
  out.push(publish);
  return out;
}

/** Whether anything is moving, so the workbench refreshes itself while it waits. */
export function anyLive(runs: RunLite[]): boolean {
  return runs.some((r) => LIVE.has(r.status));
}
