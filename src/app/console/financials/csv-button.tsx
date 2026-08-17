"use client";

import { buildFinancialsCsv, type CsvSection } from "@/utils/financials";

// Download the three financials tables as one CSV. The server page hands over
// the already-computed rows; the file is assembled entirely client-side
// (Blob + anchor) so no extra route ever serves financial data.
export default function CsvButton({ sections }: { sections: CsvSection[] }) {
  function download() {
    const csv = buildFinancialsCsv(sections);
    // Local date, not UTC — the founder's "today", matching the printed heading.
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sketchcast-financials-${stamp}.csv`;
    a.click();
    // Deferred: a synchronous revoke can race the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return (
    <button
      onClick={download}
      className="print:hidden rounded-lg border border-[#E6E8E4] bg-white px-3 py-1.5 text-sm hover:border-[#1FB8A6]"
    >
      Download CSV
    </button>
  );
}
