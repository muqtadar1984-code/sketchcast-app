"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { fmt } from "@/i18n/format";
import type { Dictionary } from "@/i18n/dictionaries";

// "Something not working?" — in-portal tech-issue reporting for every role.
// Bottom-LEFT so it never collides with the feedback widget (bottom-right).
// The student variant is data-minimized: category + a short title only, no
// free-text description or screenshots (DPDP minimization for minors —
// enforced server-side too). Reports land in the platform console's Issues
// queue.
//
// The interactive half; ./report-issue-widget is the Server Component that
// resolves the words below and renders this.

/** Every word the widget renders, handed down by its server wrapper. */
export type ReportIssueMessages = Dictionary["app"]["reportIssue"];

// The API's category codes are stored and triaged in English — only the option
// LABELS come from the dictionary, so a report filed in Jawi still lands in the
// console's "upload" bucket.
const CATEGORIES: { value: string; key: keyof ReportIssueMessages["categories"] }[] = [
  { value: "video", key: "video" },
  { value: "deck_docs", key: "deckDocs" },
  { value: "quiz", key: "quiz" },
  { value: "upload", key: "upload" },
  { value: "login", key: "login" },
  { value: "speed", key: "speed" },
  { value: "other", key: "other" },
];

const MAX_SHOTS = 3; // matches the attachment_paths check (0065)
const MAX_SHOT_BYTES = 5 * 1024 * 1024; // the bucket's file_size_limit (0065)
const MAX_EDGE = 1600; // long-edge px — plenty for a screenshot, cheap to store
const QUALITIES = [0.85, 0.7, 0.55];

// Mime types the bucket accepts (0065's allowed_mime_types) — the raw-file
// fallback must stay inside this set or storage rejects the upload anyway.
const RAW_FALLBACK_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// Downscale a screenshot to a small JPEG (the page-scanner idiom). When the
// browser can't decode it (e.g. HEIC), fall back to the raw file ONLY if the
// bucket accepts its true type — uploaded under its real contentType and
// extension, never mislabeled as JPEG; null means "skip this one".
async function shrinkShot(file: File): Promise<{ blob: Blob; contentType: string; ext: string } | null> {
  const bitmap =
    typeof createImageBitmap === "undefined"
      ? null // very old browsers: straight to the raw fallback
      : await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    const ext = RAW_FALLBACK_TYPES[file.type];
    if (!ext || file.size > MAX_SHOT_BYTES) return null;
    return { blob: file, contentType: file.type, ext };
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  let blob: Blob | null = null;
  for (const q of QUALITIES) {
    blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q));
    if (blob && blob.size <= MAX_SHOT_BYTES) return { blob, contentType: "image/jpeg", ext: "jpg" };
  }
  return null;
}

export default function ReportIssueForm({
  variant = "adult",
  t,
  common,
}: {
  variant?: "adult" | "student";
  t: ReportIssueMessages;
  common: Dictionary["common"];
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("other");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [shots, setShots] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    // Screenshots first (adult-only — `shots` never fills for students):
    // downscale, upload to the reporter's own storage folder, then send the
    // paths with the report. A shot that can't be shrunk or uploaded is
    // skipped — never worth losing the report over.
    const paths: string[] = [];
    let skipped = 0;
    if (shots.length) {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setError(t.notSignedIn);
        setBusy(false);
        return;
      }
      for (let i = 0; i < shots.length; i++) {
        try {
          const shot = await shrinkShot(shots[i]);
          if (!shot) {
            skipped++;
            continue;
          }
          const path = `${user.id}/${Date.now()}_${i}.${shot.ext}`;
          const { error: uErr } = await supabase.storage
            .from("issue-attachments")
            .upload(path, shot.blob, { contentType: shot.contentType });
          if (uErr) {
            skipped++;
            continue;
          }
          paths.push(path);
        } catch {
          // A decode/upload crash must never hang or sink the report itself.
          skipped++;
        }
      }
    }

    let res: Response;
    let json: { error?: string } = {};
    try {
      res = await fetch("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          title: title.trim(),
          description: variant === "student" ? null : description.trim() || null,
          url: window.location.pathname,
          attachments: paths,
        }),
      });
      json = await res.json().catch(() => ({}));
    } catch {
      // Network failure: surface it instead of hanging on "Sending…" forever.
      setBusy(false);
      setError(t.sendFailedNetwork);
      return;
    }
    setBusy(false);
    if (!res.ok) {
      // Don't leave orphaned screenshots behind a failed report. Best-effort.
      if (paths.length) {
        try {
          await createClient().storage.from("issue-attachments").remove(paths);
        } catch {
          /* the orphan sweep is cosmetic — the error below is what matters */
        }
      }
      setError(json.error ?? t.sendFailed);
      return;
    }
    if (skipped) setError(skipped === 1 ? t.attachedOneFailed : fmt(t.attachedSomeFailed, { n: skipped }));
    setSent(true);
    setTitle("");
    setDescription("");
    setShots([]);
    // Give the "couldn't be attached" notice time to be READ before the form
    // closes — vanishing in 1.8s would hide that evidence went missing.
    setTimeout(() => {
      setSent(false);
      setOpen(false);
      setError(null);
    }, skipped ? 6500 : 1800);
  }

  const label = variant === "student" ? t.labelStudent : t.label;

  return (
    <div className="fixed bottom-4 start-4 z-40">
      {open && (
        <form onSubmit={submit} className="card p-4 mb-2 w-80 shadow-lg">
          <p className="font-medium text-sm mb-2">{variant === "student" ? t.titleStudent : t.label}</p>
          <label className="block mb-2">
            <span className="text-xs text-[#5B6470]">{t.about}</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="field h-9 px-2 mt-1 w-full">
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{t.categories[c.key]}</option>
              ))}
            </select>
          </label>
          <label className="block mb-2">
            <span className="text-xs text-[#5B6470]">{variant === "student" ? t.summaryStudent : t.summary}</span>
            <input
              required
              minLength={4}
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={variant === "student" ? t.summaryPlaceholderStudent : t.summaryPlaceholder}
              className="field h-9 px-3 mt-1 w-full"
            />
          </label>
          {variant === "adult" && (
            <label className="block mb-2">
              <span className="text-xs text-[#5B6470]">{t.details}</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={4000}
                rows={3}
                placeholder={t.detailsPlaceholder}
                className="field px-3 py-2 mt-1 w-full text-sm"
              />
            </label>
          )}
          {variant === "adult" && (
            <div className="mb-2">
              <span className="text-xs text-[#5B6470]">
                {shots.length > 0 ? fmt(t.screenshotsCount, { n: shots.length, max: MAX_SHOTS }) : t.screenshots}
              </span>
              <input
                type="file"
                accept="image/*"
                multiple
                disabled={shots.length >= MAX_SHOTS}
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
                  setShots((prev) => [...prev, ...picked].slice(0, MAX_SHOTS));
                  e.target.value = ""; // allow re-picking the same file after a remove
                }}
                className="mt-1 w-full text-xs text-[#5B6470] file:me-2 file:rounded-lg file:border-0 file:bg-[#E2F4F1] file:px-2.5 file:py-1.5 file:text-[#0C8175] file:font-medium"
              />
              {shots.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {shots.map((f, i) => (
                    <li key={`${f.name}-${i}`} className="flex items-center gap-2 text-xs text-[#5B6470]">
                      <span className="truncate">{f.name}</span>
                      <button
                        type="button"
                        onClick={() => setShots((prev) => prev.filter((_, j) => j !== i))}
                        aria-label={fmt(t.removeFile, { name: f.name })}
                        className="shrink-0 text-[#98A0A9] hover:text-red-600"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
          <div className="flex items-center justify-between">
            <button type="button" onClick={() => setOpen(false)} className="btn-ghost h-9 px-3 text-sm">
              {common.cancel}
            </button>
            <button type="submit" disabled={busy || sent} className="btn-primary h-9 px-4 text-sm">
              {sent ? `${t.sent} ✓` : busy ? t.sending : t.send}
            </button>
          </div>
        </form>
      )}
      {/* Collapsed to an icon by default, expanding on hover/focus: as a fixed
          bottom-left widget its full-width label ran under the left edge of the
          content column on anything narrower than ~1560px. The icon keeps it
          discoverable; the label (and tooltip) still name it. */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="group flex items-center h-10 rounded-full bg-white border border-[#E6E8E4] shadow-sm px-2.5 hover:px-3.5 focus-visible:px-3.5 transition-all"
        title={label}
        aria-label={label}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#5B6470" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
          <path d="M12 9v4M12 17h.01" />
          <path d="M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z" />
        </svg>
        <span className="max-w-0 group-hover:max-w-[11rem] group-focus-visible:max-w-[11rem] ms-0 group-hover:ms-2 group-focus-visible:ms-2 overflow-hidden whitespace-nowrap text-sm text-[#14181F] transition-all duration-200">
          {label}
        </span>
      </button>
    </div>
  );
}
