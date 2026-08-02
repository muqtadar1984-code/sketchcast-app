"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmt } from "@/i18n/format";
import type { Dictionary } from "@/i18n/dictionaries";
import { NOTE_TYPES, TYPE_ICON, TYPE_STYLE, noteTypeLabel, type NoteTypeLabels } from "./diary/note-types";

// The TEACHER's compose card: pick a type, write the note, aim it at the whole
// class or one enrolled student, optionally hide it from students ("parents
// only"). Posts to /api/diary/notes for the day currently shown — writing
// while catching up on yesterday files the note under yesterday's page, like a
// paper diary. RLS is the authority on who may write where; this just makes
// the happy path one textarea away. (Parents get their own per-child compose —
// diary/parent-compose.tsx.)

/** Its own words plus the three the whole diary shares. Typed from the English
 * dictionary; the import is type-only, so the server-only module is erased and
 * no translation file reaches the browser bundle. */
export type DiaryComposeMessages = Dictionary["comms"]["diary"]["compose"] & {
  noteTypes: NoteTypeLabels;
  addToDiary: string;
  saveFailed: string;
  saving: string;
};

export default function DiaryCompose({
  classId,
  className,
  students,
  date,
  t,
}: {
  classId: string;
  className: string;
  students: { id: string; name: string }[];
  /** The diary day being viewed ("YYYY-MM-DD") — becomes the note's entry_date. */
  date: string;
  t: DiaryComposeMessages;
}) {
  const router = useRouter();
  const [type, setType] = useState<string>("general");
  const [target, setTarget] = useState(""); // "" = whole class, else a student id
  const [parentsOnly, setParentsOnly] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post() {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/diary/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Class-wide XOR per-student — the API and the DB CHECK both insist.
        ...(target ? { studentId: target } : { classId }),
        type,
        body: text,
        parentsOnly,
        entryDate: date,
      }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? t.saveFailed);
      return;
    }
    setBody("");
    setParentsOnly(false);
    setDone(true);
    setTimeout(() => setDone(false), 1500);
    router.refresh(); // the new note appears in the timeline below
  }

  return (
    <div className="card p-5 mb-6">
      <h2 className="font-display font-medium mb-3">{t.title}</h2>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {NOTE_TYPES.map((nt) => (
          <button
            key={nt}
            type="button"
            onClick={() => setType(nt)}
            className={`chip font-sans normal-case tracking-normal ${
              type === nt ? TYPE_STYLE[nt] : "bg-white border border-[#E6E8E4] text-[#5B6470] hover:bg-[#F5F6F3]"
            }`}
          >
            {TYPE_ICON[nt]} {noteTypeLabel(t.noteTypes, nt)}
          </button>
        ))}
      </div>

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        maxLength={4000}
        placeholder={t.placeholder}
        className="field px-3 py-2 w-full text-sm"
      />

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="field h-9 px-2 text-sm"
          aria-label={t.targetAria}
        >
          <option value="">{fmt(t.wholeClass, { class: className })}</option>
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {fmt(t.onlyStudent, { name: s.name })}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-sm text-[#5B6470]">
          <input
            type="checkbox"
            checked={parentsOnly}
            onChange={(e) => setParentsOnly(e.target.checked)}
            className="accent-[#0C8175]"
          />
          {t.parentsOnly}
          <span className="text-xs text-[#98A0A9]">{t.parentsOnlyHint}</span>
        </label>

        <div className="ms-auto flex items-center gap-2">
          {error && <span className="text-xs text-red-600">{error}</span>}
          <button onClick={post} disabled={busy || !body.trim()} className="btn-primary h-9 px-4 text-sm">
            {done ? `${t.added} ✓` : busy ? t.saving : t.addToDiary}
          </button>
        </div>
      </div>
    </div>
  );
}
