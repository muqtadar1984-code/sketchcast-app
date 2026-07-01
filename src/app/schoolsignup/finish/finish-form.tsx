"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function FinishForm() {
  const router = useRouter();
  const [schoolName, setSchoolName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolName.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/school-finish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schoolName }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Something went wrong. Please try again.");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <input
        required
        placeholder="School name"
        value={schoolName}
        onChange={(e) => setSchoolName(e.target.value)}
        className="field w-full h-11 px-3 text-[#14181F]"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={busy} className="btn-primary w-full h-11">
        {busy ? "Creating…" : "Create my school"}
      </button>
    </form>
  );
}
