"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

export default function GenerateButton({
  bookId,
  schoolId,
  chapterRef = null,
  kind = "presentation",
  params = null,
  label = "Generate lesson",
  variant = "primary",
}: {
  bookId: string;
  schoolId: string | null;
  chapterRef?: number | string | null;
  kind?: string;
  params?: Record<string, unknown> | null;
  label?: string;
  variant?: "primary" | "ghost";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onGenerate() {
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

    // Insert only the generation — a DB trigger creates its job automatically.
    const { error: gErr } = await supabase.from("generations").insert({
      kind,
      book_id: bookId,
      owner_id: user.id,
      school_id: schoolId,
      chapter_ref: chapterRef === null ? null : String(chapterRef),
      params,
      status: "queued",
    });
    setBusy(false);
    if (gErr) {
      setError(gErr.message);
      return;
    }
    router.refresh();
  }

  const cls =
    variant === "primary"
      ? "h-8 px-3 rounded-lg bg-[#2E6B4E] text-white text-xs font-medium hover:bg-[#255A41] disabled:opacity-50 whitespace-nowrap"
      : "text-xs font-medium text-[#2E6B4E] hover:underline disabled:opacity-50 whitespace-nowrap";

  return (
    <>
      <button onClick={onGenerate} disabled={busy} className={cls}>
        {busy ? "Starting…" : label}
      </button>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </>
  );
}
