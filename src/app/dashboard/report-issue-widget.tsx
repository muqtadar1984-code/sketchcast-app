"use client";

import { useState } from "react";

// "Something not working?" — in-portal tech-issue reporting for every role.
// Bottom-LEFT so it never collides with the feedback widget (bottom-right).
// The student variant is data-minimized: category + a short title only, no
// free-text description (DPDP minimization for minors — enforced server-side
// too). Reports land in the platform console's Issues queue.

const CATEGORIES = [
  { value: "video", label: "Video lesson" },
  { value: "deck_docs", label: "Deck / documents" },
  { value: "quiz", label: "Quiz" },
  { value: "upload", label: "Uploading a book" },
  { value: "login", label: "Signing in" },
  { value: "speed", label: "Slowness" },
  { value: "other", label: "Something else" },
];

export default function ReportIssueWidget({ variant = "adult" }: { variant?: "adult" | "student" }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("other");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category,
        title: title.trim(),
        description: variant === "student" ? null : description.trim() || null,
        url: window.location.pathname,
      }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Could not send — please try again.");
      return;
    }
    setSent(true);
    setTitle("");
    setDescription("");
    setTimeout(() => {
      setSent(false);
      setOpen(false);
    }, 1800);
  }

  return (
    <div className="fixed bottom-4 left-4 z-40">
      {open && (
        <form onSubmit={submit} className="card p-4 mb-2 w-80 shadow-lg">
          <p className="font-medium text-sm mb-2">
            {variant === "student" ? "Something not working?" : "Report a problem"}
          </p>
          <label className="block mb-2">
            <span className="text-xs text-[#5B6470]">What is it about?</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="field h-9 px-2 mt-1 w-full">
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </label>
          <label className="block mb-2">
            <span className="text-xs text-[#5B6470]">{variant === "student" ? "What happened? (a few words)" : "Summary"}</span>
            <input
              required
              minLength={4}
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={variant === "student" ? "The video won't play" : "e.g. Deck download fails on Unit 3"}
              className="field h-9 px-3 mt-1 w-full"
            />
          </label>
          {variant === "adult" && (
            <label className="block mb-2">
              <span className="text-xs text-[#5B6470]">Details (optional)</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={4000}
                rows={3}
                placeholder="What did you expect, what happened instead?"
                className="field px-3 py-2 mt-1 w-full text-sm"
              />
            </label>
          )}
          {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
          <div className="flex items-center justify-between">
            <button type="button" onClick={() => setOpen(false)} className="btn-ghost h-9 px-3 text-sm">
              Cancel
            </button>
            <button type="submit" disabled={busy || sent} className="btn-primary h-9 px-4 text-sm">
              {sent ? "Sent ✓" : busy ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        className="btn-ghost h-9 px-3 text-sm bg-white border border-[#E6E8E4] shadow-sm"
        aria-label="Report a problem"
      >
        {variant === "student" ? "Need help?" : "Report a problem"}
      </button>
    </div>
  );
}
