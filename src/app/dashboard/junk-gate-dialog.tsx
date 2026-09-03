"use client";

import { type DocTypeKey } from "@/utils/junk-gate";
import { type LibraryMessages } from "./labels";

// The junk-upload gate's confirm dialog (soft confirm ONLY — see
// utils/junk-gate.ts). One shared dialog for every surface that inserts
// generation rows: the surface intercepts its action, shows this, and on
// "Generate anyway" proceeds with the confirmation stamped into params.
// Nothing is ever hard-blocked.
//
// Everything the dialog needs travels in ONE JunkGateInfo object, built once
// per book (book-table.tsx) and threaded down — so surfaces without their own
// dictionary slice (generate-button, regenerate-button) need no extra prop.

export type JunkGateInfo = {
  docType: DocTypeKey;
  /** isStructureGate(health) — the worker's facts.chapter_quality.suspect
   *  verdict, computed where the health object is at hand: true swaps the
   *  dialog title and row banner to the structure-problem copy ("check this
   *  book's chapters") instead of the junk-material copy. */
  structure: boolean;
  /** The worker's health.problems[] sentences — quoted as-is (worker-produced
   *  English, untranslated by design; the badge renders them the same way). */
  reasons: string[];
  /** plan_tier === "trial" (NOT beta_tester — that flag goes stale on
   *  upgrade): trial users get a stronger extra line. */
  trial: boolean;
  t: LibraryMessages;
};

export default function JunkGateDialog({
  gate,
  busy = false,
  onConfirm,
  onCancel,
}: {
  gate: JunkGateInfo;
  /** The caller is mid-insert — freeze both buttons and the backdrop. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = gate;
  const docLabel = t.gate.docType[gate.docType] ?? t.gate.docType.other;
  // A book whose CHAPTER MAP the worker judged suspect is gated for that,
  // not for what it is — "Doesn't look like a textbook" over a genuine
  // Cambridge book was the wrong claim on a trust-critical dialog (Sara
  // Junaidi, 2026-08-23). gate.structure carries the worker's own verdict
  // (facts.chapter_quality.suspect); the problems[] sentences below carry
  // the specifics either way.
  const title = gate.structure ? t.gate.structureTitle : t.gate.title;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#14181F]/40" onClick={() => !busy && onCancel()} aria-hidden />
      <div role="dialog" aria-modal="true" aria-label={title} className="relative card w-full max-w-md p-6 space-y-3">
        <h2 className="font-display text-base font-medium">{title}</h2>

        <div className="rounded-lg bg-[#FFF1D6] px-3 py-2 text-xs text-[#9A6400]">
          <p className="font-medium">{docLabel}</p>
          {gate.reasons.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {gate.reasons.map((p, i) => (
                <li key={i}>• {p}</li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-sm text-[#5B6470]">{t.gate.body}</p>
        {gate.trial && <p className="text-sm font-medium text-[#B42318]">{t.gate.trialLine}</p>}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button onClick={onCancel} disabled={busy} className="btn-ghost h-9 px-3 text-sm">
            {t.gate.cancel}
          </button>
          <button onClick={onConfirm} disabled={busy} className="btn-primary h-9 px-3 text-sm">
            {t.gate.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
