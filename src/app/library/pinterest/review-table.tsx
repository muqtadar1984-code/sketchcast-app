"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  canApprove,
  canRerender,
  canUnapprove,
  copyProblems,
  feedTitle,
  LIMITS,
  type PinStatus,
  type PinView,
} from "@/utils/catalogue/pinterest";
import { languageName, PinStatusChip } from "./chrome";

// The review table (founder 2026-10-24, "option B"): every pin under review
// AND every pin already acted on, one row each, on the left; the selected
// pin in full on the right. A pin never disappears after an action — its row
// keeps showing what was done, so it is easy to see what is finished.
//
// Still ONE PIN AT A TIME (Pinterest: the user must choose each Pin; decision
// D1): every button acts on the selected row only, there is no select-all,
// and the route takes one pin id. Keys: ↑/↓ (or K/J) move, A approve,
// R reject, E edit, U undo an approval.

const API = "/api/library/pinterest/pins";

type Action = "approve" | "unapprove" | "reject" | "edit" | "rerender";
type Mode = "view" | "edit" | "reject";
type Filter = "all" | "waiting" | "approved" | "rejected" | "failed";

const FILTERS: { key: Filter; label: string; statuses: PinStatus[] | null }[] = [
  { key: "all", label: "All", statuses: null },
  { key: "waiting", label: "Waiting", statuses: ["in_review"] },
  { key: "approved", label: "Approved", statuses: ["approved"] },
  { key: "rejected", label: "Rejected", statuses: ["rejected"] },
  { key: "failed", label: "Failed", statuses: ["failed", "draft"] },
];

// waiting first, then what was done
const ORDER: Record<string, number> = { in_review: 0, draft: 1, approved: 2, rejected: 3, failed: 4 };

const DONE_TEXT: Record<Action, string> = {
  approve: "Approved",
  unapprove: "Back in review",
  reject: "Rejected",
  edit: "Saved — the worker re-checks it before it can be approved",
  rerender: "Sent back for a redraw",
};

const NEXT_STATUS: Record<Action, PinStatus> = {
  approve: "approved",
  unapprove: "in_review",
  reject: "rejected",
  edit: "in_review",
  rerender: "draft",
};

async function call(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: res.ok, error: json.error };
}

export function ReviewTable({ pins, canAct }: { pins: PinView[]; canAct: boolean }) {
  const router = useRouter();
  // what this session just did, shown at once while the page refreshes
  const [local, setLocal] = useState<Record<string, PinStatus>>({});
  const rows = useMemo(
    () =>
      pins
        .map((p) => (local[p.id] && local[p.id] !== p.status ? { ...p, status: local[p.id] } : p))
        .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.created_at.localeCompare(b.created_at)),
    [pins, local],
  );
  const [filter, setFilter] = useState<Filter>("all");
  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter)!;
    return f.statuses ? rows.filter((r) => f.statuses!.includes(r.status)) : rows;
  }, [rows, filter]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: rows.length, waiting: 0, approved: 0, rejected: 0, failed: 0 };
    for (const r of rows) for (const f of FILTERS) if (f.statuses?.includes(r.status)) c[f.key] += 1;
    return c;
  }, [rows]);

  const [selectedId, setSelectedId] = useState<string | null>(() => rows.find((r) => r.status === "in_review")?.id ?? rows[0]?.id ?? null);
  const pin = shown.find((r) => r.id === selectedId) ?? shown[0] ?? null;

  const [mode, setMode] = useState<Mode>("view");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [draft, setDraft] = useState({ title: "", description: "", alt_text: "" });
  const [reason, setReason] = useState("");
  const reasonRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const asideRef = useRef<HTMLElement | null>(null);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    setMode("view");
    setReason("");
    setMessage(null);
    if (id) rowRefs.current[id]?.scrollIntoView({ block: "nearest" });
  }, []);

  const move = useCallback(
    (step: number) => {
      if (!shown.length) return;
      const i = Math.max(0, shown.findIndex((r) => r.id === pin?.id));
      select(shown[Math.min(shown.length - 1, Math.max(0, i + step))].id);
    },
    [shown, pin, select],
  );

  const startEdit = useCallback(() => {
    if (!pin) return;
    setDraft({ title: pin.title ?? "", description: pin.description ?? "", alt_text: pin.alt_text ?? "" });
    setMode("edit");
  }, [pin]);

  const act = useCallback(
    async (action: Action, extra: Record<string, unknown> = {}) => {
      if (!pin || busy) return;
      setBusy(true);
      setMessage(null);
      const r = await call({ action, pinId: pin.id, ...extra });
      setBusy(false);
      if (!r.ok) {
        setMessage({ tone: "bad", text: r.error ?? "That did not work." });
        return;
      }
      setLocal((l) => ({ ...l, [pin.id]: NEXT_STATUS[action] }));
      setMode("view");
      setReason("");
      // after a decision, go to the next pin still waiting; the done row stays put
      const next = action === "approve" || action === "reject"
        ? rows.find((x) => x.id !== pin.id && x.status === "in_review" && (local[x.id] ?? x.status) === "in_review")
        : null;
      if (next && shown.some((s) => s.id === next.id)) {
        setSelectedId(next.id);
        rowRefs.current[next.id]?.scrollIntoView({ block: "nearest" });
      }
      setMessage({ tone: "good", text: `${DONE_TEXT[action]}: ${pin.title ?? "pin"}` });
      router.refresh();
    },
    [pin, busy, rows, local, shown, router],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || mode !== "view") return;
      const k = e.key.toLowerCase();
      if (k === "arrowdown" || k === "j") {
        e.preventDefault();
        move(1);
      } else if (k === "arrowup" || k === "k") {
        e.preventDefault();
        move(-1);
      } else if (!canAct || !pin) {
        return;
      } else if (k === "a" && pin.status === "in_review") {
        e.preventDefault();
        void act("approve");
      } else if (k === "u" && pin.status === "approved") {
        e.preventDefault();
        void act("unapprove");
      } else if (k === "r" && ["in_review", "approved", "failed"].includes(pin.status)) {
        e.preventDefault();
        setMode("reject");
        setTimeout(() => reasonRef.current?.focus(), 0);
      } else if (k === "e" && ["in_review", "approved"].includes(pin.status)) {
        e.preventDefault();
        startEdit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canAct, mode, act, startEdit, move, pin]);

  return (
    <div className="space-y-3">
      <div role="group" aria-label="Show pins" className="flex flex-wrap gap-1 text-sm">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={
              filter === f.key
                ? "rounded-full px-3 py-1 bg-[#EEF0EC] text-[#14181F] font-medium"
                : "rounded-full px-3 py-1 text-[#5B6470] hover:text-[#14181F] hover:bg-[#F4F5F2]"
            }
          >
            {f.label} <span className="tabular-nums opacity-80">{counts[f.key]}</span>
          </button>
        ))}
        <span className="ml-auto self-center text-xs text-[#98A0A9] hidden sm:inline">
          ↑ ↓ move{canAct ? " · A approve · R reject · E edit · U undo" : ""}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] items-start">
        {/* the table */}
        <div className="rounded-xl border border-[#E3E6E0] bg-white overflow-hidden">
          <div className="grid grid-cols-[44px_minmax(0,1fr)_auto] gap-3 px-3 py-2 text-xs text-[#5B6470] bg-[#F7F8F5] border-b border-[#E3E6E0]">
            <span />
            <span>Pin</span>
            <span>Status</span>
          </div>
          {shown.length === 0 ? (
            <p className="px-4 py-8 text-sm text-center text-[#5B6470]">No pins here.</p>
          ) : (
            <ul role="listbox" aria-label="Pins" className="divide-y divide-[#EEF0EC]">
              {shown.map((r) => {
                const active = r.id === pin?.id;
                return (
                  <li key={r.id}>
                    <button
                      ref={(el) => {
                        rowRefs.current[r.id] = el;
                      }}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        select(r.id);
                        // on a phone the details sit below the table: bring them into view
                        if (window.matchMedia("(max-width: 1023px)").matches) {
                          setTimeout(() => asideRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 0);
                        }
                      }}
                      className={`grid w-full grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#7FD8A8] ${
                        active ? "bg-[#EEF6F1]" : "hover:bg-[#F7F8F5]"
                      }`}
                    >
                      <span className="block h-[60px] w-[40px] overflow-hidden rounded border border-[#E3E6E0] bg-[#F4F5F2]">
                        {r.imageUrls[0] ? (
                          // eslint-disable-next-line @next/next/no-img-element -- signed storage URL thumbnail
                          <img src={r.imageUrls[0]} alt="" className="h-full w-full object-cover" />
                        ) : null}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium" dir={["ar", "ur", "ms-arab"].includes(r.language) ? "rtl" : undefined}>
                          {r.title ?? <span className="text-[#98A0A9]">no title yet</span>}
                        </span>
                        <span className="block truncate text-xs text-[#5B6470]">
                          {r.topicTitle ?? "—"} · {r.template}
                          {r.language !== "en" ? ` · ${languageName(r.language)}` : ""}
                        </span>
                      </span>
                      <span>
                        <PinStatusChip status={r.status} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* the selected pin */}
        <aside ref={asideRef} aria-label="Selected pin" className="lg:sticky lg:top-4 rounded-xl border border-[#E3E6E0] bg-white p-4">
          {!pin ? (
            <p className="text-sm text-[#5B6470]">Select a pin to see it in full.</p>
          ) : (
            <Detail
              pin={pin}
              canAct={canAct}
              mode={mode}
              setMode={setMode}
              busy={busy}
              message={message}
              draft={draft}
              setDraft={setDraft}
              reason={reason}
              setReason={setReason}
              reasonRef={reasonRef}
              act={act}
              startEdit={startEdit}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function Detail({
  pin, canAct, mode, setMode, busy, message, draft, setDraft, reason, setReason, reasonRef, act, startEdit,
}: {
  pin: PinView;
  canAct: boolean;
  mode: Mode;
  setMode: (m: Mode) => void;
  busy: boolean;
  message: { tone: "good" | "bad"; text: string } | null;
  draft: { title: string; description: string; alt_text: string };
  setDraft: (f: (d: { title: string; description: string; alt_text: string }) => { title: string; description: string; alt_text: string }) => void;
  reason: string;
  setReason: (v: string) => void;
  reasonRef: React.RefObject<HTMLInputElement | null>;
  act: (a: Action, extra?: Record<string, unknown>) => Promise<void>;
  startEdit: () => void;
}) {
  const approvable = canApprove(pin);
  const ft = feedTitle(pin.title);
  const blocking = pin.precheck?.blocking ?? [];
  const warnings = pin.precheck?.warnings ?? [];
  const rtl = ["ar", "ur", "ms-arab"].includes(pin.language);
  const editProblems = mode === "edit" ? copyProblems(draft) : [];
  const BTN = "btn-ghost h-9 px-3 text-sm disabled:opacity-50";

  return (
    <div className="space-y-4">
      <div className="flex gap-4">
        <div className="aspect-[2/3] w-[150px] shrink-0 overflow-hidden rounded-xl border border-[#E3E6E0] bg-[#F4F5F2]">
          {pin.imageUrls[0] ? (
            <a href={pin.imageUrls[0]} target="_blank" rel="noopener noreferrer" title="Open the full-size card">
              {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URL, sized by its box */}
              <img src={pin.imageUrls[0]} alt={pin.alt_text ?? ""} className="h-full w-full object-cover" />
            </a>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-[#9A6400]">Image missing</div>
          )}
        </div>
        <div className="min-w-0 space-y-2">
          <PinStatusChip status={pin.status} />
          <div className="flex flex-wrap gap-1 text-xs">
            <span className="chip bg-[#EEF0EC] text-[#5B6470]">{languageName(pin.language)}</span>
            <span className="chip bg-[#EEF0EC] text-[#5B6470]">{pin.template}</span>
            {pin.ai_modified ? <span className="chip bg-[#FFF1D6] text-[#9A6400]" title="Declared to Pinterest as AI-modified (decision D4)">AI-modified</span> : null}
            {pin.edited ? <span className="chip bg-[#E8F0FE] text-[#1F4FB8]">edited</span> : null}
          </div>
          <p className="text-xs text-[#5B6470]">{pin.topicTitle ?? ""}</p>
          {pin.imageUrls[0] ? <p className="text-xs text-[#98A0A9]">Click the card to open it full size.</p> : null}
        </div>
      </div>

      {pin.status === "rejected" && pin.reject_reason ? (
        <p className="text-sm rounded-lg bg-[#FFF1F0] text-[#B42318] px-3 py-2">Rejected: {pin.reject_reason}</p>
      ) : null}
      {pin.status === "failed" && pin.last_error ? (
        <p className="text-sm rounded-lg bg-[#FFF1F0] text-[#B42318] px-3 py-2">Failed: {pin.last_error}</p>
      ) : null}

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
            <button type="button" onClick={() => setMode("view")} className={BTN}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-[#5B6470]">Title · first 40 characters show in feeds</p>
            <p className="font-medium break-words" dir={rtl ? "rtl" : undefined}>
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

      <div className="rounded-lg border border-[#E3E6E0] px-3 py-2 text-sm">
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
            className="field h-9 px-3 flex-1 min-w-[200px]"
          />
          <button type="submit" disabled={busy || !reason.trim()} className={`${BTN} text-[#B42318]`}>Reject</button>
          <button type="button" onClick={() => setMode("view")} className={BTN}>Cancel</button>
        </form>
      ) : null}

      {canAct && mode === "view" ? (
        <div className="flex flex-wrap gap-2">
          {pin.status === "in_review" ? (
            <>
              <button
                type="button"
                disabled={busy || !approvable.ok}
                title={approvable.ok ? "Approve this one pin (A)" : approvable.why}
                onClick={() => void act("approve")}
                className="btn-primary h-9 px-4 text-sm disabled:opacity-50"
              >
                Approve
              </button>
              <button type="button" disabled={busy} onClick={startEdit} className={BTN}>Edit</button>
              <button type="button" disabled={busy} onClick={() => setMode("reject")} className={BTN}>Reject</button>
            </>
          ) : null}
          {pin.status === "approved" ? (
            <>
              <button type="button" disabled={busy || !canUnapprove(pin).ok} onClick={() => void act("unapprove")} className={BTN} title="Send it back to review (U)">
                Undo approval
              </button>
              <button type="button" disabled={busy} onClick={startEdit} className={BTN}>Edit</button>
              <button type="button" disabled={busy} onClick={() => setMode("reject")} className={BTN}>Reject</button>
            </>
          ) : null}
          {canRerender(pin).ok ? (
            <button type="button" disabled={busy} onClick={() => void act("rerender")} className={BTN} title="Send back to the worker for a fresh card and prechecks">
              Re-render
            </button>
          ) : null}
        </div>
      ) : null}
      {canAct && mode === "view" && pin.status === "in_review" && !approvable.ok ? <p className="text-xs text-[#9A6400]">{approvable.why}</p> : null}
      {!canAct ? <p className="text-xs text-[#9A6400] bg-[#FFF9EE] rounded-lg px-3 py-2">Read-only for your role: approving pins is for platform admins.</p> : null}
    </div>
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
