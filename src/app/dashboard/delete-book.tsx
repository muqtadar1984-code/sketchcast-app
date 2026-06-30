"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

export default function DeleteBook({
  bookId,
  storagePath,
}: {
  bookId: string;
  storagePath: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    if (!confirm("Delete this book? This can't be undone.")) return;
    setBusy(true);
    const supabase = createClient();
    if (storagePath) {
      await supabase.storage.from("uploads").remove([storagePath]);
    }
    await supabase.from("books").delete().eq("id", bookId);
    setBusy(false);
    router.refresh();
  }

  return (
    <button
      onClick={onDelete}
      disabled={busy}
      aria-label="Delete book"
      title="Delete book"
      className="w-6 h-6 flex items-center justify-center rounded-md text-[#5B6470] hover:bg-[#FCEBEA] hover:text-[#B42318] disabled:opacity-50"
    >
      ✕
    </button>
  );
}
