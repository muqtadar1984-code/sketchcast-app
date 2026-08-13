"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { stampConfirmation } from "@/utils/junk-gate";
import JunkGateDialog, { type JunkGateInfo } from "./junk-gate-dialog";

export default function GenerateButton({
  bookId,
  schoolId,
  chapterRef = null,
  kind = "presentation",
  params = null,
  label = "Generate lesson",
  variant = "primary",
  gate = null,
}: {
  bookId: string;
  schoolId: string | null;
  chapterRef?: number | string | null;
  kind?: string;
  params?: Record<string, unknown> | null;
  label?: string;
  variant?: "primary" | "ghost";
  /** Junk-upload gate: non-null for a gated book — ask before inserting, and
      stamp the confirmation into params. Absent = today's behavior. */
  gate?: JunkGateInfo | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onGenerate() {
    // Gated book: ask first. Confirming proceeds with the stamp — nothing is
    // ever hard-blocked (soft confirm only, founder decision).
    if (gate) {
      setGateOpen(true);
      return;
    }
    void insert(false);
  }

  async function insert(confirmed: boolean) {
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
      params: confirmed ? stampConfirmation(params) : params,
      status: "queued",
    });
    setBusy(false);
    setGateOpen(false); // close either way — an error must not hide behind the overlay
    if (gErr) {
      setError(gErr.message);
      return;
    }
    router.refresh();
  }

  const cls =
    variant === "primary"
      ? "btn-primary h-8 px-3 text-xs whitespace-nowrap"
      : "text-xs font-medium text-[#0C8175] hover:underline transition-colors disabled:opacity-50 whitespace-nowrap";

  return (
    <>
      <button onClick={onGenerate} disabled={busy} className={cls}>
        {busy ? "Starting…" : label}
      </button>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      {gateOpen && gate && (
        <JunkGateDialog
          gate={gate}
          busy={busy}
          onConfirm={() => void insert(true)}
          onCancel={() => setGateOpen(false)}
        />
      )}
    </>
  );
}
