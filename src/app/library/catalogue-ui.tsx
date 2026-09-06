import Link from "next/link";
import {
  ARTICLE_JOBS_MIGRATION,
  CATALOGUE_LAYER_MIGRATION,
  CATALOGUE_MIGRATION,
  MATURITY_TONE,
  NODE_KIND_LABEL,
  TOPIC_STATUS_TONE,
  stageLabel,
} from "@/utils/catalogue/status";
import { ARTICLE_STATUS_TONE, FIGURE_STATUS_TONE, articleStatusLabel } from "@/utils/catalogue/article";
import type { ArticleStatus, BankMaturity, FigureStatus, NodeKind, TopicStatus } from "@/utils/catalogue/types";

// Small presentational pieces shared by the portal's screens. No "use client"
// and no server-only imports, so Server Components and client panels can both
// render them (server-client-boundary.test.ts allows Components across the
// boundary; these are all PascalCase components).

export function StatusChip({ status }: { status: TopicStatus | string }) {
  const tone = TOPIC_STATUS_TONE[status as TopicStatus] ?? "bg-[#EEF0EC] text-[#5B6470]";
  return <span className={`chip ${tone}`}>{String(status).replace(/_/g, " ")}</span>;
}

export function MaturityChip({ maturity }: { maturity: BankMaturity | string | null }) {
  const m = (maturity ?? "none") as BankMaturity;
  const tone = MATURITY_TONE[m] ?? MATURITY_TONE.none;
  return (
    <span className={`chip ${tone}`} title="Question-bank maturity (derived; grows as items are approved)">
      bank: {String(m).replace(/_/g, " ")}
    </span>
  );
}

/** A knowledge-article version's status (0112 topic_articles.status). */
export function ArticleStatusChip({ status }: { status: ArticleStatus | string }) {
  const tone = ARTICLE_STATUS_TONE[status as ArticleStatus] ?? "bg-[#EEF0EC] text-[#5B6470]";
  return <span className={`chip ${tone}`}>{articleStatusLabel(status)}</span>;
}

/** A figure's render state (article_figures.status). */
export function FigureStatusChip({ status }: { status: FigureStatus | string }) {
  const tone = FIGURE_STATUS_TONE[status as FigureStatus] ?? "bg-[#EEF0EC] text-[#5B6470]";
  return <span className={`chip ${tone}`}>{String(status)}</span>;
}

export function CoverageChip({ coverage }: { coverage: "full" | "partial" | string }) {
  return (
    <span className={`chip ${coverage === "full" ? "bg-[#E6F6F2] text-[#0F7A68]" : "bg-[#FFF1D6] text-[#9A6400]"}`}>
      {coverage}
    </span>
  );
}

/** A curriculum node's level (0113 `kind`). `inferred` marks a level the
 *  column did not carry and nodeKind() read from the code's shape. */
export function KindChip({ kind, inferred = false }: { kind: NodeKind | null; inferred?: boolean }) {
  if (!kind) return null;
  return (
    <span
      className={`chip bg-[#F4F6F3] text-[#5B6470] ${inferred ? "border border-dashed border-[#C9CFC8]" : ""}`}
      title={inferred ? "Level inferred from the code (kind column unset)" : "Level (curriculum_nodes.kind)"}
    >
      {NODE_KIND_LABEL[kind]}
    </span>
  );
}

const JOB_TONE: Record<string, string> = {
  queued: "bg-[#FFF1D6] text-[#9A6400]",
  processing: "bg-[#EDE7FB] text-[#5B3FBF]",
  done: "bg-[#E6F6F2] text-[#0F7A68]",
  error: "bg-[#FFE9E3] text-[#B3401F]",
};

/** The latest observer job (harvest, derive) on a row: status chip, then
 *  progress / stage while it runs, the date, and the error when it failed. */
export function JobSummary({
  job,
  never = "never",
}: {
  job: { status: string; progress: number | null; stage?: unknown; error: string | null; created_at: string } | null | undefined;
  never?: string;
}) {
  if (!job) return <span className="text-xs text-[#98A0A9]">{never}</span>;
  const stage = job.status === "processing" || job.status === "queued" ? stageLabel(job.stage) : null;
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span>
        <span className={`chip ${JOB_TONE[job.status] ?? "bg-[#EEF0EC] text-[#5B6470]"}`}>{job.status}</span>
        {job.status === "processing" && job.progress != null && <span className="text-xs text-[#5B6470]"> {Math.round(job.progress)}%</span>}
        {stage && <span className="text-xs text-[#5B6470]"> · {stage}</span>}
      </span>
      <span className="text-xs text-[#98A0A9]">{fmtDate(job.created_at)}</span>
      {job.error && (
        <span className="text-xs text-[#B3401F] max-w-xs truncate" title={job.error}>
          {job.error}
        </span>
      )}
    </span>
  );
}

/** A migration not applied: explain, don't crash (the /console/content
 *  `opsReady` stance). 0112 (the tables) by default; pass
 *  `migration={CATALOGUE_LAYER_MIGRATION}` for the 0113 columns, or
 *  `migration={ARTICLE_JOBS_MIGRATION}` for the 0114 ones. */
export function MissingTablesBanner({ table, migration = CATALOGUE_MIGRATION }: { table?: string; migration?: string }) {
  const layer = migration === CATALOGUE_LAYER_MIGRATION;
  const articleJobs = migration === ARTICLE_JOBS_MIGRATION;
  return (
    <p className="text-sm text-[#9A6400] bg-[#FFF9EE] rounded-lg px-4 py-3">
      {articleJobs ? (
        <>
          The article-job columns{table ? <> (<span className="font-medium">{table}</span>)</> : null} — figure render errors,
          one live article job per topic — are not in this database yet.
        </>
      ) : layer ? (
        <>
          The catalogue-layer columns{table ? <> (<span className="font-medium">{table}</span>)</> : null} — node kinds,
          grouped candidates, job inputs — are not in this database yet.
        </>
      ) : (
        <>
          The topic-catalogue tables{table ? <> (<span className="font-medium">{table}</span>)</> : null} are not in this
          database yet.
        </>
      )}{" "}
      Apply <span className="font-medium">{migration}</span>, then reload.
    </p>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return <p className="text-sm text-[#B42318] bg-[#FFF1F0] rounded-lg px-4 py-3">{message}</p>;
}

export function ReadOnlyNote({ what }: { what: string }) {
  return (
    <p className="text-xs text-[#9A6400] bg-[#FFF9EE] rounded-lg px-3 py-2 mb-4">
      Read-only for your role: {what} is for editors and admins.
    </p>
  );
}

/** A coverage bar: covered/total with a whole-percent fill. `unit` names what
 *  is counted ("nodes", "objectives"). */
export function CoverageBar({ covered, total, pct, unit = "nodes" }: { covered: number; total: number; pct: number; unit?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-[#5B6470]" title={`${covered} of ${total} ${unit} have a topic`}>
      <span className="inline-block w-24 h-2 rounded-full bg-[#EEF0EC] overflow-hidden" aria-hidden>
        <span className="block h-full bg-[#7FD8A8]" style={{ width: `${pct}%` }} />
      </span>
      <span className="tabular">
        {covered}/{total} · {pct}%
      </span>
    </span>
  );
}

/** "4/5 objectives mapped" for a sub-strand or unit. */
export function ObjectiveCount({ covered, total }: { covered: number; total: number }) {
  const done = covered === total;
  return (
    <span className={`text-xs tabular ${done ? "text-[#0F7A68]" : "text-[#5B6470]"}`} title={`${covered} of ${total} objectives under this node are mapped`}>
      {covered}/{total} objective{total === 1 ? "" : "s"} mapped
    </span>
  );
}

/** Previous / next links built from a querystring factory. */
export function Pager({ page, pages, href }: { page: number; pages: number; href: (page: number) => string }) {
  if (pages <= 1) return null;
  return (
    <nav className="flex items-center justify-center gap-3 text-sm mt-6" aria-label="Pages">
      {page > 1 ? (
        <Link href={href(page - 1)} className="btn-ghost h-9 px-3 inline-flex items-center">
          ← Previous
        </Link>
      ) : (
        <span className="btn-ghost h-9 px-3 inline-flex items-center opacity-40">← Previous</span>
      )}
      <span className="text-[#5B6470]">
        Page {page} of {pages}
      </span>
      {page < pages ? (
        <Link href={href(page + 1)} className="btn-ghost h-9 px-3 inline-flex items-center">
          Next →
        </Link>
      ) : (
        <span className="btn-ghost h-9 px-3 inline-flex items-center opacity-40">Next →</span>
      )}
    </nav>
  );
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
