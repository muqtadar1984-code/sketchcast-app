"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

// "New version" — was a bare ↻ that silently DESTROYED the old generation
// (founder 2026-07-21: "people get confused as to the result they should
// expect"). Two real problems, both fixed here:
//
//  1. The output is NOT the same artifact again. The worker sets no temperature
//     or seed, so a regenerated test paper is a genuinely DIFFERENT paper —
//     same chapter, same settings, new questions. The old ↻ icon promised
//     "reload"; the label + dialog now say what actually happens.
//  2. It deleted the old generation row, which cascades to generation_shares,
//     student_progress and submissions — silently destroying students' submitted
//     answers. We now SUPERSEDE instead: the old generation is kept, so anyone
//     already assigned keeps their copy and their work. The dashboard shows the
//     newest generation per unit (lessonFor), so the new one becomes current on
//     its own; older ones stay reachable as previous versions.
//
// Credits are unaffected by keeping the row: 0059 meters on the insert-time
// credit_ledger, which has no FK to generations.

const KIND_NOUN: Record<string, string> = {
  presentation: "video lesson",
  lesson_plan: "lesson plan",
  activity: "activities sheet",
  worksheet: "worksheet",
  exam_paper: "test paper",
  case_study: "case study",
  exam: "exam paper",
};

// A WAND, deliberately not a ↻ refresh arrow: this writes a NEW, different
// artifact. The circular-arrow metaphor reads as "reload the same thing", which
// is exactly the expectation that misled teachers.
function NewVersionIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="inline-block align-[-2px] shrink-0" aria-hidden>
      <path d="M15 4V2M15 10V8M12.5 6h-2M19.5 6h-2" />
      <path d="M4 20l9-9M13.5 8.5l2 2" />
    </svg>
  );
}

type Usage = { shares: number; students: number; submissions: number };

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
  /** Kept for call-site compatibility — deliberately NOT deleted any more. */
  oldArtifactPaths?: string[];
  kind?: string;
  params?: Record<string, unknown> | null;
  /** Compact icon-only trigger (kit cells) — the dialog carries the explanation. */
  icon?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const noun = KIND_NOUN[kind] ?? "item";

  // Pre-flight: is anyone relying on the CURRENT version? Teachers may read
  // progress + submissions for their own generations (0006 RLS), so this needs
  // no extra grant. Best-effort — a failed count must not block the action.
  async function openDialog() {
    setOpen(true);
    setError(null);
    setUsage(null);
    setChecking(true);
    const supabase = createClient();
    const count = async (table: string) => {
      const { count: n } = await supabase
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("generation_id", oldGenId);
      return n ?? 0;
    };
    try {
      const [shares, students, submissions] = await Promise.all([
        count("generation_shares"),
        count("student_progress"),
        count("submissions"),
      ]);
      setUsage({ shares, students, submissions });
    } catch {
      setUsage(null); // unknown — the dialog still explains the change
    }
    setChecking(false);
  }

  async function createVersion() {
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
    // 1. Queue a fresh generation of the same kind and settings.
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
    // 2. Retire the old one — but ONLY when nothing is attached to it. Deleting
    //    a generation cascades to generation_shares, student_progress and
    //    submissions, so an in-use version is KEPT (students keep their copy and
    //    their submitted work). An unused one is removed as before, so the common
    //    "didn't like it, try again" case doesn't accumulate dead files.
    //    usage === null means the check failed → keep, the safe side.
    const unused = !!usage && usage.shares === 0 && usage.students === 0 && usage.submissions === 0;
    if (unused) {
      if (oldArtifactPaths?.length) {
        await supabase.storage.from("artifacts").remove(oldArtifactPaths);
      }
      await supabase.from("generations").delete().eq("id", oldGenId);
    }
    setBusy(false);
    setOpen(false);
    router.refresh();
  }

  // Icon-only on artifact chips (keeps the kit uncluttered — the dialog does the
  // explaining); labelled where there's room.
  const hint = `New version — writes a different ${noun}, keeps this one`;
  const trigger = icon ? (
    <button
      onClick={openDialog}
      disabled={busy}
      title={hint}
      aria-label={hint}
      className="text-[#C6CBC4] hover:text-[#0C8175] disabled:opacity-50"
    >
      <NewVersionIcon />
    </button>
  ) : (
    <button
      onClick={openDialog}
      disabled={busy}
      title={hint}
      className="inline-flex items-center gap-1 text-xs font-medium text-[#9A6400] hover:underline disabled:opacity-50 whitespace-nowrap"
    >
      <NewVersionIcon />
      New version
    </button>
  );

  const inUse = !!usage && (usage.shares > 0 || usage.students > 0 || usage.submissions > 0);

  return (
    <>
      {trigger}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#14181F]/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <h2 className="font-display text-base font-medium">Create a new version?</h2>

            <p className="mt-2 text-sm text-[#5B6470]">
              This writes a <strong>new {noun}</strong> from the same chapter with the same
              settings — the content will be <strong>different</strong>, not a copy of the
              current one.
            </p>

            {checking && <p className="mt-3 text-xs text-[#98A0A9]">Checking who&apos;s using it…</p>}

            {inUse && (
              <div className="mt-3 rounded-lg bg-[#FFF7E6] px-3 py-2 text-xs text-[#9A6400]">
                <p className="font-medium">This one is already in use</p>
                <ul className="mt-1 space-y-0.5">
                  {usage!.shares > 0 && <li>· assigned to {usage!.shares} class{usage!.shares === 1 ? "" : "es"}</li>}
                  {usage!.students > 0 && <li>· {usage!.students} student{usage!.students === 1 ? "" : "s"} opened it</li>}
                  {usage!.submissions > 0 && (
                    <li>· <strong>{usage!.submissions} submitted answer{usage!.submissions === 1 ? "" : "s"}</strong></li>
                  )}
                </ul>
                <p className="mt-1.5">
                  They keep the current version and their work is safe. Assign the new one
                  when it&apos;s ready if you want them to switch.
                </p>
              </div>
            )}

            {!checking && !inUse && (
              <p className="mt-3 text-xs text-[#98A0A9]">
                Nobody has been assigned this one yet, so it will be replaced. Download it
                first if you want to keep it.
              </p>
            )}

            {kind === "presentation" && (
              <p className="mt-3 text-xs text-[#98A0A9]">A new video lesson costs 1 credit.</p>
            )}

            {error && <p className="mt-2 text-xs text-red-600 [overflow-wrap:anywhere]">{error}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setOpen(false)} disabled={busy} className="btn-ghost h-9 px-3 text-sm">
                Cancel
              </button>
              <button onClick={createVersion} disabled={busy} className="btn-primary h-9 px-3 text-sm">
                {busy ? "Queuing…" : "Create new version"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
