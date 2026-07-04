"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Status / severity / resolution controls — PATCHes /api/console/issues.
export default function TriageForm({
  id,
  status,
  severity,
  resolutionNote,
}: {
  id: string;
  status: string;
  severity: string;
  resolutionNote: string | null;
}) {
  const router = useRouter();
  const [s, setS] = useState(status);
  const [sev, setSev] = useState(severity);
  const [note, setNote] = useState(resolutionNote ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/console/issues", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status: s, severity: sev, resolution_note: note || null }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Something went wrong.");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <div className="card p-5">
      <h2 className="font-display font-medium text-lg mb-3">Triage</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-xs text-[#5B6470]">Status</span>
          <select value={s} onChange={(e) => setS(e.target.value)} className="field h-9 px-2 mt-1 block">
            {["open", "triaged", "in_progress", "resolved"].map((v) => (
              <option key={v} value={v}>{v.replace("_", " ")}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-[#5B6470]">Severity</span>
          <select value={sev} onChange={(e) => setSev(e.target.value)} className="field h-9 px-2 mt-1 block">
            {["low", "normal", "high", "critical"].map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </label>
        <label className="block flex-1 min-w-56">
          <span className="text-xs text-[#5B6470]">Resolution note (reporter sees status only)</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What fixed it / what we found"
            className="field h-9 px-3 mt-1 w-full"
          />
        </label>
        <button onClick={save} disabled={busy} className="btn-primary h-9 px-4">
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
      {saved && !error && <p className="text-sm text-[#0C8175] mt-2">Saved.</p>}
    </div>
  );
}
