"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// "New topic" — POST /api/library/topics, then router.refresh() so the server
// list re-renders with the row (ops-controls.tsx pattern). A 409 with
// existingId means the key is taken: offer the existing topic instead.

export default function NewTopicForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingId, setExistingId] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setExistingId(null);
    const res = await fetch("/api/library/topics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, subject, summary }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Something went wrong.");
      if (json.existingId) setExistingId(json.existingId as string);
      return;
    }
    setTitle("");
    setSubject("");
    setSummary("");
    setOpen(false);
    router.push(`/library/topics/${json.id}`);
    router.refresh();
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-primary h-9 px-4 text-sm">
        New topic
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="card p-4 w-full sm:w-[28rem] space-y-3 text-sm">
      <p className="font-medium">New topic</p>
      <label className="block">
        <span className="text-xs text-[#5B6470]">Title (English working title — becomes the canonical key)</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={120}
          className="field w-full h-9 px-3 mt-1"
          placeholder="e.g. The Cell"
          autoFocus
        />
      </label>
      <label className="block">
        <span className="text-xs text-[#5B6470]">Subject</span>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={60}
          className="field w-full h-9 px-3 mt-1"
          placeholder="Biology"
        />
      </label>
      <label className="block">
        <span className="text-xs text-[#5B6470]">Summary (optional)</span>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          maxLength={2000}
          rows={3}
          className="field w-full px-3 py-2 mt-1"
          placeholder="One or two sentences on what the topic covers."
        />
      </label>
      {error && (
        <p className="text-red-600">
          {error}
          {existingId && (
            <>
              {" "}
              <a href={`/library/topics/${existingId}`} className="underline">
                Open the existing topic
              </a>
              .
            </>
          )}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy || !title.trim()} className="btn-primary h-9 px-4">
          {busy ? "Creating…" : "Create"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn-ghost h-9 px-3">
          Cancel
        </button>
      </div>
    </form>
  );
}
