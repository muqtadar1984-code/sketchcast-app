"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

// Replace a chapter's existing lesson: queue a fresh generation, then remove the
// old deck/video (storage + row). lessonForChapter shows the newest generation,
// so the new (queued) one takes over immediately.
function RefreshIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="inline-block align-[-1px] shrink-0" aria-hidden>
      <path d="M21 12a9 9 0 11-2.64-6.36M21 4v5h-5" />
    </svg>
  );
}

export default function RegenerateButton({
  bookId,
  schoolId,
  chapterRef,
  oldGenId,
  oldArtifactPaths,
  kind = "presentation",
  params = null,
  icon = false,
}: {
  bookId: string;
  schoolId: string | null;
  chapterRef: number | string;
  oldGenId: string;
  oldArtifactPaths: string[];
  kind?: string;
  params?: Record<string, unknown> | null;
  /** Compact icon-only ↻ (kit rows) instead of the "↻ Regenerate" text. */
  icon?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRegen() {
    if (!confirm("Regenerate this chapter? The current deck and video will be replaced."))
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
    // 1. Queue a fresh generation of the same kind (trigger creates its job).
    const { error: gErr } = await supabase.from("generations").insert({
      kind,
      book_id: bookId,
      owner_id: user.id,
      school_id: schoolId,
      chapter_ref: String(chapterRef),
      params,
      status: "queued",
    });
    if (gErr) {
      setError(gErr.message);
      setBusy(false);
      return;
    }
    // 2. Remove the old lesson (storage files + generation row).
    if (oldArtifactPaths.length) {
      await supabase.storage.from("artifacts").remove(oldArtifactPaths);
    }
    await supabase.from("generations").delete().eq("id", oldGenId);
    setBusy(false);
    router.refresh();
  }

  if (icon) {
    return (
      <button
        onClick={onRegen}
        disabled={busy}
        title="Regenerate"
        aria-label="Regenerate"
        className="text-[#C6CBC4] hover:text-[#5B6470] disabled:opacity-50"
      >
        {busy ? <span className="text-[10px]">…</span> : <RefreshIcon />}
        {error && <span className="text-red-600 text-[10px] ml-1">{error}</span>}
      </button>
    );
  }

  return (
    <button
      onClick={onRegen}
      disabled={busy}
      title="Regenerate deck + video"
      className="text-xs font-medium text-[#9A6400] hover:underline disabled:opacity-50 whitespace-nowrap"
    >
      {busy ? "…" : "↻ Regenerate"}
      {error && <span className="text-red-600 ml-1">{error}</span>}
    </button>
  );
}
