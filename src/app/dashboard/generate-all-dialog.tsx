"use client";

import { useEffect, useState } from "react";
import { fmt } from "@/i18n/format";
import { kitUnitsFor, skipExistingUnits, type ExistingKitRow, type KitUnit } from "./kit";
import {
  DAILY_SOFT_LIMIT,
  ESTIMATE_KINDS,
  etaDisplay,
  etaRange,
  type EstimateKind,
  type KindRate,
} from "@/utils/generate-all-estimate";
import { KIT_CREDITS } from "@/utils/financials";
import { type LibraryMessages } from "./labels";

type Chapter = { num: number; title: string; partCount: number };

/** What GET /api/books/[id]/generate-all answers. */
type Preflight = {
  existing: ExistingKitRow[];
  kitsToday: number;
  unmetered: boolean;
  indexing: boolean;
  ahead: Partial<Record<EstimateKind, number>> | null;
  rates: Record<EstimateKind, KindRate> | null;
};

// The Generate all confirm (surge plan §3.2 item 2), replacing the native
// confirm(). It says the real size of the click before anything is queued:
// how many kits, what they cost, roughly when they'll be done and how many jobs
// are already ahead — and it leaves out units that already have a kit, which
// is what made the 4 duplicate kits on 2026-10-22.
//
// Generate all stays ONE-SHOT (founder decision D2): confirming queues every
// listed unit. The daily warning for unmetered accounts warns and never blocks
// (D4). While the book is being re-indexed the confirm is disabled — 0152
// refuses those inserts server-side; this only says so before the click.
export default function GenerateAllDialog({
  bookId,
  chapters,
  t,
  onConfirm,
  onCancel,
}: {
  bookId: string;
  chapters: Chapter[];
  t: LibraryMessages;
  onConfirm: (units: KitUnit[]) => void;
  onCancel: () => void;
}) {
  const g = t.generateAll;
  const [pre, setPre] = useState<Preflight | null>(null);
  const [failed, setFailed] = useState(false);
  const [skip, setSkip] = useState(true);

  useEffect(() => {
    let live = true;
    fetch(`/api/books/${bookId}/generate-all`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Preflight>) : Promise.reject(new Error(String(r.status)))))
      .then((p) => live && setPre(p))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [bookId]);

  const split = pre ? skipExistingUnits(chapters, pre.existing) : null;
  const units = split ? (skip ? split.toQueue : kitUnitsFor(chapters)) : [];
  const kits = units.length;

  const titleOf = new Map(chapters.map((c) => [c.num, c.title]));
  const unitLabel = (u: KitUnit) => {
    const title = titleOf.get(u.chapterNum) ?? fmt(t.chapter, { n: u.chapterNum + 1 });
    return u.part ? fmt(g.unitPart, { title, part: u.part }) : title;
  };

  let eta: string | null = null;
  if (pre?.ahead && pre.rates && kits > 0) {
    const mine = Object.fromEntries(ESTIMATE_KINDS.map((k) => [k, kits])) as Record<EstimateKind, number>;
    const range = etaRange(pre.ahead, mine, pre.rates);
    if (range) {
      const d = etaDisplay(range);
      const ahead = ESTIMATE_KINDS.reduce((n, k) => n + (pre.ahead?.[k] ?? 0), 0);
      eta = fmt(d.unit === "min" ? g.etaMin : g.etaHours, { low: d.low, high: d.high, ahead });
    }
  }

  const overDaily = !!pre?.unmetered && pre.kitsToday + kits > DAILY_SOFT_LIMIT;
  const canConfirm = !!pre && !pre.indexing && kits > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#14181F]/40" onClick={onCancel} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={g.title}
        className="relative card w-full max-w-md p-6 space-y-3 max-h-[90vh] overflow-y-auto"
      >
        <h2 className="font-display text-base font-medium">{g.title}</h2>

        {!pre && !failed && <p className="text-sm text-[#5B6470]">{g.checking}</p>}
        {failed && <p className="text-sm text-[#B42318]">{g.loadFailed}</p>}

        {pre?.indexing && (
          <div className="rounded-lg bg-[#FFF1D6] px-3 py-2 text-xs text-[#9A6400]">{g.indexing}</div>
        )}

        {pre && !pre.indexing && (
          <>
            {kits > 0 ? (
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {pre.unmetered
                    ? fmt(g.summaryUnmetered, { kits })
                    : fmt(g.summary, { kits, credits: kits * KIT_CREDITS })}
                </p>
                <p className="text-sm text-[#14181F]">{eta ?? g.etaUnknown}</p>
                {eta && <p className="text-xs text-[#5B6470]">{g.etaNote}</p>}
              </div>
            ) : (
              <p className="text-sm text-[#5B6470]">{g.nothingLeft}</p>
            )}

            <p className="text-xs text-[#5B6470]">{g.body}</p>

            {split && split.skipped.length > 0 && (
              <div className="space-y-1">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
                  {g.skipLabel}
                </label>
                <div className="rounded-lg bg-[#EEF3F1] px-3 py-2 text-xs text-[#5B6470]">
                  <p className="font-medium">{fmt(g.skippedList, { n: split.skipped.length })}</p>
                  <ul className="mt-1 space-y-0.5 max-h-32 overflow-y-auto">
                    {split.skipped.map((u) => (
                      <li key={`${u.chapterNum}|${u.part ?? ""}`}>• {unitLabel(u)}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {overDaily && (
              <p className="rounded-lg bg-[#FFF1D6] px-3 py-2 text-xs text-[#9A6400]">
                {fmt(g.dailyWarn, { total: pre.kitsToday + kits })}
              </p>
            )}
          </>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button onClick={onCancel} className="btn-ghost h-9 px-3 text-sm">
            {g.cancel}
          </button>
          <button onClick={() => onConfirm(units)} disabled={!canConfirm} className="btn-primary h-9 px-3 text-sm disabled:opacity-50">
            {fmt(g.confirm, { n: kits })}
          </button>
        </div>
      </div>
    </div>
  );
}
