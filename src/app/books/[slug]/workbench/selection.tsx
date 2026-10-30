"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

// The reader's selection popover (phase 3a): select a passage inside one paragraph or question, then reword it with
// AI, edit it, or leave a note. Saved changes appear on the right; "Apply" turns them into the chapter's new text.
type Pick = { text: string; unit: string; context: string; top: number; left: number };
type Mode = "menu" | "reword" | "edit" | "note";

export default function Selection({ slug, chapter, rev, children }: { slug: string; chapter: number; rev: string; children: React.ReactNode }) {
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [mode, setMode] = useState<Mode>("menu");
  const [ask, setAsk] = useState("");
  const [draft, setDraft] = useState("");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onMouseUp() {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!sel || !text || !box.current) return;
    const unitOf = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest<HTMLElement>("[data-unit]") ?? null;
    const a = unitOf(sel.anchorNode);
    const b = unitOf(sel.focusNode);
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const c = box.current.getBoundingClientRect();
    const top = r.bottom - c.top + 8;
    const left = Math.max(0, Math.min(r.left - c.left, c.width - 340));
    if (!a || a !== b) {
      setPick({ text: "", unit: "", context: "", top, left });
      setError("Select within one paragraph or question.");
      return;
    }
    setPick({ text, unit: a.dataset.unit ?? "", context: a.innerText, top, left });
    setMode("menu");
    setAsk("");
    setDraft(text);
    setSuggestion(null);
    setError(null);
  }

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const r = await fetch("/api/pub/edits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ book: slug, ...body }) });
    const out = (await r.json().catch(() => ({}))) as { error?: string; text?: string };
    setBusy(false);
    if (!r.ok) {
      setError(out.error ?? `Not saved (${r.status}).`);
      return null;
    }
    return out;
  }

  async function suggest() {
    if (!pick) return;
    const out = await post({ action: "suggest", passage: pick.text, context: pick.context, instruction: ask });
    if (out?.text) setSuggestion(out.text);
  }

  async function save(kind: "reword" | "edit" | "note", after: string | null, instruction: string | null) {
    if (!pick) return;
    const out = await post({ action: "save", kind, chapter, rev, unit: pick.unit, before: pick.text, after, instruction });
    if (out) {
      setPick(null);
      window.getSelection()?.removeAllRanges();
      router.refresh();
    }
  }

  return (
    <div ref={box} className="relative" onMouseUp={onMouseUp}>
      {children}
      {pick && (
        <div
          className="absolute z-20 w-[21rem] rounded-xl border border-[#D8D3C6] bg-white p-2.5 text-sm shadow-lg font-sans"
          style={{ top: pick.top, left: pick.left }}
          onMouseUp={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Change this passage"
        >
          {pick.text && mode === "menu" && (
            <div className="flex gap-1">
              <button type="button" onClick={() => setMode("reword")} className="rounded-md bg-[#1F2A24] px-2.5 py-1 text-xs text-white">Reword with AI</button>
              <button type="button" onClick={() => setMode("edit")} className="rounded-md border border-[#D8D3C6] px-2.5 py-1 text-xs">Edit</button>
              <button type="button" onClick={() => setMode("note")} className="rounded-md border border-[#D8D3C6] px-2.5 py-1 text-xs">Note</button>
              <button type="button" onClick={() => setPick(null)} className="ml-auto px-1 text-xs text-[#A39C8C]" aria-label="Close">✕</button>
            </div>
          )}
          {mode === "reword" && pick.text && (
            <div className="space-y-2">
              <input value={ask} onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => e.key === "Enter" && suggest()} placeholder="Simpler words for 11-year-olds" className="w-full rounded-md border border-[#E4DCC8] px-2 py-1 text-xs" autoFocus />
              {suggestion && <p className="rounded-md bg-[#E3EEE5] px-2 py-1.5 font-serif text-[13px] leading-relaxed text-[#24543A]">{suggestion}</p>}
              <div className="flex justify-end gap-1">
                <button type="button" onClick={() => setPick(null)} className="px-2 text-xs text-[#7A7363]">Cancel</button>
                <button type="button" disabled={busy} onClick={suggest} className="rounded-md border border-[#D8D3C6] px-2.5 py-1 text-xs disabled:opacity-50">{busy && !suggestion ? "Thinking…" : suggestion ? "Try again" : "Suggest"}</button>
                {suggestion && <button type="button" disabled={busy} onClick={() => save("reword", suggestion, ask || null)} className="rounded-md bg-[#3B6FD8] px-2.5 py-1 text-xs text-white disabled:opacity-50">Use this</button>}
              </div>
            </div>
          )}
          {(mode === "edit" || mode === "note") && pick.text && (
            <div className="space-y-2">
              <textarea value={mode === "edit" ? draft : ask} onChange={(e) => (mode === "edit" ? setDraft(e.target.value) : setAsk(e.target.value))} rows={3} placeholder={mode === "note" ? "What should change here" : undefined} className="w-full rounded-md border border-[#E4DCC8] px-2 py-1 font-serif text-[13px]" autoFocus />
              <div className="flex justify-end gap-1">
                <button type="button" onClick={() => setPick(null)} className="px-2 text-xs text-[#7A7363]">Cancel</button>
                <button type="button" disabled={busy} onClick={() => (mode === "edit" ? save("edit", draft, null) : save("note", null, ask))} className="rounded-md bg-[#3B6FD8] px-2.5 py-1 text-xs text-white disabled:opacity-50">Save</button>
              </div>
            </div>
          )}
          {error && <p className="mt-1.5 text-xs text-[#8E2A21]">{error}</p>}
        </div>
      )}
    </div>
  );
}
