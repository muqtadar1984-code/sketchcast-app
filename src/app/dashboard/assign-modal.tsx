"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

export type ClassRow = { id: string; name: string; grade: string | null };

// Assign a chapter (one generation) or a whole book (many) to a class. Persists
// to generation_shares (→ the class's enrolled students). Supports creating a
// class inline when the teacher has none yet.
export default function AssignModal({
  label,
  generationIds,
  classes,
}: {
  label: string;
  generationIds: string[];
  classes: ClassRow[];
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

  async function createClass() {
    const name = newName.trim();
    if (!name) {
      setError("Class name required.");
      return;
    }
    if (classList.some((c) => c.name.trim().toLowerCase() === name.toLowerCase())) {
      setError(`You already have a class named "${name}".`);
      return;
    }
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
    const { data, error: cErr } = await supabase
      .from("classes")
      .insert({ name: newName.trim(), grade: newGrade.trim() || null, teacher_id: user.id })
      .select("id, name, grade")
      .single();
    setBusy(false);
    if (cErr || !data) {
      setError(cErr?.message ?? "Could not create class.");
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
      setError("Pick a class.");
      return;
    }
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
              Assign to a class
            </h3>
            <p className="text-xs text-[#5B6470] mb-3">
              {generationIds.length} {generationIds.length === 1 ? "item" : "items"} — the class&apos;s
              students will see this in their assignments.
            </p>

            {done ? (
              <p className="text-sm text-[#0C8175] py-4">✓ Assigned.</p>
            ) : creating ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-[#5B6470]">New class</p>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Class name (e.g. 5A)"
                  className="w-full h-9 px-3 rounded-lg border border-[#E6E8E4] text-sm outline-none focus:border-[#1FB8A6]"
                />
                <input
                  value={newGrade}
                  onChange={(e) => setNewGrade(e.target.value)}
                  placeholder="Grade (optional)"
                  className="w-full h-9 px-3 rounded-lg border border-[#E6E8E4] text-sm outline-none focus:border-[#1FB8A6]"
                />
                {error && <p className="text-xs text-red-600">{error}</p>}
                <div className="flex justify-end gap-2 pt-1">
                  {classList.length > 0 && (
                    <button
                      onClick={() => setCreating(false)}
                      className="h-9 px-3 rounded-lg border border-[#E6E8E4] text-sm hover:bg-[#F5F6F3]"
                    >
                      Back
                    </button>
                  )}
                  <button
                    onClick={createClass}
                    disabled={busy}
                    className="h-9 px-4 rounded-lg bg-[#14181F] text-white text-sm font-medium hover:bg-[#20262F] disabled:opacity-50"
                  >
                    {busy ? "Creating…" : "Create class"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <label className="block">
                  <span className="text-xs text-[#5B6470]">Class</span>
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
                  + New class
                </button>
                <label className="block">
                  <span className="text-xs text-[#5B6470]">Due date (optional)</span>
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
                    Cancel
                  </button>
                  <button
                    onClick={assign}
                    disabled={busy}
                    className="h-9 px-4 rounded-lg bg-[#14181F] text-white text-sm font-medium hover:bg-[#20262F] disabled:opacity-50"
                  >
                    {busy ? "Assigning…" : "Assign"}
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
