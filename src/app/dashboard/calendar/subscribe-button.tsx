"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import type { Dictionary } from "@/i18n/dictionaries";

// "Link to Google/Outlook": mints (or shows) the caller's personal ICS feed
// URL — paste it into any calendar app's "subscribe by URL / from internet"
// box and the school calendar appears inside it, kept fresh by their servers.
// Rotate kills the old URL instantly (the token row is the credential).
//
// Its words arrive whole from the calendar page (`t`), the menu breadcrumbs
// included — the arrows between them are chrome, so they stay in the JSX and
// flip with the writing direction rather than living in ten message files.
export default function SubscribeButton({ t }: { t: Dictionary["comms"]["calendar"]["subscribe"] }) {
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
      if (!user) throw new Error(t.notSignedIn);
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
        🔗 {t.button}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="card w-full max-w-md p-6 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg">{t.title}</h2>
            <p className="text-sm text-[#5B6470]">
              {/* Menu breadcrumbs: the arrows walk you through a menu, so they
                  follow the reading direction rather than the screen. */}
              {t.googleLabel}{" "}
              <span className="text-[#14181F]">
                {t.googleStep1} <span className="rtl-flip">→</span> + <span className="rtl-flip">→</span> {t.googleStep2}
              </span>. {t.outlookLabel}{" "}
              <span className="text-[#14181F]">
                {t.outlookStep1} <span className="rtl-flip">→</span> {t.outlookStep2}
              </span>. {t.pasteHint}
            </p>
            {busy && <p className="text-sm text-[#98A0A9]">{t.preparing}</p>}
            {url && (
              <div className="flex items-center gap-2">
                <input readOnly value={url} onFocus={(e) => e.target.select()} className="field h-10 px-3 text-xs flex-1" />
                <button onClick={() => void copy()} className="btn-primary h-10 px-3 text-sm shrink-0">
                  {copied ? `${t.copied} ✓` : t.copy}
                </button>
              </div>
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex items-center justify-between pt-1">
              <button
                onClick={() => void ensureToken(true)}
                disabled={busy}
                className="text-xs text-[#B42318] hover:underline"
                title={t.rotateTitle}
              >
                {t.rotate}
              </button>
              <button onClick={() => setOpen(false)} className="btn-ghost h-9 px-3 text-sm">
                {t.done}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
