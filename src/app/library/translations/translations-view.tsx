import Link from "next/link";
import { InkUnderline } from "@/components/ink-mark";
import AutoRefresh from "@/components/auto-refresh";
import { languageLabel } from "@/utils/narration";
import {
  CELL_LABEL,
  buildTranslationMatrix,
  filterMatrixRows,
  totalsByLanguage,
  type CellState,
  type MatrixCell,
  type MatrixFilters,
} from "@/utils/catalogue/translation-matrix";
import { ErrorBanner } from "../catalogue-ui";
import type { MatrixLoad } from "./load";

// The Translations tab's screen (/library/translations): totals per language,
// the filters, and the matrix. A Server Component with no reads of its own —
// page.tsx authenticates and loads, then hands the rows here.

const SHORT_NAME: Record<string, string> = {
  en: "English",
  ar: "Arabic",
  ms: "Malay",
  hi: "Hindi",
  te: "Telugu",
  fr: "French",
  es: "Spanish",
  pt: "Portuguese",
  ur: "Urdu",
  mr: "Marathi",
  "ms-arab": "Jawi",
};

const TONE: Record<CellState, string> = {
  none: "bg-[#F4F5F2] text-[#5B6470]",
  not_ready: "bg-[#F4F5F2] text-[#8A929C] italic",
  queued: "bg-[#FFF1D6] text-[#9A6400]",
  translating: "bg-[#EDE7FB] text-[#5B3FBF]",
  in_review: "bg-[#E3EEFB] text-[#1F5FA8]",
  approved: "bg-[#E6F6F2] text-[#0F7A68]",
  posted: "bg-[#0F7A68] text-white",
  stale: "bg-[#FFF1D6] text-[#9A6400]",
  blocked: "bg-[#FFE9E3] text-[#B3401F]",
  failed: "bg-[#FFE9E3] text-[#B3401F]",
};

const LEGEND: CellState[] = ["posted", "approved", "in_review", "translating", "queued", "failed", "stale", "blocked", "none", "not_ready"];

function Cell({ c }: { c: MatrixCell }) {
  return (
    <Link
      href={c.href}
      title={c.detail ?? c.label}
      className={`block rounded px-1.5 py-1 text-center text-[0.7rem] font-medium whitespace-nowrap hover:ring-2 hover:ring-[#7FD8A8] ${TONE[c.state]}`}
    >
      {c.label}
    </Link>
  );
}

/** The matrix, from the loaded rows: no reads, no auth — the page does both. */
export function TranslationsView({ load, filters: f, languages }: { load: Extract<MatrixLoad, { ok: true }>; filters: MatrixFilters; languages: readonly string[] }) {
  const all = buildTranslationMatrix(load.input, languages);
  const subjects = [...new Set(all.map((r) => (r.subject ?? "").trim()).filter(Boolean))].sort();
  const inSubject = filterMatrixRows(all, { subject: f.subject, missing: "" });
  const rows = filterMatrixRows(inSubject, f);
  const totals = totalsByLanguage(inSubject, languages);
  const englishPosted = inSubject.filter((r) => r.english.state === "posted").length;
  const live = all.some((r) => r.cells.some((c) => c.state === "queued" || c.state === "translating"));

  return (
    <main className="px-6 py-10 max-w-[96rem] mx-auto">
      <AutoRefresh active={live} seconds={30} />
      <Heading />
      <p className="text-[#5B6470] mb-5 max-w-3xl">
        Every topic against every lesson language. Each cell says where that translation stands and opens the review
        inbox on it; hover a cell for the reason or the error. Queue translations from the inbox&apos;s{" "}
        <span className="font-medium">Translate…</span> drawer.
      </p>

      {load.translationsMissing && (
        <ErrorBanner message="The translation columns are not in this database yet (migration 0134) — cells read each kit's own status." />
      )}

      <section className="card p-4 mb-5 overflow-x-auto">
        <h2 className="text-sm font-medium mb-2">
          Totals{f.subject ? ` · ${f.subject}` : ""} <span className="text-[#5B6470] font-normal">— {inSubject.length} topics, {englishPosted} with a current English kit</span>
        </h2>
        <table className="text-sm tabular">
          <thead>
            <tr className="text-left text-[#5B6470]">
              <th className="pr-4 py-1 font-normal">Language</th>
              <th className="px-3 py-1 font-normal">Approved</th>
              <th className="px-3 py-1 font-normal">In review</th>
              <th className="px-3 py-1 font-normal">Translating</th>
              <th className="px-3 py-1 font-normal">Failed</th>
              <th className="px-3 py-1 font-normal">Stale / blocked</th>
              <th className="px-3 py-1 font-normal">Not started</th>
            </tr>
          </thead>
          <tbody>
            {totals.map((t) => (
              <tr key={t.language} className="border-t border-[#EEF0EC]">
                <td className="pr-4 py-1" title={languageLabel(t.language) ?? t.language}>
                  {SHORT_NAME[t.language] ?? t.language} <span className="text-[#8A929C]">{t.language}</span>
                </td>
                <td className="px-3 py-1 text-[#0F7A68] font-medium">{t.approved}</td>
                <td className="px-3 py-1 text-[#1F5FA8]">{t.inReview}</td>
                <td className="px-3 py-1 text-[#5B3FBF]">{t.translating}</td>
                <td className={`px-3 py-1 ${t.failed ? "text-[#B3401F] font-medium" : "text-[#8A929C]"}`}>{t.failed}</td>
                <td className={`px-3 py-1 ${t.attention ? "text-[#9A6400]" : "text-[#8A929C]"}`}>{t.attention}</td>
                <td className="px-3 py-1 text-[#5B6470]">{t.notStarted}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <form method="get" className="card p-4 mb-4 flex flex-wrap items-center gap-3 text-sm">
        <select name="subject" defaultValue={f.subject} className="field h-9 px-2" aria-label="Subject">
          <option value="">Any subject</option>
          {subjects.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select name="missing" defaultValue={f.missing} className="field h-9 px-2" aria-label="Missing a language">
          <option value="">Every topic</option>
          <option value="any">Only topics missing a language</option>
          {languages.map((l) => (
            <option key={l} value={l}>
              Only topics missing {SHORT_NAME[l] ?? l}
            </option>
          ))}
        </select>
        <button className="btn-primary h-9 px-4">Show</button>
        {(f.subject || f.missing) && (
          <Link href="/library/translations" className="text-[#5B6470] hover:text-[#14181F] underline">
            Clear
          </Link>
        )}
        <span className="text-[#5B6470] ml-auto">
          {rows.length} of {inSubject.length} topics
          {load.retired ? ` · ${load.retired} retired hidden` : ""}
        </span>
      </form>

      <div className="flex flex-wrap gap-1.5 mb-3 text-[0.7rem]" aria-label="Legend">
        {LEGEND.map((s) => (
          <span key={s} className={`rounded px-1.5 py-0.5 font-medium ${TONE[s]}`}>
            {CELL_LABEL[s]}
          </span>
        ))}
        <span className="text-[#5B6470] self-center ml-1">“Missing” = not started, not ready, failed, stale or blocked.</span>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-[#F4F5F2] text-[#5B6470]">
            <tr>
              <th className="text-left font-normal px-3 py-2 sticky left-0 bg-[#F4F5F2] min-w-[16rem]">Topic</th>
              <th className="font-normal px-1.5 py-2 border-r border-[#E3E6E0]" title="The source: the current English kit">
                English
              </th>
              {languages.map((l) => (
                <th key={l} className="font-normal px-1.5 py-2" title={languageLabel(l) ?? l}>
                  {SHORT_NAME[l] ?? l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.topicId} className="border-t border-[#EEF0EC] hover:bg-[#FBFCFA]">
                <td className="px-3 py-1.5 sticky left-0 bg-white">
                  <Link href={r.english.href} className="font-medium hover:underline">
                    {r.title}
                  </Link>
                  <div className="text-xs text-[#8A929C]">{r.subject ?? "No subject"}</div>
                </td>
                <td className="px-1 py-1.5 border-r border-[#EEF0EC]">
                  <Cell c={r.english} />
                </td>
                {r.cells.map((c) => (
                  <td key={c.language} className="px-1 py-1.5">
                    <Cell c={c} />
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={languages.length + 2} className="px-3 py-8 text-center text-[#5B6470]">
                  No topics match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}


export function Heading() {
  return (
    <div>
      <h1 className="text-3xl font-display mb-1">Translations</h1>
      <InkUnderline className="block h-3 w-24 mb-3" color="#7FD8A8" />
    </div>
  );
}
