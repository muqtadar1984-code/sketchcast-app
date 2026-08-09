"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { type LibraryMessages } from "./content-cell";

/**
 * Remove a generation — and, since 0078, say honestly what that costs.
 *
 * The control now has three faces, driven by the generation's own status:
 *
 *   queued      → **Cancel**. Nothing has run yet, so the BEFORE DELETE trigger
 *                 `credit_ledger_void_unconsumed` (0078) voids the ledger row
 *                 and the credit comes back. The copy says so.
 *   processing  → **disabled**. This is the genuinely bad case: the credit is
 *                 correctly charged (the trigger will not void a claimed job),
 *                 the worker's in-flight artifact INSERT then fails on the
 *                 cascaded FK, and the teacher gets a charge and nothing else.
 *                 Blocking it costs a few minutes and removes the last way to
 *                 pay for nothing. The title has to explain the wait, not just
 *                 grey out.
 *   done/error  → **✕ delete**, unchanged. Deleting work that was consumed
 *                 still charges for it — that is 0059's anti-abuse design and
 *                 it is correct.
 *
 * KNOWN EDGE. The status here is the GENERATION's, which the worker updates
 * separately from (and shortly after) claiming its job row. So there is a
 * millisecond-scale window where the job is already 'processing' while this
 * still reads 'queued' — a cancel landing exactly there is refused a refund by
 * the trigger, which is the conservative side: compute really had begun. The
 * database is the authority on the money; this component only decides what to
 * offer. It never promises a refund it can grant.
 */
export default function DeleteLesson({
  genId,
  status,
  t,
  className = "",
}: {
  genId: string;
  /** The generation's DB status word ("queued" | "processing" | "done" | "error"). */
  status: string;
  t: LibraryMessages;
  /** Extra classes from the call site (layout/spacing). Note it must NOT be a
      hover-only reveal: `opacity-0 group-hover:…` and `hidden group-hover:…`
      delete the control outright on touch, which is where a teacher is most
      likely to want Cancel. */
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const whyId = useId();

  const queued = status === "queued";
  const processing = status === "processing";

  async function onDelete() {
    if (!confirm(queued ? t.deleteLesson.cancelConfirm : t.deleteLesson.confirm)) return;
    setBusy(true);
    const supabase = createClient();

    // Deletion goes through the database (0073). It used to remove every
    // artifact path from storage and then drop the row, which was safe while
    // one kit owned its files — but a colleague who reused this kit has a row
    // of their own pointing at the SAME objects, and wiping them would leave
    // their lesson pointing at nothing. Only the DB can see who still needs a
    // file, so it deletes the row and hands back the paths that are genuinely
    // unreferenced; we remove exactly those.
    //
    // There is no raw `.delete()` fallback any more. 0073 has been live since
    // 2026-08-05, and that path bypassed delete_my_generation's shared-file
    // protection as well as any future RPC-level guard. A failure now surfaces
    // instead of silently taking the unprotected route.
    const { data, error } = await supabase.rpc("delete_my_generation", { p_gen: genId });
    if (error) {
      alert(error.message || t.common.somethingWentWrong);
      setBusy(false);
      return;
    }

    const orphans = (data ?? []) as string[];
    if (orphans.length) await supabase.storage.from("artifacts").remove(orphans);

    setBusy(false);
    router.refresh();
  }

  // Being built: present but inert. Kept in the layout rather than hidden so
  // the row doesn't reflow when it flips back to a live control.
  //
  // This was a <span title="…">, which meant the ONLY way to learn why the ✕
  // does nothing was to hover it. `title` never fires on touch, and an
  // aria-label on a role-less <span> is not reliably announced — so on a phone
  // the teacher tapped a greyed control and got silence, which is the exact
  // interaction that produced the support ticket. Now:
  //   - a real <button>, so it is focusable, in the tab order, and tappable;
  //   - `aria-disabled` rather than `disabled`, because a `disabled` button is
  //     removed from the tab order and still swallows the tap — the state has
  //     to be announced AND the reason has to be reachable;
  //   - the reason is a real element, always in the accessibility tree
  //     (sr-only when collapsed) and revealed visually by the tap.
  if (processing) {
    return (
      <span className={`inline-flex items-center gap-1 ${className}`}>
        <button
          type="button"
          aria-disabled
          aria-describedby={whyId}
          onClick={() => setShowWhy((v) => !v)}
          title={t.deleteLesson.building}
          className="w-6 h-6 flex items-center justify-center rounded-md text-[#C6CBC4] cursor-not-allowed"
        >
          <span aria-hidden>✕</span>
          <span className="sr-only">{t.deleteLesson.remove}</span>
        </button>
        <span
          id={whyId}
          className={
            showWhy
              ? "max-w-[11rem] whitespace-normal text-[11px] leading-tight text-[#5B6470]"
              : "sr-only"
          }
        >
          {t.deleteLesson.building}
        </span>
      </span>
    );
  }

  // Queued: a WORD, not a glyph, because "Cancel" and "✕ delete" now mean
  // different things to the teacher's credit balance and only a word says so.
  //
  // The word is where the width risk is. `common.cancel` is 6 characters in
  // English and was measured at 52px — but it is "రద్దు చేయండి" in Telugu,
  // "रद्द करें" in Hindi and "रद्द करा" in Marathi, and this control sits in
  // dense `shrink-0` table rows on a 375px phone. The cap plus a truncating
  // label means the longest locale steals a bounded amount of the row instead
  // of pushing the lesson title out of it; the full wording stays in the
  // aria-label and the tooltip, so nothing is lost to a screen reader.
  if (queued) {
    return (
      <button
        onClick={onDelete}
        disabled={busy}
        aria-label={t.deleteLesson.cancel}
        title={t.deleteLesson.cancel}
        className={`h-6 max-w-[6.5rem] inline-flex items-center overflow-hidden rounded-md px-1.5 text-[12px] font-medium text-[#5B6470] hover:bg-[#FCEBEA] hover:text-[#B42318] disabled:opacity-50 ${className}`}
      >
        <span className="truncate">{t.common.cancel}</span>
      </button>
    );
  }

  return (
    <button
      onClick={onDelete}
      disabled={busy}
      aria-label={t.deleteLesson.remove}
      title={t.deleteLesson.remove}
      className={`w-6 h-6 flex items-center justify-center rounded-md text-[#5B6470] hover:bg-[#FCEBEA] hover:text-[#B42318] disabled:opacity-50 ${className}`}
    >
      ✕
    </button>
  );
}
