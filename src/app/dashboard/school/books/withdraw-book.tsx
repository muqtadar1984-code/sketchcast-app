"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import type { Dictionary } from "@/i18n/dictionaries";
import { fmt } from "@/i18n/format";

export type WithdrawMessages = Dictionary["school"]["books"]["withdraw"];

type Impact = {
  kits: number;
  teachers: number;
  students: number;
  classes: number;
  teacher_names: string[];
};

// Retiring a book from the school shelf.
//
// This reaches into other people's work across the whole school, so it is
// deliberately a three-step act: ask what it would cost, show that back in
// names and numbers, and then require the book's TITLE typed out. A single
// mis-click cannot do it.
//
// What it does NOT do is delete anything a student did. withdraw_school_book
// unassigns the kits and marks them withdrawn; submissions, progress and every
// analytic built on them survive. The wording below says so plainly, because a
// principal hesitating over this button deserves to know which of those two
// things they are about to do.
//
// Both RPCs are granted to `authenticated` and authorise internally via
// leader_of_school(), so this talks to them directly — a route handler in front
// would add a hop and a second place for the authorisation to drift.
export default function WithdrawBook({
  bookId,
  title,
  t,
}: {
  bookId: string;
  title: string;
  t: WithdrawMessages;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Compare on trimmed, case-folded text: we are guarding against a slip, not
  // testing anyone's typing.
  const confirmed = typed.trim().toLowerCase() === title.trim().toLowerCase();

  async function openDialog() {
    setOpen(true);
    setError(null);
    setTyped("");
    setImpact(null);
    const supabase = createClient();
    const { data, error: e } = await supabase.rpc("school_book_impact", { p_book_id: bookId });
    if (e) {
      setError(t.failed);
      return;
    }
    setImpact(data as Impact);
  }

  async function confirm() {
    if (!confirmed || busy) return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error: e } = await supabase.rpc("withdraw_school_book", { p_book_id: bookId });
    if (e) {
      setError(t.failed);
      setBusy(false);
      return;
    }
    // The affected teachers are told by their own bell, which reads
    // generations.withdrawn_at — nothing to push from here.
    setOpen(false);
    setBusy(false);
    router.refresh();
  }

  return (
    <>
      <button onClick={openDialog} className="btn-ghost h-8 px-2.5 text-xs whitespace-nowrap">
        {t.action}
      </button>

      {open && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-[#14181F]/30" onClick={() => !busy && setOpen(false)} aria-hidden />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={fmt(t.title, { book: title })}
            className="relative card w-full max-w-lg p-6 space-y-4"
          >
            <h2 className="text-xl">{fmt(t.title, { book: title })}</h2>

            {impact === null && !error && <p className="text-sm text-[#5B6470]">{t.checking}</p>}

            {impact && (
              <>
                {impact.kits > 0 ? (
                  <div className="space-y-2">
                    <p className="text-sm text-[#14181F]">
                      {fmt(t.summary, { kits: impact.kits, teachers: impact.teachers })}
                    </p>
                    {impact.teacher_names.length > 0 && (
                      <p className="text-xs text-[#5B6470]">{impact.teacher_names.join(" · ")}</p>
                    )}
                    {(impact.students > 0 || impact.classes > 0) && (
                      <p className="text-sm text-[#14181F]">
                        {fmt(t.unassign, { students: impact.students, classes: impact.classes })}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-[#5B6470]">{t.noKits}</p>
                )}

                {/* The reassurance that matters most, and the one a principal
                    cannot verify for themselves before clicking. */}
                <p className="text-xs text-[#0C8175] bg-[#F1FBF9] border border-[#BDE8E2] rounded-lg px-3 py-2">
                  {t.recordKept}
                </p>

                <label className="block text-sm">
                  <span className="text-[#5B6470]">{fmt(t.typeToConfirm, { book: title })}</span>
                  <input
                    className="field mt-1.5 w-full"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoComplete="off"
                    disabled={busy}
                  />
                </label>
              </>
            )}

            {error && <p className="text-sm text-[#B42318]">{error}</p>}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setOpen(false)} disabled={busy} className="btn-ghost h-9 px-3 text-sm">
                {t.cancel}
              </button>
              <button
                onClick={confirm}
                disabled={!confirmed || busy}
                className="btn-primary h-9 px-3 text-sm disabled:opacity-40"
              >
                {busy ? t.removing : t.confirm}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
