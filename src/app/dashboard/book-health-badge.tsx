"use client";

import { useState } from "react";

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

const BAND_STYLE: Record<string, { chip: string; label: string }> = {
  excellent: { chip: "bg-[#E2F4F1] text-[#0C8175]", label: "Excellent" },
  good: { chip: "bg-[#E2F4F1] text-[#0C8175]", label: "Good" },
  fair: { chip: "bg-[#FFF1D6] text-[#9A6400]", label: "Fair" },
  poor: { chip: "bg-[#FCEBEA] text-[#B42318]", label: "Poor" },
};

function Bar({ label, value }: { label: string; value: number }) {
  const tone = value >= 85 ? "#1FB8A6" : value >= 70 ? "#0C8175" : value >= 50 ? "#E6A400" : "#B3401F";
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-20 text-[#5B6470]">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-[#EEF0EC] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: tone }} />
      </div>
      <span className="tabular w-8 text-right text-[#5B6470]">{value}</span>
    </div>
  );
}

export default function BookHealthBadge({ health }: { health: BookHealth | null }) {
  const [open, setOpen] = useState(false);
  if (!health || typeof health.score !== "number") return null;
  const style = BAND_STYLE[health.band] ?? BAND_STYLE.fair;

  return (
    <span className="relative inline-block" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`chip font-sans normal-case tracking-normal ${style.chip}`}
        title="Book health — click for detail"
      >
        Health {health.score} · {style.label}
      </button>

      {open && (
        <span className="absolute right-0 z-30 mt-1 w-72 card p-4 shadow-lg text-left block">
          <span className="flex items-center justify-between mb-2">
            <span className="font-display font-medium text-sm">Book health</span>
            <span className={`chip font-sans normal-case tracking-normal ${style.chip}`}>{health.score}/100</span>
          </span>

          {health.dimensions && (
            <span className="block space-y-1.5 mb-2">
              {typeof health.dimensions.text_layer === "number" && (
                <Bar label="Text quality" value={health.dimensions.text_layer} />
              )}
              {typeof health.dimensions.structure === "number" && (
                <Bar label="Chapters" value={health.dimensions.structure} />
              )}
            </span>
          )}

          {health.facts && (
            <span className="block text-xs text-[#98A0A9] mb-2">
              {health.facts.pages ?? "—"} pages · {health.facts.chapters ?? "—"} chapters ·{" "}
              {health.facts.has_text_layer ? "text PDF" : "scanned"}
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
            <span className="block text-xs text-[#0C8175] font-medium">→ {health.recommendation}</span>
          )}
        </span>
      )}
    </span>
  );
}
