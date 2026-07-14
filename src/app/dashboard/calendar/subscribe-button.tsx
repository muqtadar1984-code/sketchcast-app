"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";

// "Link to Google/Outlook": mints (or shows) the caller's personal ICS feed
// URL — paste it into any calendar app's "subscribe by URL / from internet"
// box and the school calendar appears inside it, kept fresh by their servers.
// Rotate kills the old URL instantly (the token row is the credential).
export default function SubscribeButton() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ensureToken(rotate = false) {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      if (rotate) await supabase.from("calendar_feed_tokens").delete().eq("user_id", user.id);
      let { data: row } = await supabase.from("calendar_feed_tokens").select("token").maybeSingle();
      if (!row) {
        const ins = await supabase.from("calendar_feed_tokens").insert({ user_id: user.id }).select("token").single();
        if (ins.error) throw new Error(ins.error.message);
        row = ins.data;
      }
      setUrl(`${window.location.origin}/api/calendar/feed/${row!.token}.ics`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function openPanel() {
    setOpen(true);
    if (!url) void ensureToken();
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* selection fallback below */
    }
  }

  return (
    <>
      <button onClick={openPanel} className="btn-ghost h-10 px-4 text-sm">
        🔗 Link to Google/Outlook
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="card w-full max-w-md p-6 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg">Subscribe from your calendar app</h2>
            <p className="text-sm text-[#5B6470]">
              In Google Calendar: <span className="text-[#14181F]">Other calendars → + → From URL</span>. In Outlook:{" "}
              <span className="text-[#14181F]">Add calendar → Subscribe from web</span>. Paste this personal address —
              it shows exactly what you can see here, and stays up to date.
            </p>
            {busy && <p className="text-sm text-[#98A0A9]">Preparing your address…</p>}
            {url && (
              <div className="flex items-center gap-2">
                <input readOnly value={url} onFocus={(e) => e.target.select()} className="field h-10 px-3 text-xs flex-1" />
                <button onClick={() => void copy()} className="btn-primary h-10 px-3 text-sm shrink-0">
                  {copied ? "Copied ✓" : "Copy"}
                </button>
              </div>
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex items-center justify-between pt-1">
              <button
                onClick={() => void ensureToken(true)}
                disabled={busy}
                className="text-xs text-[#B42318] hover:underline"
                title="Old address stops working immediately"
              >
                Rotate address
              </button>
              <button onClick={() => setOpen(false)} className="btn-ghost h-9 px-3 text-sm">
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
