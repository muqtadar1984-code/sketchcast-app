"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { kitRows, type KitUnit } from "./kit";
import { defaultNarrationForGrade } from "@/utils/narration";
import { stampConfirmation } from "@/utils/junk-gate";
import JunkGateDialog, { type JunkGateInfo } from "./junk-gate-dialog";
import GenerateAllDialog from "./generate-all-dialog";
import { fmt } from "@/i18n/format";
import { type LibraryMessages } from "./labels";
import { useBusyWhile } from "@/components/loading/loading-indicator";

type Chapter = { num: number; title: string; partCount: number };

// Generates the full KIT (lesson + deck + five documents, 0059) for every unit
// of the book that has none yet. The parent passes EVERY chapter; the confirm
// dialog (generate-all-dialog.tsx) reads the book's kits fresh and leaves out
// the units that already have one. Each row fires the on_generation_created
// trigger → one job each.
//
// PER PART, not per chapter (founder decision 2026-08-27). A chapter with a
// part map used to get ONE chapter-level kit: a single presentation that
// rendered as N video parts, plus one set of documents for the whole chapter.
// The Library then still showed N empty "Generate kit" rows underneath it, so
// the same chapter appeared twice — once as a block of Pt chips, once as a list
// of rows asking for more credits. Sara hit exactly that on a 4-part Magnetism
// chapter. Queuing the parts themselves means the rows the teacher can see are
// the rows that fill in, and each part gets its own worksheet, activity and
// case study for the week it is taught.
//
// ONE PART AT A TIME. Each part is its own INSERT, so its rows carry a later
// created_at than the part before — and claim_next_job orders by created_at.
// Part 1 builds while the rest sit visibly queued, then part 2 starts. Batching
// them into a single statement would give every row the same timestamp and let
// the queue pick them in any order.
export default function GenerateAllButton({
  bookId,
  schoolId,
  chapters,
  language = null,
  bookGrade = null,
  gate = null,
  missing,
  t,
}: {
  bookId: string;
  schoolId: string | null;
  /** Every chapter of the book, with its part count. */
  chapters: Chapter[];
  /** Units without a kit as of the page render — the button's count. The
      dialog re-reads the real list before anything is queued. */
  missing: number;
  t: LibraryMessages;
  /** Detected book language (0056) — lessons inherit it + its voice. */
  language?: string | null;
  /** Book grade — age-appropriate narration default (grades 1–4 → Storytelling). */
  bookGrade?: string | null;
  /** Junk-upload gate: non-null for a gated book — the whole-book run confirms
      first (this is the single most expensive click on a junk upload). */
  gate?: JunkGateInfo | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // The app-wide spinner follows this control's own busy state.
  useBusyWhile(busy);
  const [gateOpen, setGateOpen] = useState(false);
  // Non-null while the cost dialog is open: whether the junk-gate was
  // confirmed on the way in (its stamp then rides on every row).
  const [costOpen, setCostOpen] = useState<{ confirmed: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const g = t.generateAll;

  if (chapters.length === 0 || missing === 0) return null;

  // Gated book (junk-upload gate): its dialog comes FIRST — no point asking
  // the cost question on a run the teacher then abandons; confirming falls
  // through to the cost dialog with the stamp.
  function onClick() {
    if (gate) {
      setGateOpen(true);
      return;
    }
    setCostOpen({ confirmed: false });
  }

  async function onGenerateAll(units: KitUnit[], confirmed: boolean) {
    setCostOpen(null);
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError(t.notSignedIn);
      setBusy(false);
      return;
    }

    // One INSERT per kit: hitting the credit cap midway keeps the kits
    // already queued instead of aborting the whole run.
    let queued = 0;
    let stopError: string | null = null;
    // Chapter, then part within it — the order the teacher reads the Library in,
    // and the order the queue will build them in (the dialog keeps
    // kitUnitsFor's order).
    for (const u of units) {
      const rows = kitRows({
        bookId,
        schoolId,
        userId: user.id,
        chapterNum: u.chapterNum,
        part: u.part,
        language,
        narrationStyle: defaultNarrationForGrade(bookGrade),
        // The record that the teacher was warned — on EVERY row this run queues.
      }).map((r) => (confirmed ? { ...r, params: stampConfirmation(r.params) } : r));
      const { error: gErr } = await supabase.from("generations").insert(rows);
      if (gErr) {
        // Name the unit that stopped it: "chapter 9" is not enough to find when
        // the run was queuing part 3 of it.
        const where = u.part
          ? fmt(g.wherePart, { n: u.chapterNum + 1, part: u.part })
          : fmt(g.whereChapter, { n: u.chapterNum + 1 });
        stopError = queued ? fmt(g.stoppedAt, { queued, where, error: gErr.message }) : gErr.message;
        break;
      }
      queued++;
    }
    setBusy(false);
    if (stopError) {
      setError(stopError);
    }
    router.refresh();
  }

  return (
    <>
      <button
        data-tour="generate-all"
        onClick={onClick}
        disabled={busy}
        className="h-8 px-3 rounded-lg border border-[#1FB8A6] text-[#0C8175] text-xs font-medium hover:bg-[#E2F4F1] disabled:opacity-50 whitespace-nowrap"
      >
        {busy ? t.queuing : fmt(g.button, { n: missing })}
      </button>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      {gateOpen && gate && (
        <JunkGateDialog
          gate={gate}
          busy={busy}
          onConfirm={() => {
            setGateOpen(false);
            setCostOpen({ confirmed: true });
          }}
          onCancel={() => setGateOpen(false)}
        />
      )}
      {costOpen && (
        <GenerateAllDialog
          bookId={bookId}
          chapters={chapters}
          t={t}
          onConfirm={(units) => void onGenerateAll(units, costOpen.confirmed)}
          onCancel={() => setCostOpen(null)}
        />
      )}
    </>
  );
}
