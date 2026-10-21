"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DECISION_NOTE_MAX } from "@/utils/fixes/fix-cases";

// The Fix Agent's buttons on Library → Fixes: the agent's on/off switch and
// the founder's Approve / Reject on one case. The route decides everything
// (/api/library/fixes); these post and refresh the server page.

const TURN_ON_CONFIRM =
  "Turn on the Fix Agent? It diagnoses failed translations and proposes fixes; nothing is retried until you approve.";

async function post(body: Record<string, unknown>): Promise<string | null> {
  const res = await fetch("/api/library/fixes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return null;
  const json = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof json.error === "string" ? json.error : "That did not go through.";
}

export function AgentSwitch({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const press = async () => {
    if (!enabled && !window.confirm(TURN_ON_CONFIRM)) return;
    setBusy(true);
    setError(null);
    const err = await post({ action: enabled ? "off" : "on" });
    setBusy(false);
    if (err) setError(err);
    else router.refresh();
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" disabled={busy} onClick={press} className={enabled ? "btn-ghost h-8 px-3 text-sm" : "btn-primary h-8 px-3 text-sm"}>
        {busy ? "…" : enabled ? "Turn off" : "Turn on"}
      </button>
      {error && <span className="text-xs text-[#B3401F]">{error}</span>}
    </span>
  );
}

export function DecisionButtons({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const decide = async (action: "approve" | "reject") => {
    setBusy(action);
    setError(null);
    const err = await post({ action, id, ...(action === "reject" && note.trim() ? { note: note.trim() } : {}) });
    setBusy(null);
    if (err) setError(err);
    else router.refresh();
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary h-9 px-4 text-sm" disabled={busy !== null} onClick={() => decide("approve")}>
          {busy === "approve" ? "Approving…" : "Approve"}
        </button>
        {!rejecting && (
          <button type="button" className="btn-ghost h-9 px-4 text-sm" disabled={busy !== null} onClick={() => setRejecting(true)}>
            Reject
          </button>
        )}
        {error && <span className="text-xs text-[#B3401F]">{error}</span>}
      </div>
      {rejecting && (
        <div className="space-y-2 max-w-xl">
          <label className="block text-xs text-[#5B6470]" htmlFor={`reject-note-${id}`}>
            Why not? (optional — the agent does not retry a rejected case)
          </label>
          <textarea
            id={`reject-note-${id}`}
            className="field w-full p-2 text-sm"
            rows={3}
            maxLength={DECISION_NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <button type="button" className="btn-primary h-8 px-3 text-sm" disabled={busy !== null} onClick={() => decide("reject")}>
              {busy === "reject" ? "Rejecting…" : "Reject this fix"}
            </button>
            <button
              type="button"
              className="btn-ghost h-8 px-3 text-sm"
              disabled={busy !== null}
              onClick={() => {
                setRejecting(false);
                setNote("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
