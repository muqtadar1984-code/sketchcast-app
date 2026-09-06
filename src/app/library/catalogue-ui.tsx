import Link from "next/link";
import { CATALOGUE_MIGRATION, MATURITY_TONE, TOPIC_STATUS_TONE } from "@/utils/catalogue/status";
import type { BankMaturity, TopicStatus } from "@/utils/catalogue/types";

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

export function CoverageChip({ coverage }: { coverage: "full" | "partial" | string }) {
  return (
    <span className={`chip ${coverage === "full" ? "bg-[#E6F6F2] text-[#0F7A68]" : "bg-[#FFF1D6] text-[#9A6400]"}`}>
      {coverage}
    </span>
  );
}

/** 0112 not applied: explain, don't crash (the /console/content `opsReady` stance). */
export function MissingTablesBanner({ table }: { table?: string }) {
  return (
    <p className="text-sm text-[#9A6400] bg-[#FFF9EE] rounded-lg px-4 py-3">
      The topic-catalogue tables{table ? <> (<span className="font-medium">{table}</span>)</> : null} are not in this
      database yet. Apply <span className="font-medium">{CATALOGUE_MIGRATION}</span>, then reload.
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

/** A coverage bar: covered/total with a whole-percent fill. */
export function CoverageBar({ covered, total, pct }: { covered: number; total: number; pct: number }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-[#5B6470]" title={`${covered} of ${total} nodes have a topic`}>
      <span className="inline-block w-24 h-2 rounded-full bg-[#EEF0EC] overflow-hidden" aria-hidden>
        <span className="block h-full bg-[#7FD8A8]" style={{ width: `${pct}%` }} />
      </span>
      <span className="tabular">
        {covered}/{total} · {pct}%
      </span>
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
