"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

export default function GenerateButton({
  bookId,
  schoolId,
}: {
  bookId: string;
  schoolId: string | null;
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
      kind: "presentation",
      book_id: bookId,
      owner_id: user.id,
      school_id: schoolId,
      status: "queued",
    });
    setBusy(false);
    if (gErr) {
      setError(gErr.message);
      return;
    }
    router.refresh();
  }

  return (
    <div>
      <button
        onClick={onGenerate}
        disabled={busy}
        className="w-full h-9 mt-3 rounded-lg bg-[#2E6B4E] text-white text-sm font-medium hover:bg-[#255A41] disabled:opacity-50"
      >
        {busy ? "Starting…" : "Generate lesson"}
      </button>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}
