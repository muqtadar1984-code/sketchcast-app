"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

// "Create topic from node" on an uncovered curriculum node — POST
// /api/library/curricula {nodeId}. The node's title becomes a candidate topic
// with a curriculum alias and a full mapping; a 409 means the key already
// belongs to a topic, so the button turns into a link to map it instead.

export default function CreateFromNode({ nodeId, title }: { nodeId: string; title: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingId, setExistingId] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    setExistingId(null);
    const res = await fetch("/api/library/curricula", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Something went wrong.");
      if (json.existingId) setExistingId(json.existingId as string);
      return;
    }
    router.refresh();
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={create}
        disabled={busy}
        className="btn-ghost h-8 px-2.5 text-xs whitespace-nowrap"
        title={`Create the topic "${title}" from this node`}
      >
        {busy ? "…" : "Create topic from node"}
      </button>
      {error && (
        <span className="text-xs text-red-600 max-w-xs text-right">
          {error}
          {existingId && (
            <>
              {" "}
              <Link href={`/library/topics/${existingId}`} className="underline">
                Open it
              </Link>
            </>
          )}
        </span>
      )}
    </span>
  );
}
