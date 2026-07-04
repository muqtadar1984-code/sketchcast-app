"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Suspend / caps / staff controls — POSTs /api/console/ops. `opsReady` is
// false until migrations 0015/0016 are applied; the panel then explains
// instead of failing.
export default function OpsControls({
  userId,
  suspended,
  caps,
  isStaffTarget,
  canGrantStaff,
  opsReady,
}: {
  userId: string;
  suspended: boolean;
  caps: { books: number | null; chapters: number | null; students: number | null; children: number | null };
  isStaffTarget: boolean;
  canGrantStaff: boolean;
  opsReady: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [capForm, setCapForm] = useState({
    books: caps.books?.toString() ?? "",
    chapters: caps.chapters?.toString() ?? "",
    students: caps.students?.toString() ?? "",
    children: caps.children?.toString() ?? "",
  });

  async function call(payload: Record<string, unknown>, label: string) {
    setBusy(label);
    setError(null);
    setNotice(null);
    const res = await fetch("/api/console/ops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId: userId, ...payload }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(json.error ?? "Something went wrong.");
      return;
    }
    if (json.warning) setNotice(json.warning);
    router.refresh();
  }

  if (!opsReady) {
    return (
      <div className="card p-5 text-sm text-[#9A6400] bg-[#FFF9EE]">
        Ops controls need migrations <span className="font-medium">0015</span> and{" "}
        <span className="font-medium">0016</span> applied in the Supabase SQL editor.
      </div>
    );
  }

  const toCap = (s: string) => (s.trim() === "" ? null : Number(s));

  return (
    <div className="card p-5 space-y-5">
      <h2 className="font-display font-medium text-lg">Ops</h2>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-[#9A6400]">{notice}</p>}

      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium text-sm">{suspended ? "Account suspended" : "Suspend account"}</p>
          <p className="text-xs text-[#5B6470]">
            {suspended
              ? "Login banned and data access cut. Unsuspending restores everything."
              : "Blocks login and cuts data access immediately. Reversible; deletes nothing."}
          </p>
        </div>
        {isStaffTarget ? (
          <span className="chip font-sans bg-[#EEF0EC] text-[#5B6470]">staff — protected</span>
        ) : (
          <button
            onClick={() => call({ action: suspended ? "unsuspend" : "suspend" }, "suspend")}
            disabled={!!busy}
            className={`h-9 px-4 text-sm rounded-lg font-medium ${
              suspended ? "btn-primary" : "bg-[#FFE9E3] text-[#B3401F] hover:bg-[#FFDCD2]"
            }`}
          >
            {busy === "suspend" ? "…" : suspended ? "Unsuspend" : "Suspend"}
          </button>
        )}
      </div>

      <div>
        <p className="font-medium text-sm mb-1">Caps</p>
        <p className="text-xs text-[#5B6470] mb-2">
          Blank = default (beta: 1 book · 1 chapter · 2 students; non-beta: unlimited). Lowering a cap
          never deletes anything — it only blocks new items.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          {(
            [
              ["books", "Books"],
              ["chapters", "Chapters"],
              ["students", "Students"],
              ["children", "Children"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="block">
              <span className="text-xs text-[#5B6470]">{label}</span>
              <input
                type="number"
                min={0}
                value={capForm[key]}
                onChange={(e) => setCapForm((f) => ({ ...f, [key]: e.target.value }))}
                placeholder="default"
                className="field h-9 px-2 mt-1 w-24"
              />
            </label>
          ))}
          <button
            onClick={() =>
              call(
                {
                  action: "set_caps",
                  maxBooks: toCap(capForm.books),
                  maxChapters: toCap(capForm.chapters),
                  maxStudents: toCap(capForm.students),
                  maxChildren: toCap(capForm.children),
                },
                "caps",
              )
            }
            disabled={!!busy}
            className="btn-ghost h-9 px-4 text-sm"
          >
            {busy === "caps" ? "Saving…" : "Save caps"}
          </button>
        </div>
      </div>

      {canGrantStaff && (
        <div className="flex items-center justify-between gap-3 pt-1 border-t border-[#EEF0EC]">
          <div>
            <p className="font-medium text-sm">Platform staff</p>
            <p className="text-xs text-[#5B6470]">Grants full console access (founders can do this).</p>
          </div>
          <button
            onClick={() => call({ action: isStaffTarget ? "admin_revoke" : "admin_grant" }, "staff")}
            disabled={!!busy}
            className="btn-ghost h-9 px-4 text-sm"
          >
            {busy === "staff" ? "…" : isStaffTarget ? "Revoke staff" : "Make staff"}
          </button>
        </div>
      )}
    </div>
  );
}
