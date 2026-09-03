"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { LANGUAGES } from "@/utils/narration";
import { stampConfirmation } from "@/utils/junk-gate";
import JunkGateDialog, { type JunkGateInfo } from "./junk-gate-dialog";
import { type LibraryMessages } from "./labels";

// Field specs, SPECS and defaultParams live in ./options-spec (pure) — see the
// note there. This file only RENDERS them.
import { SPECS } from "./options-spec";

export default function OptionsModal({
  bookId,
  schoolId,
  chapterRef,
  kind,
  label,
  t,
  part = null,
  bookLanguage = null,
  gate = null,
}: {
  bookId: string;
  schoolId: string | null;
  chapterRef: number | string;
  kind: string;
  /** The trigger's text — already in the reader's language (the cell translates
      the kind before handing it down). */
  label: string;
  t: LibraryMessages;
  /** Generate for ONE part of the chapter (per-part lesson units). */
  part?: number | null;
  /** Detected book language (0056) — preselects the document language. */
  bookLanguage?: string | null;
  /** Junk-upload gate: non-null for a gated book — confirm before inserting. */
  gate?: JunkGateInfo | null;
}) {
  const spec = SPECS[kind];
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vals, setVals] = useState<Record<string, unknown>>(() =>
    Object.fromEntries((spec?.fields ?? []).map((f) => [f.key, f.def])),
  );
  const knownBookLang = LANGUAGES.some((l) => l.value === bookLanguage) ? bookLanguage : null;
  const [language, setLanguage] = useState(knownBookLang || "en");

  if (!spec) return null;
  const set = (k: string, v: unknown) => setVals((s) => ({ ...s, [k]: v }));

  // Gated book (junk-upload gate): "Generate" detours through the confirm
  // dialog; confirming lands in submit with the stamp.
  function onSubmit() {
    if (gate) {
      setGateOpen(true);
      return;
    }
    void submit(false);
  }

  async function submit(confirmed: boolean) {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError(t.notSignedIn);
      setBusy(false);
      return;
    }
    const params = {
      ...(spec.build(vals) ?? {}),
      ...(part ? { part } : {}),
      language,
    };
    const { error: gErr } = await supabase.from("generations").insert({
      kind,
      book_id: bookId,
      owner_id: user.id,
      school_id: schoolId,
      chapter_ref: String(chapterRef),
      params: confirmed ? stampConfirmation(params) : params,
      status: "queued",
    });
    setBusy(false);
    setGateOpen(false); // close either way — an error must show in the modal, not behind it
    if (gErr) {
      setError(gErr.message);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-[#0C8175] hover:underline whitespace-nowrap"
      >
        {label}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !busy && setOpen(false)}
        >
          <div
            className="bg-white rounded-xl border border-[#E6E8E4] p-5 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-medium mb-3" style={{ fontFamily: "var(--font-space-grotesk), sans-serif" }}>
              {(t.options.titles as Record<string, string>)[kind] ?? label}
            </h3>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3 py-0.5">
                <span className="text-sm text-[#14181F]">{t.options.language}</span>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="field h-8 px-2 text-sm"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                      {bookLanguage === l.value ? t.options.bookSuffix : ""}
                    </option>
                  ))}
                </select>
              </div>
              {spec.fields.map((f) => (
                <div key={f.key} className="flex items-center justify-between gap-3 py-0.5">
                  <span className="text-sm text-[#14181F]">{t.options.fields[f.label]}</span>
                  {f.type === "number" && (
                    <input
                      type="number"
                      min={f.min}
                      max={f.max}
                      value={Number(vals[f.key])}
                      onChange={(e) =>
                        set(f.key, Math.max(f.min, Math.min(f.max, parseInt(e.target.value || "0", 10))))
                      }
                      className="w-16 h-8 px-2 rounded-lg border border-[#E6E8E4] text-sm text-end outline-none focus:border-[#1FB8A6]"
                    />
                  )}
                  {f.type === "select" && (
                    <select
                      value={String(vals[f.key])}
                      onChange={(e) => set(f.key, e.target.value)}
                      className="h-8 px-2 rounded-lg border border-[#E6E8E4] text-sm bg-white outline-none focus:border-[#1FB8A6]"
                    >
                      {f.options.map((o) => (
                        <option key={o} value={o}>
                          {(t.options.choices[f.choices] as Record<string, string>)[o] ?? o}
                        </option>
                      ))}
                    </select>
                  )}
                  {f.type === "checkbox" && (
                    <input
                      type="checkbox"
                      checked={Boolean(vals[f.key])}
                      onChange={(e) => set(f.key, e.target.checked)}
                    />
                  )}
                </div>
              ))}
            </div>
            {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setOpen(false)}
                disabled={busy}
                className="h-9 px-3 rounded-lg border border-[#E6E8E4] text-sm hover:bg-[#F5F6F3]"
              >
                {t.common.cancel}
              </button>
              <button
                onClick={onSubmit}
                disabled={busy}
                className="h-9 px-4 rounded-lg bg-[#14181F] text-white text-sm font-medium hover:bg-[#20262F] disabled:opacity-50"
              >
                {busy ? t.options.starting : t.options.generate}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Rendered after the options modal so it paints on top of it. */}
      {gateOpen && gate && (
        <JunkGateDialog
          gate={gate}
          busy={busy}
          onConfirm={() => void submit(true)}
          onCancel={() => setGateOpen(false)}
        />
      )}
    </>
  );
}
