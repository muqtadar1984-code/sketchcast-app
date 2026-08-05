"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { type LibraryMessages } from "./content-cell";

export default function DeleteLesson({
  genId,
  artifactPaths,
  t,
  className = "",
}: {
  genId: string;
  artifactPaths: string[];
  t: LibraryMessages;
  /** Extra classes — kit rows pass "hidden group-hover:inline-flex" so ✕ only
      shows on hover, keeping the row uncluttered. */
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    if (!confirm(t.deleteLesson.confirm)) return;
    setBusy(true);
    const supabase = createClient();

    // Deletion goes through the database now (0073). It used to remove every
    // artifact path from storage and then drop the row, which was safe while
    // one kit owned its files — but a colleague who reused this kit has a row
    // of their own pointing at the SAME objects, and wiping them would leave
    // their lesson pointing at nothing. Only the DB can see who still needs a
    // file, so it deletes the row and hands back the paths that are genuinely
    // unreferenced; we remove exactly those.
    const { data, error } = await supabase.rpc("delete_my_generation", { p_gen: genId });
    if (error) {
      // Pre-0073 database: fall back to the old behaviour rather than leaving
      // the teacher unable to delete anything. Reuse cannot exist there either,
      // so nothing can be sharing these files yet.
      if (artifactPaths.length) await supabase.storage.from("artifacts").remove(artifactPaths);
      await supabase.from("generations").delete().eq("id", genId);
    } else {
      const orphans = (data ?? []) as string[];
      if (orphans.length) await supabase.storage.from("artifacts").remove(orphans);
    }

    setBusy(false);
    router.refresh();
  }

  return (
    <button
      onClick={onDelete}
      disabled={busy}
      aria-label={t.deleteLesson.remove}
      title={t.deleteLesson.remove}
      className={`w-6 h-6 flex items-center justify-center rounded-md text-[#5B6470] hover:bg-[#FCEBEA] hover:text-[#B42318] disabled:opacity-50 ${className}`}
    >
      ✕
    </button>
  );
}
