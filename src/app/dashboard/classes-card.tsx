"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import ClassProgress from "./class-progress";
import ResetPasswordButton from "./reset-password-button";
import DeleteStudentButton from "./delete-student-button";
import { fmt } from "@/i18n/format";
import { type LibraryMessages } from "./content-cell";

export type RosterStudent = { id: string; full_name: string | null; username: string | null; parent_email: string | null };
export type ClassRoster = {
  id: string;
  name: string;
  grade: string | null;
  join_code: string;
  students: RosterStudent[];
};
type Cred = { firstName: string; lastName: string; username: string; password: string; parentEmail: string | null };
type NewRow = { firstName: string; lastName: string; parentEmail: string };

const emptyRow = (): NewRow => ({ firstName: "", lastName: "", parentEmail: "" });

// Teacher view: create classes, provision invited students (→ login IDs +
// temporary passwords to hand to parents), and see each class's roster + join
// code. Data comes from the server (page.tsx); mutations call router.refresh().
export default function ClassesCard({
  classes,
  t,
  betaSlotsLeft = null,
}: {
  classes: ClassRoster[];
  t: LibraryMessages;
  betaSlotsLeft?: number | null; // beta: remaining student slots (null = uncapped)
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newGrade, setNewGrade] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [classError, setClassError] = useState<string | null>(null);
  const [rows, setRows] = useState<NewRow[]>([emptyRow()]);
  const [creds, setCreds] = useState<Cred[]>([]);

  async function createClass() {
    const name = newName.trim();
    if (!name) return;
    // No two classes with the same name (case-insensitive) for this teacher.
    if (classes.some((c) => c.name.trim().toLowerCase() === name.toLowerCase())) {
      setClassError(fmt(t.classes.duplicate, { name }));
      return;
    }
    setBusy(true);
    setClassError(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setClassError(t.notSignedIn);
      setBusy(false);
      return;
    }
    const { error: cErr } = await supabase
      .from("classes")
      .insert({ name, grade: newGrade.trim() || null, teacher_id: user.id });
    setBusy(false);
    if (cErr) {
      setClassError(cErr.message);
      return;
    }
    setNewName("");
    setNewGrade("");
    router.refresh();
  }

  function expand(id: string) {
    setOpenId((cur) => (cur === id ? null : id));
    setRows([emptyRow()]);
    setCreds([]);
    setError(null);
  }

  async function addStudents(classId: string) {
    const students = rows.filter((r) => r.firstName.trim() || r.lastName.trim());
    if (students.length === 0) {
      setError(t.classes.needName);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch("/api/students", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classId, students }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? t.classes.addFailed);
      return;
    }
    setCreds(json.created ?? []);
    if (json.errors?.length) setError(json.errors.join("; "));
    setRows([emptyRow()]);
    router.refresh();
  }

  // The hand-out a teacher pastes into a message to parents — same labels the
  // list below shows, so the clipboard reads in the reader's language too.
  const copyCreds = () => {
    const text = creds
      .map(
        (c) =>
          `${c.firstName} ${c.lastName}\t${t.classes.idLabel} ${c.username}\t${t.classes.passwordLabel} ${c.password}\t${t.classes.parentLabel} ${c.parentEmail ?? "—"}`,
      )
      .join("\n");
    navigator.clipboard?.writeText(text);
  };

  return (
    <details className="card p-5 mb-8">
      <summary className="cursor-pointer flex items-center gap-2 list-none">
        <span className="font-display font-medium">{t.classes.heading}</span>
        <span className="text-xs text-[#5B6470]">
          {classes.length === 1 ? t.classes.countOne : fmt(t.classes.countMany, { n: classes.length })}
        </span>
      </summary>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="text-xs text-[#5B6470]">{t.classes.newClass}</span>
          <input value={newName} onChange={(e) => { setNewName(e.target.value); setClassError(null); }} placeholder={t.classes.namePlaceholder}
            className="field block h-9 px-3 mt-1 text-sm w-44" />
        </label>
        <input value={newGrade} onChange={(e) => setNewGrade(e.target.value)} placeholder={t.classes.gradePlaceholder}
          className="field h-9 px-3 text-sm w-36" />
        <button onClick={createClass} disabled={busy || !newName.trim()} className="btn-primary h-9 px-4 text-sm">
          {busy ? t.classes.creating : t.classes.create}
        </button>
      </div>
      {classError && <p className="text-xs text-red-600 mt-1.5">{classError}</p>}

      {classes.length > 0 && (
        <div className="mt-4 space-y-2">
          {classes.map((c) => (
            <div key={c.id} className="border border-[#EEF0EC] rounded-lg">
              <button onClick={() => expand(c.id)} className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-start">
                <span className="flex items-center gap-2 min-w-0">
                  {/* Disclosure caret — mirrors in RTL, and the open rotation
                      reverses with it so it still points down. */}
                  <span className={`rtl-flip text-[#98A0A9] text-xs transition-transform ${openId === c.id ? "rotate-90 rtl:-rotate-90" : ""}`}>▶</span>
                  <span className="font-medium truncate">{c.name}</span>
                  {c.grade && <span className="text-xs text-[#5B6470]">· {c.grade}</span>}
                </span>
                <span className="flex items-center gap-3 shrink-0 text-xs text-[#5B6470]">
                  <span>
                    {c.students.length === 1
                      ? t.classes.studentsOne
                      : fmt(t.classes.studentsMany, { n: c.students.length })}
                  </span>
                  <span className="chip bg-[#EEF0EC] text-[#5B6470] normal-case tracking-normal">
                    {fmt(t.classes.joinCode, { code: c.join_code })}
                  </span>
                </span>
              </button>

              {openId === c.id && (
                <div className="px-4 pb-4 border-t border-[#EEF0EC] bg-[#F5F6F3]">
                  {c.students.length > 0 && (
                    <ul className="mt-3 mb-4 divide-y divide-[#EEF0EC]">
                      {c.students.map((s) => (
                        <li key={s.id} className="py-1.5 flex items-center justify-between gap-3 text-sm">
                          <span className="truncate">{s.full_name || s.username}</span>
                          <span className="flex items-center gap-3 text-xs text-[#5B6470] shrink-0">
                            <span>
                              {t.classes.idLabel} <span className="text-[#14181F]">{s.username}</span>
                              {s.parent_email ? ` · ${s.parent_email}` : ""}
                            </span>
                            <ResetPasswordButton targetId={s.id} name={s.full_name || s.username || t.classes.thisStudent} />
                            <DeleteStudentButton targetId={s.id} name={s.full_name || s.username || t.classes.thisStudent} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <ClassProgress classId={c.id} t={t} />

                  {betaSlotsLeft !== null && betaSlotsLeft <= 0 ? (
                    <p className="text-xs text-[#9A6400] bg-[#FFF1D6] rounded-lg px-3 py-2 mt-4">
                      {t.classes.betaFull}
                    </p>
                  ) : (
                  <>
                  <p className="text-xs font-medium text-[#5B6470] mt-4 mb-1.5">
                    {t.classes.addStudents}
                    {betaSlotsLeft !== null && (
                      <span className="ms-2 text-[#9A6400]">{fmt(t.classes.betaSlots, { n: betaSlotsLeft })}</span>
                    )}
                  </p>
                  <div className="space-y-1.5">
                    {rows.map((r, i) => (
                      <div key={i} className="grid grid-cols-[1fr_1fr_1.4fr] gap-1.5">
                        <input value={r.firstName} placeholder={t.classes.firstName}
                          onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, firstName: e.target.value } : x)))}
                          className="field h-9 px-2 text-sm" />
                        <input value={r.lastName} placeholder={t.classes.lastName}
                          onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, lastName: e.target.value } : x)))}
                          className="field h-9 px-2 text-sm" />
                        <input value={r.parentEmail} placeholder={t.classes.parentEmail} type="email"
                          onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, parentEmail: e.target.value } : x)))}
                          className="field h-9 px-2 text-sm" />
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-3 mt-2">
                    <button onClick={() => setRows((rs) => [...rs, emptyRow()])} className="text-xs font-medium text-[#0C8175] hover:underline">{t.classes.addRow}</button>
                    <button onClick={() => addStudents(c.id)} disabled={busy} className="btn-primary h-8 px-3 text-xs ms-auto">
                      {busy ? t.classes.creatingLogins : t.classes.createLogins}
                    </button>
                  </div>
                  </>
                  )}

                  {error && <p className="text-xs text-red-600 mt-2">{error}</p>}

                  {creds.length > 0 && (
                    <div className="mt-3 rounded-lg border border-[#E6E8E4] bg-white p-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <p className="text-xs font-medium text-[#0C8175]">✓ {t.classes.credsCreated}</p>
                        <button onClick={copyCreds} className="text-xs font-medium text-[#0C8175] hover:underline">{t.classes.copyAll}</button>
                      </div>
                      <ul className="text-xs space-y-1">
                        {creds.map((cr, i) => (
                          <li key={i} className="flex flex-wrap gap-x-3 text-[#14181F]">
                            <span className="font-medium">{cr.firstName} {cr.lastName}</span>
                            <span>{t.classes.idLabel} <span className="font-mono">{cr.username}</span></span>
                            <span>{t.classes.passwordLabel} <span className="font-mono">{cr.password}</span></span>
                            <span className="text-[#5B6470]">{t.classes.parentLabel} {cr.parentEmail ?? "—"}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </details>
  );
}
