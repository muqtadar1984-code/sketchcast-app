"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { defaultPresentationParams } from "@/utils/narration";

type Chapter = { num: number; title: string };

// Generates a lesson for every chapter passed in (the parent passes only the
// chapters that don't already have a lesson). Each insert fires the
// on_generation_created trigger → one job each.
export default function GenerateAllButton({
  bookId,
  schoolId,
  chapters,
}: {
  bookId: string;
  schoolId: string | null;
  chapters: Chapter[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (chapters.length === 0) return null;

  async function onGenerateAll() {
    if (
      !confirm(
        `Generate a lesson for ${chapters.length} chapter(s)? Each runs separately and uses Claude credits.`,
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

    const rows = chapters.map((c) => ({
      kind: "presentation",
      book_id: bookId,
      owner_id: user.id,
      school_id: schoolId,
      chapter_ref: String(c.num),
      params: defaultPresentationParams(),
      status: "queued",
    }));
    const { error: gErr } = await supabase.from("generations").insert(rows);
    setBusy(false);
    if (gErr) {
      setError(gErr.message);
      return;
    }
    router.refresh();
  }

  return (
    <>
      <button
        onClick={onGenerateAll}
        disabled={busy}
        className="h-8 px-3 rounded-lg border border-[#1FB8A6] text-[#0C8175] text-xs font-medium hover:bg-[#E2F4F1] disabled:opacity-50 whitespace-nowrap"
      >
        {busy ? "Queuing…" : `Generate all (${chapters.length})`}
      </button>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </>
  );
}
