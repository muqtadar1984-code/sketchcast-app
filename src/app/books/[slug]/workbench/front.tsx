"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { FrontPiece } from "@/utils/books/front-matter";

// The front matter in the reader (phase 3c): the preface, the declaration and "How this book works", each as the next
// compile will print it, with Edit and Reword with AI. A saved change prints from the next compile.
export default function Front({ slug, pieces, canEdit }: { slug: string; pieces: FrontPiece[]; canEdit: boolean }) {
  return (
    <div className="space-y-12">
      {pieces.map((p) => (
        <Piece key={p.unit} slug={slug} piece={p} canEdit={canEdit} />
      ))}
    </div>
  );
}

function Piece({ slug, piece, canEdit }: { slug: string; piece: FrontPiece; canEdit: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"read" | "edit" | "reword">("read");
  const [draft, setDraft] = useState(piece.text ?? "");
  const [ask, setAsk] = useState("");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = piece.edit !== null && piece.text !== piece.printed;

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

  async function save(text: string) {
    if (await post({ action: "front", unit: piece.unit, before: piece.text, text })) {
      setMode("read");
      setSuggestion(null);
      router.refresh();
    }
  }

  async function suggest() {
    const out = await post({ action: "suggest", passage: piece.text ?? "", context: "", instruction: ask });
    if (out?.text) setSuggestion(out.text);
  }

  return (
    <section>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-2xl text-[#1F2A24]">{piece.label}</h2>
        {pending && <span className="rounded-full bg-[#E8EEFB] px-2 py-0.5 text-[11px] text-[#3B6FD8]">Prints at the next compile</span>}
      </div>
      {mode === "edit" ? (
        <div className="mt-3 space-y-2">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(18, Math.max(5, draft.split("\n").length + 2))} className="w-full rounded-lg border border-[#E4DCC8] p-3 font-serif text-[16px] leading-[1.7]" autoFocus />
          <div className="flex justify-end gap-2 text-sm">
            <button type="button" onClick={() => { setMode("read"); setDraft(piece.text ?? ""); }} className="px-2 text-[#7A7363]">Cancel</button>
            <button type="button" disabled={busy || !draft.trim()} onClick={() => save(draft)} className="rounded-md bg-[#3B6FD8] px-3 py-1 text-white disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
          </div>
        </div>
      ) : (
        <div className="mt-3 font-serif text-[17px] leading-[1.75]">
          {piece.text ? piece.text.split("\n").filter((x) => x.trim()).map((x, i) => <p key={i} className="mb-3">{x}</p>) : <p className="text-[15px] text-[#A39C8C]">Not written yet. Compile the book once to see the engine&apos;s text, or write it here.</p>}
        </div>
      )}
      {mode === "reword" && (
        <div className="mt-2 space-y-2 rounded-lg border border-[#E4DCC8] bg-white p-3 text-sm">
          <input value={ask} onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => e.key === "Enter" && suggest()} placeholder="Warmer, and shorter" className="w-full rounded-md border border-[#E4DCC8] px-2 py-1 text-xs" autoFocus />
          {suggestion && <div className="rounded-md bg-[#E3EEE5] px-3 py-2 font-serif text-[14px] leading-relaxed text-[#24543A]">{suggestion.split("\n").filter((x) => x.trim()).map((x, i) => <p key={i} className="mb-2 last:mb-0">{x}</p>)}</div>}
          <div className="flex justify-end gap-1">
            <button type="button" onClick={() => { setMode("read"); setSuggestion(null); }} className="px-2 text-xs text-[#7A7363]">Cancel</button>
            <button type="button" disabled={busy} onClick={suggest} className="rounded-md border border-[#D8D3C6] px-2.5 py-1 text-xs disabled:opacity-50">{busy && !suggestion ? "Thinking…" : suggestion ? "Try again" : "Suggest"}</button>
            {suggestion && <button type="button" disabled={busy} onClick={() => save(suggestion)} className="rounded-md bg-[#3B6FD8] px-2.5 py-1 text-xs text-white disabled:opacity-50">Use this</button>}
          </div>
        </div>
      )}
      {canEdit && mode === "read" && (
        <div className="mt-1 flex gap-1 font-sans">
          <button type="button" onClick={() => { setDraft(piece.text ?? ""); setMode("edit"); }} className="rounded-md border border-[#D8D3C6] px-2.5 py-0.5 text-xs text-[#5F5A4E] hover:border-[#B8862F]">{piece.text ? "Edit" : "Write"}</button>
          {piece.text && <button type="button" onClick={() => setMode("reword")} className="rounded-md border border-[#D8D3C6] px-2.5 py-0.5 text-xs text-[#5F5A4E] hover:border-[#B8862F]">Reword with AI</button>}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-[#8E2A21]">{error}</p>}
    </section>
  );
}
