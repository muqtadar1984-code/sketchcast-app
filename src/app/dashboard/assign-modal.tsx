"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { fmt } from "@/i18n/format";
import { type LibraryMessages } from "./labels";

export type ClassRow = { id: string; name: string; grade: string | null };
export type ChildRow = { id: string; name: string };

// Assign a chapter (one generation) or a whole book (many). Persists to
// generation_shares. Two audiences, one modal:
//   · teachers → a CLASS (→ its enrolled students), with inline class creation;
//   · parent-role accounts (home educators, 2026-08-18) → their linked
//     CHILDREN directly (student_id shares — the same rows and RLS policy the
//     Test Papers page uses), because a family has named learners, not a
//     class register. `childTargets` non-null switches the mode; the caller
//     derives it from the PROFILE ROLE server-side.
export default function AssignModal({
  label,
  generationIds,
  classes,
  childTargets = null,
  t,
}: {
  /** The trigger's text — already translated by the caller ("Assign chapter",
      "Assign book", plain "Assign"). */
  label: string;
  generationIds: string[];
  classes: ClassRow[];
  /** Parent mode: the viewer's linked children (null = class mode). */
  childTargets?: ChildRow[] | null;
  t: LibraryMessages;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const [classList, setClassList] = useState<ClassRow[]>(classes);
  const [classId, setClassId] = useState(classes[0]?.id ?? "");
  const [due, setDue] = useState("");
  const [creating, setCreating] = useState(classes.length === 0);
  const [newName, setNewName] = useState("");
  const [newGrade, setNewGrade] = useState("");

  const childMode = childTargets !== null;
  // A kit usually goes to the whole family — start with everyone selected and
  // let the parent narrow, rather than making three checks the common case.
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set((childTargets ?? []).map((c) => c.id)),
  );
  const toggleChild = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function assignToChildren() {
    const targets = (childTargets ?? []).filter((c) => picked.has(c.id));
    if (!targets.length) {
      setError(t.assignModal.pickChild);
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError(t.notSignedIn);
      setBusy(false);
      return;
    }
    // Per-row insert, duplicate → update the due date: shares_gen_student_uq
    // is a PARTIAL unique index, which upsert's onConflict cannot target
    // (same reason the Test Papers page does insert-then-update).
    for (const gid of generationIds) {
      for (const child of targets) {
        const { error: iErr } = await supabase.from("generation_shares").insert({
          generation_id: gid,
          student_id: child.id,
          class_id: null,
          shared_by: user.id,
          due_at: due ? due : null,
        });
        if (iErr && iErr.code === "23505") {
          await supabase
            .from("generation_shares")
            .update({ due_at: due ? due : null })
            .eq("generation_id", gid)
            .eq("student_id", child.id);
        } else if (iErr) {
          setError(iErr.message);
          setBusy(false);
          return;
        }
      }
    }
    setBusy(false);
    setDone(true);
    router.refresh();
    setTimeout(() => {
      setOpen(false);
      setDone(false);
    }, 1200);
  }

  async function createClass() {
    const name = newName.trim();
    if (!name) {
      setError(t.assignModal.nameRequired);
      return;
    }
    if (classList.some((c) => c.name.trim().toLowerCase() === name.toLowerCase())) {
      setError(fmt(t.assignModal.duplicate, { name }));
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError(t.notSignedIn);
      setBusy(false);
      return;
    }
    const { data, error: cErr } = await supabase
      .from("classes")
      .insert({ name: newName.trim(), grade: newGrade.trim() || null, teacher_id: user.id })
      .select("id, name, grade")
      .single();
    setBusy(false);
    if (cErr || !data) {
      setError(cErr?.message ?? t.assignModal.createFailed);
      return;
    }
    setClassList((l) => [data as ClassRow, ...l]);
    setClassId((data as ClassRow).id);
    setCreating(false);
    setNewName("");
    setNewGrade("");
  }

  async function assign() {
    if (!classId) {
      setError(t.assignModal.pickClass);
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError(t.notSignedIn);
      setBusy(false);
      return;
    }
    const rows = generationIds.map((gid) => ({
      generation_id: gid,
      class_id: classId,
      shared_by: user.id,
      due_at: due ? due : null,
    }));
    const { error: sErr } = await supabase
      .from("generation_shares")
      .upsert(rows, { onConflict: "generation_id,class_id" });
    setBusy(false);
    if (sErr) {
      setError(sErr.message);
      return;
    }
    setDone(true);
    router.refresh();
    setTimeout(() => {
      setOpen(false);
      setDone(false);
    }, 1200);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-[#9A6400] hover:underline whitespace-nowrap"
      >
        {label}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !busy && setOpen(false)}
        >
          <div
            className="bg-white rounded-xl border border-[#E6E8E4] p-5 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-medium mb-1" style={{ fontFamily: "var(--font-space-grotesk), sans-serif" }}>
              {childMode ? t.assignModal.headingChildren : t.assignModal.heading}
            </h3>
            <p className="text-xs text-[#5B6470] mb-3">
              {generationIds.length === 1
                ? childMode
                  ? t.assignModal.itemsOneChildren
                  : t.assignModal.itemsOne
                : fmt(childMode ? t.assignModal.itemsManyChildren : t.assignModal.itemsMany, {
                    n: generationIds.length,
                  })}
            </p>

            {done ? (
              <p className="text-sm text-[#0C8175] py-4">✓ {t.assignModal.assigned}</p>
            ) : childMode ? (
              (childTargets ?? []).length === 0 ? (
                <div className="space-y-2 py-2">
                  <p className="text-sm text-[#5B6470]">{t.assignModal.noChildren}</p>
                  <a
                    href="/dashboard/children"
                    className="text-xs font-medium text-[#0C8175] hover:underline"
                  >
                    {t.assignModal.manageChildren}
                  </a>
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <span className="text-xs text-[#5B6470]">{t.assignModal.childrenLabel}</span>
                    <div className="mt-1 space-y-0.5">
                      {(childTargets ?? []).map((c) => (
                        <label key={c.id} className="flex items-center gap-2 text-sm py-0.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={picked.has(c.id)}
                            onChange={() => toggleChild(c.id)}
                            className="accent-[#0C8175]"
                          />
                          {c.name}
                        </label>
                      ))}
                    </div>
                  </div>
                  <label className="block">
                    <span className="text-xs text-[#5B6470]">{t.assignModal.due}</span>
                    <input
                      type="date"
                      value={due}
                      onChange={(e) => setDue(e.target.value)}
                      className="w-full h-9 px-3 mt-1 rounded-lg border border-[#E6E8E4] text-sm outline-none focus:border-[#1FB8A6]"
                    />
                  </label>
                  {error && <p className="text-xs text-red-600">{error}</p>}
                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      onClick={() => setOpen(false)}
                      disabled={busy}
                      className="h-9 px-3 rounded-lg border border-[#E6E8E4] text-sm hover:bg-[#F5F6F3]"
                    >
                      {t.common.cancel}
                    </button>
                    <button
                      onClick={assignToChildren}
                      disabled={busy}
                      className="h-9 px-4 rounded-lg bg-[#14181F] text-white text-sm font-medium hover:bg-[#20262F] disabled:opacity-50"
                    >
                      {busy ? t.assignModal.assigning : t.assignModal.assign}
                    </button>
                  </div>
                </div>
              )
            ) : creating ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-[#5B6470]">{t.assignModal.newClass}</p>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t.assignModal.namePlaceholder}
                  className="w-full h-9 px-3 rounded-lg border border-[#E6E8E4] text-sm outline-none focus:border-[#1FB8A6]"
                />
                <input
                  value={newGrade}
                  onChange={(e) => setNewGrade(e.target.value)}
                  placeholder={t.assignModal.gradePlaceholder}
                  className="w-full h-9 px-3 rounded-lg border border-[#E6E8E4] text-sm outline-none focus:border-[#1FB8A6]"
                />
                {error && <p className="text-xs text-red-600">{error}</p>}
                <div className="flex justify-end gap-2 pt-1">
                  {classList.length > 0 && (
                    <button
                      onClick={() => setCreating(false)}
                      className="h-9 px-3 rounded-lg border border-[#E6E8E4] text-sm hover:bg-[#F5F6F3]"
                    >
                      {t.assignModal.back}
                    </button>
                  )}
                  <button
                    onClick={createClass}
                    disabled={busy}
                    className="h-9 px-4 rounded-lg bg-[#14181F] text-white text-sm font-medium hover:bg-[#20262F] disabled:opacity-50"
                  >
                    {busy ? t.assignModal.creating : t.assignModal.createClass}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <label className="block">
                  <span className="text-xs text-[#5B6470]">{t.assignModal.classLabel}</span>
                  <select
                    value={classId}
                    onChange={(e) => setClassId(e.target.value)}
                    className="w-full h-9 px-2 mt-1 rounded-lg border border-[#E6E8E4] text-sm bg-white outline-none focus:border-[#1FB8A6]"
                  >
                    {classList.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.grade ? ` · ${c.grade}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  onClick={() => setCreating(true)}
                  className="text-xs font-medium text-[#0C8175] hover:underline"
                >
                  {t.assignModal.addClass}
                </button>
                <label className="block">
                  <span className="text-xs text-[#5B6470]">{t.assignModal.due}</span>
                  <input
                    type="date"
                    value={due}
                    onChange={(e) => setDue(e.target.value)}
                    className="w-full h-9 px-3 mt-1 rounded-lg border border-[#E6E8E4] text-sm outline-none focus:border-[#1FB8A6]"
                  />
                </label>
                {error && <p className="text-xs text-red-600">{error}</p>}
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    onClick={() => setOpen(false)}
                    disabled={busy}
                    className="h-9 px-3 rounded-lg border border-[#E6E8E4] text-sm hover:bg-[#F5F6F3]"
                  >
                    {t.common.cancel}
                  </button>
                  <button
                    onClick={assign}
                    disabled={busy}
                    className="h-9 px-4 rounded-lg bg-[#14181F] text-white text-sm font-medium hover:bg-[#20262F] disabled:opacity-50"
                  >
                    {busy ? t.assignModal.assigning : t.assignModal.assign}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
