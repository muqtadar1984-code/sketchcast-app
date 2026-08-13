"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { kitRows } from "./kit";
import { defaultNarrationForGrade } from "@/utils/narration";
import { stampConfirmation } from "@/utils/junk-gate";
import JunkGateDialog, { type JunkGateInfo } from "./junk-gate-dialog";

type Chapter = { num: number; title: string };

// Generates the full KIT (lesson + five documents, 0059) for every chapter
// passed in (the parent passes only the chapters without a lesson). Each row
// fires the on_generation_created trigger → one job each.
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
    if (
      !confirm(
        `Generate the full kit (lesson + documents) for ${chapters.length} chapter(s)? Documents are free; each lesson costs one credit per rendered part (long chapters render as several parts).`,
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
    for (const c of chapters) {
      const rows = kitRows({
        bookId,
        schoolId,
        userId: user.id,
        chapterNum: c.num,
        language,
        narrationStyle: defaultNarrationForGrade(bookGrade),
        // The record that the teacher was warned — on EVERY row this run queues.
      }).map((r) => (confirmed ? { ...r, params: stampConfirmation(r.params) } : r));
      const { error: gErr } = await supabase.from("generations").insert(rows);
      if (gErr) {
        stopError = queued
          ? `Queued ${queued} kit${queued === 1 ? "" : "s"}, then stopped at chapter ${c.num + 1}: ${gErr.message}`
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
