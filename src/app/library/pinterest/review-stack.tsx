"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { canApprove, copyProblems, feedTitle, LIMITS, type PinView } from "@/utils/catalogue/pinterest";
import { languageName } from "./chrome";

// The review stack (build plan §4.1): ONE pin at a time. Keys: A approve,
// R reject, E edit, → / J next, ← / K previous. Each action is one POST to
// /api/library/pinterest/pins with one pin id — the route re-checks
// everything; nothing here can act on more than one pin (decision D1).

const API = "/api/library/pinterest/pins";

type Mode = "view" | "edit" | "reject";

async function call(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: res.ok, error: json.error };
}

export function ReviewStack({ pins, canAct }: { pins: PinView[]; canAct: boolean }) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<Mode>("view");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [draft, setDraft] = useState({ title: "", description: "", alt_text: "" });
  const [reason, setReason] = useState("");
  const reasonRef = useRef<HTMLInputElement>(null);

  const left = pins.filter((p) => !done.has(p.id));
  const pin = left[Math.min(index, Math.max(0, left.length - 1))];

  const startEdit = useCallback(() => {
    if (!pin) return;
    setDraft({ title: pin.title ?? "", description: pin.description ?? "", alt_text: pin.alt_text ?? "" });
    setMode("edit");
  }, [pin]);

  const act = useCallback(
    async (action: "approve" | "reject" | "edit" | "rerender", extra: Record<string, unknown> = {}) => {
      if (!pin || busy) return;
      setBusy(true);
      setMessage(null);
      const r = await call({ action, pinId: pin.id, ...extra });
      setBusy(false);
      if (!r.ok) {
        setMessage({ tone: "bad", text: r.error ?? "That did not work." });
        return;
      }
      const verb = { approve: "Approved", reject: "Rejected", edit: "Saved — the worker re-checks it before it can be approved", rerender: "Sent back for a redraw" }[action];
      setMessage({ tone: "good", text: `${verb}: ${pin.title ?? "pin"}` });
      setMode("view");
      setReason("");
      if (action !== "edit") setDone((d) => new Set(d).add(pin.id));
      router.refresh();
    },
    [pin, busy, router],
  );

  useEffect(() => {
    if (!canAct) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || mode !== "view") return;
      const k = e.key.toLowerCase();
      if (k === "a") {
        e.preventDefault();
        void act("approve");
      } else if (k === "r") {
        e.preventDefault();
        setMode("reject");
        setTimeout(() => reasonRef.current?.focus(), 0);
      } else if (k === "e") {
        e.preventDefault();
        startEdit();
      } else if (k === "arrowright" || k === "j") {
        setIndex((i) => Math.min(i + 1, Math.max(0, left.length - 1)));
      } else if (k === "arrowleft" || k === "k") {
        setIndex((i) => Math.max(0, i - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canAct, mode, act, startEdit, left.length]);

  if (!pin) {
    return (
      <div className="rounded-xl border border-[#E3E6E0] bg-white px-6 py-10 text-center">
        <p className="font-medium">All reviewed.</p>
        <p className="text-sm text-[#5B6470] mt-1">Approved pins wait in Scheduled &amp; posted for the next round.</p>
      </div>
    );
  }

  const approvable = canApprove(pin);
  const ft = feedTitle(pin.title);
  const blocking = pin.precheck?.blocking ?? [];
  const warnings = pin.precheck?.warnings ?? [];
  const rtl = ["ar", "ur", "ms-arab"].includes(pin.language);
  const editProblems = mode === "edit" ? copyProblems(draft) : [];

  return (
    <section aria-label="Pin under review" className="grid gap-6 md:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
      {/* the pin as Pinterest will show it: 2:3 */}
      <div>
        <div className="aspect-[2/3] w-full max-w-[340px] overflow-hidden rounded-2xl border border-[#E3E6E0] bg-[#F4F5F2]">
          {pin.imageUrls[0] ? (
            // eslint-disable-next-line @next/next/no-img-element -- signed storage URL, sized by its box
            <img src={pin.imageUrls[0]} alt={pin.alt_text ?? ""} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-[#9A6400]">Image missing</div>
          )}
        </div>
        {pin.imageUrls.length > 1 ? (
          <p className="mt-2 text-xs text-[#5B6470]">Carousel: {pin.imageUrls.length} cards (first shown).</p>
        ) : null}
        <p className="mt-3 text-xs text-[#5B6470] tabular-nums">
          Pin {Math.min(index, left.length - 1) + 1} of {left.length} waiting
          {canAct ? " · A approve · R reject · E edit · → next" : ""}
        </p>
      </div>

      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="chip bg-[#EEF0EC] text-[#5B6470]">{languageName(pin.language)}</span>
          <span className="chip bg-[#EEF0EC] text-[#5B6470]">{pin.template}</span>
          {pin.topicTitle ? <span className="chip bg-[#EEF0EC] text-[#5B6470]">{pin.topicTitle}</span> : null}
          {pin.ai_modified ? <span className="chip bg-[#FFF1D6] text-[#9A6400]" title="Declared to Pinterest as AI-modified (decision D4)">AI-modified artwork</span> : null}
          {pin.edited ? <span className="chip bg-[#E8F0FE] text-[#1F4FB8]">edited</span> : null}
        </div>

        {mode === "edit" ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void act("edit", draft);
            }}
          >
            <Field id="pin-title" label="Title" max={LIMITS.title} value={draft.title} rtl={rtl} onChange={(v) => setDraft((d) => ({ ...d, title: v }))} />
            <Field id="pin-description" label="Description" max={LIMITS.description} value={draft.description} rtl={rtl} multiline onChange={(v) => setDraft((d) => ({ ...d, description: v }))} />
            <Field id="pin-alt" label="Alt text" max={LIMITS.alt_text} value={draft.alt_text} rtl={rtl} multiline onChange={(v) => setDraft((d) => ({ ...d, alt_text: v }))} />
            {editProblems.length ? <p className="text-sm text-[#B42318]">{editProblems.join(" ")}</p> : null}
            <div className="flex gap-2">
              <button type="submit" disabled={busy || editProblems.length > 0} className="btn-primary h-9 px-4 text-sm disabled:opacity-50">Save</button>
              <button type="button" onClick={() => setMode("view")} className="btn-ghost h-9 px-3 text-sm disabled:opacity-50">Cancel</button>
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-[#5B6470]">Title · first {ft.shown.length < 40 ? "line" : "40 characters"} show in feeds</p>
              <p className="text-lg font-medium break-words" dir={rtl ? "rtl" : undefined}>
                {ft.shown}
                {ft.hidden ? <span className="text-[#98A0A9]">{ft.hidden}</span> : null}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-[#5B6470]">Description</p>
              <p className="text-sm whitespace-pre-line break-words" dir={rtl ? "rtl" : undefined}>{pin.description}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-[#5B6470]">Alt text</p>
              <p className="text-sm break-words" dir={rtl ? "rtl" : undefined}>{pin.alt_text}</p>
            </div>
            {pin.back_translation ? (
              <div className="rounded-lg bg-[#F4F5F2] px-4 py-3">
                <p className="text-xs uppercase tracking-wide text-[#5B6470] mb-1">English back-translation</p>
                <p className="text-sm font-medium">{pin.back_translation.title}</p>
                <p className="text-sm">{pin.back_translation.description}</p>
              </div>
            ) : null}
          </div>
        )}

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-[#5B6470]">Board</dt>
          <dd>{pin.boardName ?? <span className="text-[#B42318]">none</span>}{pin.grade_band ? ` · ${pin.grade_band}` : ""}</dd>
          <dt className="text-[#5B6470]">Link</dt>
          <dd className="truncate">
            {pin.link ? (
              <a href={pin.link} target="_blank" rel="noopener noreferrer" className="underline decoration-[#C9CEC6] hover:decoration-current">{pin.link}</a>
            ) : (
              <span className="text-[#B42318]">none</span>
            )}
          </dd>
        </dl>

        <div className="rounded-lg border border-[#E3E6E0] px-4 py-3 text-sm">
          <p className="text-xs uppercase tracking-wide text-[#5B6470] mb-1">Worker prechecks</p>
          {!pin.precheck?.checked_at ? (
            <p className="text-[#9A6400]">Not checked since the last change — the worker re-checks it shortly.</p>
          ) : blocking.length === 0 && warnings.length === 0 ? (
            <p className="text-[#0F7A68]">All passed.</p>
          ) : (
            <ul className="space-y-0.5">
              {blocking.map((b) => <li key={b} className="text-[#B42318]">Blocks: {b}</li>)}
              {warnings.map((w) => <li key={w} className="text-[#9A6400]">Note: {w}</li>)}
            </ul>
          )}
        </div>

        {message ? (
          <p role="status" className={`text-sm rounded-lg px-3 py-2 ${message.tone === "good" ? "bg-[#E6F6F2] text-[#0F7A68]" : "bg-[#FFF1F0] text-[#B42318]"}`}>
            {message.text}
          </p>
        ) : null}

        {canAct && mode === "reject" ? (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void act("reject", { reason });
            }}
          >
            <label htmlFor="pin-reject-reason" className="sr-only">Why reject this pin?</label>
            <input
              id="pin-reject-reason"
              ref={reasonRef}
              value={reason}
              maxLength={LIMITS.reject_reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why? e.g. the label points at the wrong part"
              className="field h-9 px-3 flex-1 min-w-[240px]"
            />
            <button type="submit" disabled={busy || !reason.trim()} className="btn-ghost h-9 px-3 text-sm text-[#B42318] disabled:opacity-50">Reject</button>
            <button type="button" onClick={() => setMode("view")} className="btn-ghost h-9 px-3 text-sm disabled:opacity-50">Cancel</button>
          </form>
        ) : null}

        {canAct && mode === "view" ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !approvable.ok}
              title={approvable.ok ? "Approve this one pin (A)" : approvable.why}
              onClick={() => void act("approve")}
              className="btn-primary h-9 px-4 text-sm disabled:opacity-50"
            >
              Approve
            </button>
            <button type="button" disabled={busy} onClick={startEdit} className="btn-ghost h-9 px-3 text-sm disabled:opacity-50">Edit</button>
            <button type="button" disabled={busy} onClick={() => setMode("reject")} className="btn-ghost h-9 px-3 text-sm disabled:opacity-50">Reject</button>
            <button type="button" disabled={busy} onClick={() => void act("rerender")} className="btn-ghost h-9 px-3 text-sm disabled:opacity-50" title="Send back to the worker for a fresh image and prechecks">Re-render</button>
            <span className="flex-1" />
            <button type="button" disabled={index === 0} onClick={() => setIndex((i) => Math.max(0, i - 1))} className="btn-ghost h-9 px-3 text-sm disabled:opacity-50">← Previous</button>
            <button type="button" disabled={index >= left.length - 1} onClick={() => setIndex((i) => i + 1)} className="btn-ghost h-9 px-3 text-sm disabled:opacity-50">Next →</button>
          </div>
        ) : null}
        {canAct && mode === "view" && !approvable.ok ? <p className="text-xs text-[#9A6400]">{approvable.why}</p> : null}
        {!canAct ? <p className="text-xs text-[#9A6400] bg-[#FFF9EE] rounded-lg px-3 py-2">Read-only for your role: approving pins is for platform admins.</p> : null}
      </div>
    </section>
  );
}

function Field({
  id, label, max, value, onChange, multiline = false, rtl = false,
}: { id: string; label: string; max: number; value: string; onChange: (v: string) => void; multiline?: boolean; rtl?: boolean }) {
  const count = [...value].length;
  return (
    <div>
      <div className="flex justify-between text-xs text-[#5B6470]">
        <label htmlFor={id}>{label}</label>
        <span className={`tabular-nums ${count > max ? "text-[#B42318]" : ""}`}>{count} / {max}</span>
      </div>
      {multiline ? (
        <textarea id={id} value={value} dir={rtl ? "rtl" : undefined} rows={4} onChange={(e) => onChange(e.target.value)} className="field w-full px-3 py-2 mt-1" />
      ) : (
        <input id={id} value={value} dir={rtl ? "rtl" : undefined} onChange={(e) => onChange(e.target.value)} className="field w-full px-3 py-2 mt-1" />
      )}
    </div>
  );
}
