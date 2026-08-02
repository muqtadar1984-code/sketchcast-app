"use client";

import { useState } from "react";
import { fmt } from "@/i18n/format";
import { type LibraryMessages } from "./content-cell";

// Book Health Score badge — a compact colored chip on the library row that
// expands to the dimensions, problems, and recommendation. Computed by the
// worker at index time (books.health); this is pure presentation.

export type BookHealth = {
  score: number;
  band: "excellent" | "good" | "fair" | "poor";
  dimensions?: { text_layer?: number; structure?: number };
  facts?: { pages?: number; chapters?: number; has_text_layer?: boolean; text_coverage?: number };
  problems?: string[];
  recommendation?: string | null;
  note?: string | null;
};

// Chip colour per band; the band's WORD comes from the dictionary (t.health.bands),
// keyed by the same band name the worker writes.
const BAND_CHIP: Record<string, string> = {
  excellent: "bg-[#E2F4F1] text-[#0C8175]",
  good: "bg-[#E2F4F1] text-[#0C8175]",
  fair: "bg-[#FFF1D6] text-[#9A6400]",
  poor: "bg-[#FCEBEA] text-[#B42318]",
};

function Bar({ label, value }: { label: string; value: number }) {
  const tone = value >= 85 ? "#1FB8A6" : value >= 70 ? "#0C8175" : value >= 50 ? "#E6A400" : "#B3401F";
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-20 text-[#5B6470]">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-[#EEF0EC] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: tone }} />
      </div>
      <span className="tabular w-8 text-end text-[#5B6470]">{value}</span>
    </div>
  );
}

export default function BookHealthBadge({ health, t }: { health: BookHealth | null; t: LibraryMessages }) {
  const [open, setOpen] = useState(false);
  if (!health || typeof health.score !== "number") return null;
  const chip = BAND_CHIP[health.band] ?? BAND_CHIP.fair;
  const band = (t.health.bands as Record<string, string>)[health.band] ?? t.health.bands.fair;

  return (
    <span data-tour="book-health" className="relative inline-block" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`chip font-sans normal-case tracking-normal ${chip}`}
        title={t.health.hint}
      >
        {fmt(t.health.badge, { score: health.score, band })}
      </button>

      {open && (
        <span className="absolute end-0 z-30 mt-1 w-72 card p-4 shadow-lg text-start block">
          <span className="flex items-center justify-between mb-2">
            <span className="font-display font-medium text-sm">{t.health.title}</span>
            <span className={`chip font-sans normal-case tracking-normal ${chip}`}>
              {fmt(t.health.score, { score: health.score })}
            </span>
          </span>

          {health.dimensions && (
            <span className="block space-y-1.5 mb-2">
              {typeof health.dimensions.text_layer === "number" && (
                <Bar label={t.health.textQuality} value={health.dimensions.text_layer} />
              )}
              {typeof health.dimensions.structure === "number" && (
                <Bar label={t.health.chapters} value={health.dimensions.structure} />
              )}
            </span>
          )}

          {health.facts && (
            <span className="block text-xs text-[#98A0A9] mb-2">
              {fmt(t.health.facts, {
                pages: health.facts.pages ?? "—",
                chapters: health.facts.chapters ?? "—",
                type: health.facts.has_text_layer ? t.health.textPdf : t.health.scanned,
              })}
            </span>
          )}

          {health.note && <span className="block text-xs text-[#5B6470] mb-2">{health.note}</span>}

          {(health.problems ?? []).length > 0 && (
            <span className="block mb-2">
              {health.problems!.map((p, i) => (
                <span key={i} className="block text-xs text-[#9A6400] mb-1">• {p}</span>
              ))}
            </span>
          )}

          {health.recommendation && (
            <span className="block text-xs text-[#0C8175] font-medium"><span className="rtl-flip">→</span> {health.recommendation}</span>
          )}
        </span>
      )}
    </span>
  );
}
