"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { kitRows } from "./kit";
import { defaultNarrationForGrade } from "@/utils/narration";

// One-click full kit for a chapter part (0059): queues the video lesson plus
// its five documents together — one lesson credit, documents free. Used on
// per-part rows; the chapter-level row has its own kit flow with narration
// options (chapter-generate.tsx).
export default function GenerateKitButton({
  bookId,
  schoolId,
  chapterNum,
  part = null,
  language = null,
  skipKinds = [],
  bookGrade = null,
  className = "",
  children,
}: {
  bookId: string;
  schoolId: string | null;
  chapterNum: number;
  part?: number | null;
  language?: string | null;
  /** Doc kinds that already exist for this unit (legacy standalone docs) —
      the kit skips them instead of inserting duplicates. */
  skipKinds?: string[];
  /** Book grade — age-appropriate narration default (grades 1–4 → Storytelling). */
  bookGrade?: string | null;
  /** Render the trigger yourself — the whole un-generated lesson card becomes the
      button, so the click target is the card, not a small link at its edge.
      Receives `busy` so the caller can show its own "Queuing…" state. */
  className?: string;
  children?: (state: { busy: boolean }) => React.ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
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
    const rows = kitRows({
      bookId,
      schoolId,
      userId: user.id,
      chapterNum,
      part,
      language,
      narrationStyle: defaultNarrationForGrade(bookGrade),
    }).filter(
      (r) => r.kind === "presentation" || !skipKinds.includes(r.kind),
    );
    const { error: gErr } = await supabase.from("generations").insert(rows);
    setBusy(false);
    if (gErr) {
      setError(gErr.message);
      return;
    }
    router.refresh();
  }

  // Card variant: the caller's whole card IS the button.
  if (children) {
    return (
      <button
        onClick={generate}
        disabled={busy}
        className={className}
        title="Generates the video lesson plus its plan, activities, worksheet, test paper and case study — one lesson credit, documents free"
      >
        {children({ busy })}
        {error && (
          <span className="ml-2 text-[10px] text-red-600 [overflow-wrap:anywhere]">{error}</span>
        )}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-[10px] text-red-600 [overflow-wrap:anywhere]">{error}</span>}
      <button
        onClick={generate}
        disabled={busy}
        className="font-medium text-[#0C8175] hover:underline disabled:opacity-60 text-xs"
        title="Generates the video lesson plus its plan, activities, worksheet, test paper and case study — one lesson credit, documents free"
      >
        {busy ? "Queuing…" : "Generate kit"}
      </button>
    </span>
  );
}
