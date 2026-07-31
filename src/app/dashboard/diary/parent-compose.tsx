"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { NOTE_TYPES, TYPE_STYLE } from "./note-types";

// The parent's compose box, scoped to ONE child: type chips + body → a
// per-student note (parents never write class-wide — the API and RLS both pin
// them to studentId, so no classId option renders here). entryDate follows the
// day being viewed, so a note written while catching up on yesterday lands in
// yesterday's page of the book.
//
// PRIVATE BY DEFAULT: a note home is a note to the TEACHER — "his grandmother
// died, he doesn't know yet" must never appear on the child's own diary page.
// So parents_only is TRUE unless the parent explicitly ticks "let {child} see
// this note too" (dn_read then strips it from the student's view). The teacher
// box defaults the other way round on purpose — it writes TO the class.

export default function ParentCompose({
  studentId,
  childName,
  entryDate,
}: {
  studentId: string;
  childName: string;
  entryDate: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<string>("general");
  const [body, setBody] = useState("");
  // Opt-IN visibility: unticked ⇒ parents_only, the private teacher↔home note.
  const [childCanSee, setChildCanSee] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/diary/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId, type, body: body.trim(), parentsOnly: !childCanSee, entryDate }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Could not save the note.");
      return;
    }
    setBody("");
    setType("general");
    setChildCanSee(false);
    setOpen(false);
    router.refresh();
  }

  if (!open)
    return (
      <div className="px-5 py-3">
        <button onClick={() => setOpen(true)} className="btn-ghost h-9 px-3 text-sm">
          + Write a note about {childName}
        </button>
      </div>
    );

  return (
    <form onSubmit={submit} className="px-5 py-3">
      <div className="flex flex-wrap gap-1.5 mb-2">
        {NOTE_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setType(t)}
            className={`chip font-sans normal-case tracking-normal ${
              type === t ? TYPE_STYLE[t] : "bg-white border border-[#E6E8E4] text-[#5B6470]"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <textarea
        required
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={4000}
        rows={3}
        placeholder={`A private note for ${childName}'s teachers — e.g. absence, medication, something from home…`}
        className="field px-3 py-2 w-full text-sm"
      />
      <label className="mt-2 flex items-start gap-1.5 text-sm text-[#5B6470]">
        <input
          type="checkbox"
          checked={childCanSee}
          onChange={(e) => setChildCanSee(e.target.checked)}
          className="accent-[#0C8175] mt-1"
        />
        <span>
          Let {childName} see this note too
          <span className="block text-xs text-[#98A0A9]">
            Off by default — you, {childName}&apos;s teachers and school leadership can read it,
            but {childName} cannot.
          </span>
        </span>
      </label>
      <div className="mt-2 flex items-center gap-2">
        <button type="submit" disabled={busy || !body.trim()} className="btn-primary h-9 px-4 text-sm">
          {busy ? "Saving…" : "Add to the diary"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn-ghost h-9 px-3 text-sm">
          Cancel
        </button>
      </div>
      {error && <p className="mt-1.5 text-sm text-red-600 [overflow-wrap:anywhere]">{error}</p>}
    </form>
  );
}
