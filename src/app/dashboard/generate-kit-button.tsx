"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { kitRows } from "./kit";

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
}: {
  bookId: string;
  schoolId: string | null;
  chapterNum: number;
  part?: number | null;
  language?: string | null;
  /** Doc kinds that already exist for this unit (legacy standalone docs) —
      the kit skips them instead of inserting duplicates. */
  skipKinds?: string[];
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
    const rows = kitRows({ bookId, schoolId, userId: user.id, chapterNum, part, language }).filter(
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

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-[10px] text-red-600 [overflow-wrap:anywhere]">{error}</span>}
      <button
        onClick={generate}
        disabled={busy}
        className="font-medium text-[#0C8175] hover:underline disabled:opacity-60 text-xs"
        title="Generates the video lesson plus its plan, activities, worksheet, exam and case study — one lesson credit, documents free"
      >
        {busy ? "Queuing…" : "Generate kit"}
      </button>
    </span>
  );
}
