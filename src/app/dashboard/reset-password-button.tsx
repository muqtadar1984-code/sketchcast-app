"use client";

import { useState } from "react";

// Per-row "Reset password" action with an inline confirm step, used on the
// teacher roster, the school-admin members list, and the parent children page.
// Calls POST /api/reset-password (which decides teacher/parent/admin/
// coordinator scope server-side) and shows the temporary password ONCE —
// it is never stored or retrievable again, so copy it now.
export default function ResetPasswordButton({ targetId, name }: { targetId: string; name: string }) {
  const [stage, setStage] = useState<"idle" | "confirm" | "busy" | "done">("idle");
  const [temp, setTemp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function doReset() {
    setStage("busy");
    setError(null);
    const res = await fetch("/api/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.tempPassword) {
      setError(json.error ?? "Could not reset the password.");
      setStage("idle");
      return;
    }
    setTemp(json.tempPassword as string);
    setStage("done");
  }

  if (stage === "done" && temp) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium text-[#0C8175]">New password:</span>
        <span className="font-mono text-[#14181F]">{temp}</span>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(temp);
            setCopied(true);
          }}
          className="font-medium text-[#0C8175] hover:underline"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <span className="text-[#98A0A9]">(shown once)</span>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs">
      {error && <span className="text-red-600">{error}</span>}
      {stage === "confirm" ? (
        <>
          <span className="text-[#5B6470]">Reset {name}&apos;s password?</span>
          <button onClick={doReset} className="font-medium text-red-600 hover:underline">
            Yes, reset
          </button>
          <button onClick={() => setStage("idle")} className="font-medium text-[#5B6470] hover:underline">
            Cancel
          </button>
        </>
      ) : (
        <button
          onClick={() => {
            setError(null);
            setStage("confirm");
          }}
          disabled={stage === "busy"}
          className="font-medium text-[#0C8175] hover:underline disabled:opacity-60"
        >
          {stage === "busy" ? "Resetting…" : "Reset password"}
        </button>
      )}
    </span>
  );
}
