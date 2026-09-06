"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { TopicHit } from "@/utils/catalogue/types";
import { TopicSearch } from "../pickers";

// Per-candidate controls — POST /api/library/candidates then router.refresh().
//   Merge into suggested   (when the harvester found an alias match)
//   Merge into…            (type-ahead over the topics)
//   Create topic           (a new candidate-status topic keyed from the title)
//   Dismiss
// A 409 carries existingId / conflictTopicId: the name already belongs to a
// topic, which is where it should merge — offered as a one-click follow-up.

export default function CandidateActions({
  candidateId,
  suggested,
}: {
  candidateId: string;
  suggested: TopicHit | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflictId, setConflictId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  async function call(payload: Record<string, unknown>, label: string) {
    setBusy(label);
    setError(null);
    setConflictId(null);
    const res = await fetch("/api/library/candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId, ...payload }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(json.error ?? "Something went wrong.");
      const id = (json.existingId ?? json.conflictTopicId) as string | undefined;
      if (id) setConflictId(id);
      return;
    }
    setPicking(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1.5 text-xs">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {suggested && (
          <button
            type="button"
            disabled={!!busy}
            onClick={() => call({ mode: "merge", topicId: suggested.id }, "merge-suggested")}
            className="btn-primary h-8 px-2.5"
            title={`Merge into "${suggested.title}"`}
          >
            {busy === "merge-suggested" ? "…" : "Merge into suggested"}
          </button>
        )}
        <button type="button" disabled={!!busy} onClick={() => setPicking((v) => !v)} className="btn-ghost h-8 px-2.5">
          Merge into…
        </button>
        <button type="button" disabled={!!busy} onClick={() => call({ mode: "create" }, "create")} className="btn-ghost h-8 px-2.5">
          {busy === "create" ? "…" : "Create topic"}
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => call({ mode: "dismiss" }, "dismiss")}
          className="h-8 px-2.5 rounded-lg text-[#B3401F] hover:bg-[#FFE9E3]"
        >
          {busy === "dismiss" ? "…" : "Dismiss"}
        </button>
      </div>
      {picking && (
        <div className="w-72">
          <TopicSearch onPick={(t) => void call({ mode: "merge", topicId: t.id }, "merge")} placeholder="Merge into which topic?" autoFocus />
        </div>
      )}
      {error && (
        <p className="text-red-600 text-right max-w-sm">
          {error}
          {conflictId && (
            <>
              {" "}
              <button type="button" onClick={() => call({ mode: "merge", topicId: conflictId }, "merge-conflict")} className="underline">
                Merge into it
              </button>{" "}
              ·{" "}
              <Link href={`/library/topics/${conflictId}`} className="underline">
                open
              </Link>
            </>
          )}
        </p>
      )}
    </div>
  );
}
