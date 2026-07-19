"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { defaultParams } from "../options-modal";
import { defaultPresentationParams } from "@/utils/narration";

// Generate a test paper for a chapter, and assign a finished one to a child.
// Since 0059, papers ride with the chapter's lesson: without one, this queues
// lesson + paper together (one credit); with one, the paper alone is free.
// The DB enforces every boundary — these components make the happy path easy.

export function GeneratePaperButton({
  bookId,
  chapterNum,
  hasLesson = false,
}: {
  bookId: string;
  chapterNum: number;
  /** The chapter's lesson already exists — the paper alone is a free add-back. */
  hasLesson?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
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
    // 0059: documents ride with their lesson. If the chapter's lesson exists,
    // the paper is a free add-back; otherwise queue lesson + paper together
    // (one lesson credit) — the presentation row must stay FIRST so the DB's
    // docs-with-lesson guard sees it.
    type Row = {
      kind: string;
      book_id: string;
      owner_id: string;
      school_id: string | null;
      chapter_ref: string;
      params: Record<string, unknown>;
      status: string;
    };
    const paperRow: Row = {
      kind: "exam_paper",
      book_id: bookId,
      owner_id: user.id,
      school_id: null,
      chapter_ref: String(chapterNum),
      params: { ...defaultParams("exam_paper") },
      status: "queued",
    };
    const rows: Row[] = hasLesson
      ? [paperRow]
      : [
          {
            kind: "presentation",
            book_id: bookId,
            owner_id: user.id,
            school_id: null,
            chapter_ref: String(chapterNum),
            params: defaultPresentationParams(null),
            status: "queued",
          },
          paperRow,
        ];
    const { error: gErr } = await supabase.from("generations").insert(rows);
    setBusy(false);
    if (gErr) {
      setError(gErr.message);
      return;
    }
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button
        onClick={generate}
        disabled={busy}
        className="btn-primary h-8 px-3 text-xs"
        title={
          hasLesson
            ? "Free — the paper reuses this chapter's lesson analysis"
            : "One lesson credit — generates the chapter's video lesson and the test paper together"
        }
      >
        {busy ? "Queuing…" : hasLesson ? "Generate paper (free)" : "Generate lesson + paper"}
      </button>
    </span>
  );
}

export function AssignChildButton({
  generationId,
  childrenList,
}: {
  generationId: string;
  childrenList: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [childId, setChildId] = useState(childrenList[0]?.id ?? "");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function assign() {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const row = {
      generation_id: generationId,
      student_id: childId,
      class_id: null,
      shared_by: user?.id ?? null,
      due_at: due ? new Date(due).toISOString() : null,
    };
    let { error: iErr } = await supabase.from("generation_shares").insert(row);
    if (iErr && iErr.code === "23505") {
      // Already assigned → refresh the due date instead (partial unique index
      // can't be targeted by upsert, so insert-then-update).
      const upd = await supabase
        .from("generation_shares")
        .update({ due_at: row.due_at })
        .eq("generation_id", generationId)
        .eq("student_id", childId);
      iErr = upd.error;
    }
    setBusy(false);
    if (iErr) {
      setError(iErr.message);
      return;
    }
    setDone(true);
    setTimeout(() => {
      setDone(false);
      setOpen(false);
    }, 1500);
    router.refresh();
  }

  if (childrenList.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-2">
      {open ? (
        <>
          <select value={childId} onChange={(e) => setChildId(e.target.value)} className="field h-8 px-2 text-xs">
            {childrenList.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="field h-8 px-2 text-xs" />
          <button onClick={assign} disabled={busy || !childId} className="btn-primary h-8 px-3 text-xs">
            {done ? "Assigned ✓" : busy ? "…" : "Assign"}
          </button>
          <button onClick={() => setOpen(false)} className="btn-ghost h-8 px-2 text-xs">✕</button>
          {error && <span className="text-xs text-red-600">{error}</span>}
        </>
      ) : (
        <button onClick={() => setOpen(true)} className="btn-ghost h-8 px-3 text-xs">
          Assign to child
        </button>
      )}
    </span>
  );
}
