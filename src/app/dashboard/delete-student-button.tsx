"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Per-row "Delete" action for a student/child account, with an inline confirm
// step (same interaction shape as ResetPasswordButton). Used on the parent
// children page (self-created children), the teacher class roster, and the
// school-admin students list. POST /api/delete-student decides the scope
// server-side; this is permanent — the confirm copy says so plainly.
export default function DeleteStudentButton({ targetId, name }: { targetId: string; name: string }) {
  const router = useRouter();
  const [stage, setStage] = useState<"idle" | "confirm" | "busy">("idle");
  const [error, setError] = useState<string | null>(null);

  async function doDelete() {
    setStage("busy");
    setError(null);
    const res = await fetch("/api/delete-student", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(json.error ?? "Could not delete the account.");
      setStage("idle");
      return;
    }
    router.refresh(); // the row disappears with the re-render
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs">
      {error && <span className="text-red-600 min-w-0 [overflow-wrap:anywhere]">{error}</span>}
      {stage === "confirm" ? (
        <>
          <span className="text-[#5B6470]">
            Delete {name}&apos;s account permanently? Their sign-in and all their work are removed.
          </span>
          <button onClick={doDelete} className="font-medium text-red-600 hover:underline">
            Yes, delete
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
          className="font-medium text-red-600 hover:underline disabled:opacity-60"
        >
          {stage === "busy" ? "Deleting…" : "Delete"}
        </button>
      )}
    </span>
  );
}
