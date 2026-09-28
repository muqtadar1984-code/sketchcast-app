"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type DemoFact = { label: string; value: string };

export type DemoView = {
  id: string;
  demo: string;
  topicTitle: string | null;
  topicId: string | null;
  status: string;
  createdAt: string;
  videoUrl: string | null;
  thumbUrl: string | null;
  facts: DemoFact[];
};

// One demo: the video, the facts a reviewer compares against the live
// version (what was pinned, how it measured), and Delete once it has been
// judged — the files go with the row.
export default function DemoCard({ demo, canDelete }: { demo: DemoView; canDelete: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (!window.confirm(`Delete this demo (${demo.demo})? The video and its files are removed for good; the live version is not touched.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/library/demos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", generationId: demo.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `Could not delete (${res.status}).`);
        setBusy(false);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete.");
      setBusy(false);
    }
  };

  return (
    <article className="card p-5 space-y-3">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-medium truncate">{demo.topicTitle ?? "(no topic)"}</h2>
          <p className="text-sm text-[#5B6470]">
            <span className="font-mono">{demo.demo}</span> · {demo.status} · {new Date(demo.createdAt).toLocaleString()}
          </p>
        </div>
        {canDelete && (
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="shrink-0 text-sm px-3 py-1.5 rounded-md border border-[#C9CED4] text-[#8B1E1E] hover:bg-[#FBEAEA] disabled:opacity-50"
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
        )}
      </header>
      {demo.videoUrl ? (
        <video
          controls
          preload="metadata"
          src={demo.videoUrl}
          poster={demo.thumbUrl ?? undefined}
          controlsList="nodownload"
          disablePictureInPicture
          disableRemotePlayback
          onContextMenu={(e) => e.preventDefault()}
          className="w-full rounded-lg bg-black aspect-video"
        />
      ) : (
        <p className="text-xs text-[#98A0A9]">No video yet — the worker is still on it, or it failed.</p>
      )}
      {demo.facts.length > 0 && (
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm">
          {demo.facts.map((f) => (
            <div key={f.label} className="min-w-0">
              <dt className="text-xs text-[#5B6470]">{f.label}</dt>
              <dd className="truncate">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {error && <p className="text-sm text-[#8B1E1E]">{error}</p>}
    </article>
  );
}
