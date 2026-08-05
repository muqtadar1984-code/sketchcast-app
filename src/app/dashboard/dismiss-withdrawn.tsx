"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

// Acknowledging the withdrawal notice. Writes profiles.books_seen_at, which
// 0070 grants `authenticated` UPDATE on for that column ALONE — the same
// column-grant pattern the other watermarks use (0055, 0064, 0068), so a client
// can mark something read without being handed write access to its own profile.
//
// The timestamp is passed in rather than using now(): it is the newest
// withdrawal actually on screen, so anything that lands between render and
// click stays unread instead of being silently dismissed.
export default function DismissWithdrawn({ seenAt, label }: { seenAt: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function dismiss() {
    if (busy) return;
    setBusy(true);
    const supabase = createClient();
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      await supabase.from("profiles").update({ books_seen_at: seenAt }).eq("id", data.user.id);
    }
    router.refresh();
    setBusy(false);
  }

  return (
    <button
      onClick={dismiss}
      disabled={busy}
      aria-label={label}
      title={label}
      className="shrink-0 text-[#98A0A9] hover:text-[#14181F] text-lg leading-none px-1 disabled:opacity-40"
    >
      ×
    </button>
  );
}
