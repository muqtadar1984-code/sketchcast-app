"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type Member = { id: string; name: string; role: "teacher" | "coordinator" };
export type Scope = { id: string; coordinator_id: string; grade: string; subject: string | null };

// Admin control for the coordinator role + (grade, subject) scope mapping. Each
// mutation hits /api/coordinators (admin-only, service role) then refreshes.
export default function CoordinatorAdmin({
  members,
  scopes,
  grades,
  subjects,
}: {
  members: Member[];
  scopes: Scope[];
  grades: string[];
  subjects: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-coordinator add-scope form state.
  const [form, setForm] = useState<Record<string, { grade: string; subject: string }>>({});

  async function call(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/coordinators", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Something went wrong.");
      return false;
    }
    router.refresh();
    return true;
  }

  const scopesOf = (id: string) => scopes.filter((s) => s.coordinator_id === id);
  const coordinators = members.filter((m) => m.role === "coordinator");
  const teachers = members.filter((m) => m.role === "teacher");

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="font-display font-medium text-lg">Coordinators &amp; scopes</h2>
        <span className="text-xs text-[#5B6470]">{coordinators.length} coordinator{coordinators.length === 1 ? "" : "s"}</span>
      </div>
      <p className="text-sm text-[#5B6470] mb-4">
        A coordinator sees only the grades (and optional subjects) you assign — nothing outside their slice.
      </p>
      {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

      {grades.length === 0 && (
        <p className="text-xs text-[#9A6400] bg-[#FFF1D6] rounded-lg px-3 py-2 mb-4">
          No class grades exist yet — add a grade to a class first, then you can scope a coordinator to it.
        </p>
      )}

      {/* Existing coordinators with their scopes */}
      {coordinators.length > 0 && (
        <div className="space-y-2 mb-5">
          {coordinators.map((m) => {
            const f = form[m.id] ?? { grade: grades[0] ?? "", subject: "" };
            return (
              <div key={m.id} className="border border-[#EEF0EC] rounded-lg p-3">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <span className="font-medium">
                    {m.name} <span className="chip font-sans bg-[#E2F4F1] text-[#0C8175] ml-1">coordinator</span>
                  </span>
                  <button
                    onClick={() => call({ action: "set_role", userId: m.id, role: "teacher" })}
                    disabled={busy}
                    className="text-xs font-medium text-[#5B6470] hover:text-red-600"
                  >
                    Remove coordinator
                  </button>
                </div>

                <div className="flex flex-wrap gap-1.5 mb-2">
                  {scopesOf(m.id).length === 0 ? (
                    <span className="text-xs text-[#9A6400]">No scope yet — add a grade below (otherwise they see nothing).</span>
                  ) : (
                    scopesOf(m.id).map((s) => (
                      <span key={s.id} className="chip font-sans bg-[#EEF0EC] text-[#14181F] normal-case tracking-normal gap-1">
                        Grade {s.grade}
                        {s.subject ? ` · ${s.subject}` : ""}
                        <button
                          onClick={() => call({ action: "remove_scope", scopeId: s.id })}
                          disabled={busy}
                          aria-label="Remove scope"
                          className="ml-0.5 text-[#9A6400] hover:text-red-600"
                        >
                          ×
                        </button>
                      </span>
                    ))
                  )}
                </div>

                {grades.length > 0 && (
                  <div className="flex flex-wrap items-end gap-1.5">
                    <select
                      value={f.grade}
                      onChange={(e) => setForm((s) => ({ ...s, [m.id]: { ...f, grade: e.target.value } }))}
                      className="field h-8 px-2 text-sm"
                    >
                      {grades.map((g) => (
                        <option key={g} value={g}>Grade {g}</option>
                      ))}
                    </select>
                    <select
                      value={f.subject}
                      onChange={(e) => setForm((s) => ({ ...s, [m.id]: { ...f, subject: e.target.value } }))}
                      className="field h-8 px-2 text-sm"
                    >
                      <option value="">All subjects</option>
                      {subjects.map((sub) => (
                        <option key={sub} value={sub}>{sub}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => call({ action: "add_scope", userId: m.id, grade: f.grade || grades[0], subject: f.subject })}
                      disabled={busy || !(f.grade || grades[0])}
                      className="btn-ghost h-8 px-3 text-xs"
                    >
                      + Add scope
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Promote a teacher */}
      <p className="text-xs font-medium text-[#5B6470] mb-1.5">Make a teacher a coordinator</p>
      {teachers.length === 0 ? (
        <p className="text-xs text-[#5B6470]">No teachers available to promote.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {teachers.map((m) => (
            <button
              key={m.id}
              onClick={() => call({ action: "set_role", userId: m.id, role: "coordinator" })}
              disabled={busy}
              className="btn-ghost h-8 px-3 text-xs"
            >
              + {m.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
