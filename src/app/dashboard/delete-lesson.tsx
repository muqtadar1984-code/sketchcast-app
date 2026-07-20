"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

export default function DeleteLesson({
  genId,
  artifactPaths,
  className = "",
}: {
  genId: string;
  artifactPaths: string[];
  /** Extra classes — kit rows pass "hidden group-hover:inline-flex" so ✕ only
      shows on hover, keeping the row uncluttered. */
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    if (!confirm("Remove this lesson? This cancels it if it's still running.")) return;
    setBusy(true);
    const supabase = createClient();
    if (artifactPaths.length) {
      await supabase.storage.from("artifacts").remove(artifactPaths);
    }
    await supabase.from("generations").delete().eq("id", genId);
    setBusy(false);
    router.refresh();
  }

  return (
    <button
      onClick={onDelete}
      disabled={busy}
      aria-label="Remove lesson"
      title="Remove lesson"
      className={`w-6 h-6 flex items-center justify-center rounded-md text-[#5B6470] hover:bg-[#FCEBEA] hover:text-[#B42318] disabled:opacity-50 ${className}`}
    >
      ✕
    </button>
  );
}
