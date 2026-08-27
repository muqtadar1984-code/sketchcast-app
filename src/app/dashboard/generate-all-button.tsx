"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { kitRows, kitUnitsFor } from "./kit";
import { defaultNarrationForGrade } from "@/utils/narration";
import { stampConfirmation } from "@/utils/junk-gate";
import JunkGateDialog, { type JunkGateInfo } from "./junk-gate-dialog";

type Chapter = { num: number; title: string; partCount: number };

// Generates the full KIT (lesson + five documents, 0059) for every chapter
// passed in (the parent passes only the chapters without a lesson). Each row
// fires the on_generation_created trigger → one job each.
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
}: {
  bookId: string;
  schoolId: string | null;
  chapters: Chapter[];
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
  const [gateOpen, setGateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (chapters.length === 0) return null;

  // Gated book (junk-upload gate): its dialog comes FIRST — no point asking
  // the cost question on a run the teacher then abandons; confirming falls
  // through to the normal flow (native cost confirm included) with the stamp.
  function onClick() {
    if (gate) {
      setGateOpen(true);
      return;
    }
    void onGenerateAll(false);
  }

  async function onGenerateAll(confirmed: boolean) {
    setGateOpen(false);
    // Say the real size of the click. The old text promised "Documents are
    // free", which the ledger has never agreed with: every artifact is one
    // credit (fair_use_used sums them all), so a 6-artifact kit is 6.
    const totalKits = chapters.reduce((n, c) => n + Math.max(1, c.partCount), 0);
    const kitsWord = totalKits === 1 ? "kit" : "kits";
    if (
      !confirm(
        `Generate ${totalKits} ${kitsWord} across ${chapters.length} chapter(s)? ` +
          `A chapter with several parts gets one kit per part, built one after another. ` +
          `Each kit is a lesson plus five documents, and every generated item costs one credit.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError("Not signed in.");
      setBusy(false);
      return;
    }

    // One INSERT per kit: hitting the credit cap midway keeps the kits
    // already queued instead of aborting the whole run.
    let queued = 0;
    let stopError: string | null = null;
    // Chapter, then part within it — the order the teacher reads the Library in,
    // and the order the queue will build them in.
    const units = kitUnitsFor(chapters);
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
          ? `chapter ${u.chapterNum + 1} part ${u.part}`
          : `chapter ${u.chapterNum + 1}`;
        stopError = queued
          ? `Queued ${queued} kit${queued === 1 ? "" : "s"}, then stopped at ${where}: ${gErr.message}`
          : gErr.message;
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
        onClick={onClick}
        disabled={busy}
        className="h-8 px-3 rounded-lg border border-[#1FB8A6] text-[#0C8175] text-xs font-medium hover:bg-[#E2F4F1] disabled:opacity-50 whitespace-nowrap"
      >
        {busy ? "Queuing…" : `Generate all (${chapters.length})`}
      </button>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      {gateOpen && gate && (
        <JunkGateDialog
          gate={gate}
          busy={busy}
          onConfirm={() => void onGenerateAll(true)}
          onCancel={() => setGateOpen(false)}
        />
      )}
    </>
  );
}
