"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

export default function DeleteLesson({
  genId,
  artifactPaths,
}: {
  genId: string;
  artifactPaths: string[];
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
      className="w-6 h-6 flex items-center justify-center rounded-md text-[#6F6A5F] hover:bg-[#FCEBEB] hover:text-[#A32D2D] disabled:opacity-50"
    >
      ✕
    </button>
  );
}
