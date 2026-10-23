"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SideDrawer } from "@/components/side-drawer";
import { DECISION_NOTE_MAX } from "@/utils/fixes/fix-cases";
import {
  STATUS_FILTERS,
  boardQuery,
  facetCounts,
  filterCases,
  groupBadge,
  groupByCause,
  shortStatus,
  statusTone,
  type BoardParams,
  type BoardRow,
  type CaseGroup,
  type StatusFilter,
} from "@/utils/fixes/fix-board";
import { postFixes } from "./fix-actions";

// Library → Fixes' board: the filters (in the URL), the cases grouped by
// cause or as one list, the selection bar, the case drawer and review mode.
// Every row arrives as plain data (utils/fixes/fix-board.ts builds it on the
// server) with its full detail beside it as a server-rendered ReactNode
// (fixes-view.tsx's CaseDetail) — this module renders it, never builds it.
// The route decides everything (/api/library/fixes): a button that loses a
// race is a 409 or a "skipped", never an overwrite.

export type BoardItem = BoardRow & { detail: ReactNode };

type DrawerState = { mode: "case"; id: string } | { mode: "review"; ids: string[] } | null;
type Body = Record<string, unknown>;
type Done = (data: Record<string, unknown>) => void;

const PATH = "/library/fixes";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const CONFIRM_APPROVE = (n: number) =>
  `Approve ${plural(n, "fix", "fixes")}? Each is retried when the translation lane is free — one at a time, oldest first, never while a user's job is running.`;
const CONFIRM_RETRY = (n: number) =>
  `Retry ${plural(n, "case")} that needed you? Each goes back to the agent with its last proposal and is translated again, one at a time.`;
const CONFIRM_REJECT = (n: number) => `Reject ${plural(n, "fix", "fixes")}? The agent does not retry a rejected case.`;

const BULK_DONE: Record<string, string> = { approve_many: "Approved", reject_many: "Rejected", retry_many: "Sent back to the agent" };

function bulkNotice(action: string, data: Record<string, unknown>): string {
  const done = typeof data.done === "number" ? data.done : 0;
  const skipped = typeof data.skipped === "number" ? data.skipped : 0;
  return `${BULK_DONE[action] ?? "Done"}: ${done}${skipped ? ` · ${skipped} skipped (no longer waiting)` : ""}.`;
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/** One POST to the route, then a refresh of the server page. Busy until the
 *  refreshed page lands (the transition), so the button does not flash back. */
function ActButton({
  body,
  label,
  busyLabel,
  primary = true,
  disabled = false,
  confirm,
  onDone,
  title,
}: {
  body: Body;
  label: string;
  busyLabel: string;
  primary?: boolean;
  disabled?: boolean;
  confirm?: string;
  onDone?: Done;
  title?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const press = async () => {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setError(null);
    const r = await postFixes(body);
    setBusy(false);
    if (r.error) {
      setError(r.error);
      return;
    }
    onDone?.(r.data);
    startTransition(() => router.refresh());
  };
  const working = busy || pending;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" title={title} disabled={disabled || working} onClick={press} className={`${primary ? "btn-primary" : "btn-ghost"} h-8 px-3 text-sm whitespace-nowrap`}>
        {working ? busyLabel : label}
      </button>
      {error && <span className="text-xs text-[#B3401F]">{error}</span>}
    </span>
  );
}

// ── the filters ─────────────────────────────────────────────────────────────

type ChipOption = { value: string; label: string; count: number; title?: string };

function ChipRow({ label, options, value, onPick }: { label: string; options: ChipOption[]; value: string; onPick: (v: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <span className="text-xs text-[#5B6470] w-20 shrink-0">{label}</span>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value || "any"}
            type="button"
            title={o.title}
            aria-pressed={on}
            onClick={() => onPick(o.value)}
            className={`chip ${on ? "bg-[#14241E] text-white" : "bg-[#F4F5F2] text-[#5B6470] hover:bg-[#EEF0EC]"}`}
          >
            {o.label} <span className="tabular opacity-70">{o.count}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── a row and its action ────────────────────────────────────────────────────

function RowAction({ r, canDecide }: { r: BoardItem; canDecide: boolean }) {
  if (r.status === "proposed" && canDecide) return <ActButton body={{ action: "approve", id: r.id }} label="Approve" busyLabel="Approving…" />;
  if (r.status === "needs_founder" && canDecide) return <ActButton body={{ action: "retry", id: r.id }} label="Retry" busyLabel="Retrying…" />;
  if (r.status === "approved") return r.queue ? <span className="text-xs text-[#1F5FA8] tabular whitespace-nowrap">{r.queue}</span> : null;
  if (r.status === "applied") {
    const pct = r.progress?.pct ?? 0;
    return (
      <span className="inline-flex flex-col gap-1 w-36">
        <span className="text-xs text-[#1F5FA8] tabular truncate">{r.progress?.text ?? "starting"}</span>
        <span className="block h-1 rounded-full bg-[#E3EEFB]" aria-hidden>
          <span className="block h-1 rounded-full bg-[#1F5FA8]" style={{ width: `${pct}%` }} />
        </span>
      </span>
    );
  }
  if (r.status === "resolved" && r.topicId) {
    return (
      <Link href={`/library/topics/${r.topicId}`} className="text-xs underline text-[#1F5FA8] whitespace-nowrap">
        Open in review inbox
      </Link>
    );
  }
  return null;
}

function Row({
  r,
  checked,
  onCheck,
  onOpen,
  canDecide,
  showCause,
}: {
  r: BoardItem;
  checked: boolean;
  onCheck: (id: string, on: boolean) => void;
  onOpen: (id: string) => void;
  canDecide: boolean;
  showCause: boolean;
}) {
  const name = r.topicTitle ?? r.title;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 border-t border-[#EEF0EC] first:border-t-0 hover:bg-[#F7F8F5] cursor-pointer"
      onClick={(e) => {
        // the row opens the case; its own controls do their own thing
        if ((e.target as HTMLElement).closest("button, a, input, label, textarea, select")) return;
        onOpen(r.id);
      }}
    >
      <input type="checkbox" className="h-4 w-4 shrink-0" checked={checked} onChange={(e) => onCheck(r.id, e.target.checked)} aria-label={`Select ${name}`} />
      <button type="button" onClick={() => onOpen(r.id)} title={r.title} className="text-left text-sm font-medium hover:underline flex-1 min-w-[12rem] truncate">
        {name}
      </button>
      {r.language && <span className="chip bg-[#E3EEFB] text-[#1F5FA8]">{r.language}</span>}
      {showCause && <span className="chip bg-[#EEF0EC] text-[#14241E]">{r.cause.label}</span>}
      <span className={`chip ${statusTone(r.status)}`}>{shortStatus(r.status)}</span>
      {r.badge && <span className="chip bg-[#E6F6F2] text-[#0F7A68]">{r.badge}</span>}
      <RowAction r={r} canDecide={canDecide} />
    </div>
  );
}

function GroupBlock({
  g,
  selected,
  onCheck,
  onCheckAll,
  onOpen,
  canDecide,
  onNotice,
}: {
  g: CaseGroup<BoardItem>;
  selected: ReadonlySet<string>;
  onCheck: (id: string, on: boolean) => void;
  onCheckAll: (ids: string[], on: boolean) => void;
  onOpen: (id: string) => void;
  canDecide: boolean;
  onNotice: (action: string) => Done;
}) {
  const badge = groupBadge(g.rows);
  const ids = g.rows.map((r) => r.id);
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  const waitingIds = g.rows.filter((r) => r.status === "proposed").map((r) => r.id);
  const needsIds = g.rows.filter((r) => r.status === "needs_founder").map((r) => r.id);
  return (
    <section className="card overflow-hidden" aria-label={g.label}>
      <header className="flex flex-wrap items-center gap-2 px-4 py-2.5 bg-[#F4F5F2] border-b border-[#EEF0EC]">
        <input type="checkbox" className="h-4 w-4" checked={all} onChange={(e) => onCheckAll(ids, e.target.checked)} aria-label={`Select every case in ${g.label}`} />
        <h2 className="text-sm font-medium">{g.label}</h2>
        <span className="text-xs text-[#5B6470] tabular">{g.rows.length}</span>
        {badge && <span className="chip bg-[#E6F6F2] text-[#0F7A68]">{badge}</span>}
        <span className="flex-1" />
        {canDecide && waitingIds.length > 0 ? (
          <ActButton
            body={{ action: "approve_many", ids: waitingIds }}
            label={`Approve all ${waitingIds.length}`}
            busyLabel="Approving…"
            confirm={CONFIRM_APPROVE(waitingIds.length)}
            onDone={onNotice("approve_many")}
          />
        ) : canDecide && needsIds.length > 0 ? (
          <ActButton
            body={{ action: "retry_many", ids: needsIds }}
            label={`Retry all ${needsIds.length}`}
            busyLabel="Retrying…"
            confirm={CONFIRM_RETRY(needsIds.length)}
            onDone={onNotice("retry_many")}
          />
        ) : null}
      </header>
      {g.rows.map((r) => (
        <Row key={r.id} r={r} checked={selected.has(r.id)} onCheck={onCheck} onOpen={onOpen} canDecide={canDecide} showCause={false} />
      ))}
    </section>
  );
}

// ── review mode ─────────────────────────────────────────────────────────────

/** The waiting cases one after another in the drawer: A approves, R rejects
 *  (an optional note inline; Enter submits), J / K move, Esc closes. A
 *  decision moves on to the next undecided case; after the last one the
 *  drawer closes and the page refreshes. Keys are ignored while typing. */
function ReviewDrawer({ ids, byId, onClose }: { ids: string[]; byId: Map<string, BoardItem>; onClose: () => void }) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [decided, setDecided] = useState<Record<string, "approved" | "rejected">>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null); // non-null while rejecting
  const noteRef = useRef<HTMLInputElement>(null);
  const noteOpen = note !== null;
  useEffect(() => {
    // R opens the note to type into at once
    if (noteOpen) noteRef.current?.focus();
  }, [noteOpen]);

  const id = ids[index];
  const item = byId.get(id);
  const verdict = decided[id];
  const canAct = !!item && !verdict && item.status === "proposed" && !busy;
  const anyDecided = Object.keys(decided).length > 0;

  const close = useCallback(() => {
    onClose();
    if (anyDecided) router.refresh();
  }, [onClose, anyDecided, router]);

  const go = (delta: number) => {
    setIndex((i) => Math.min(ids.length - 1, Math.max(0, i + delta)));
    setNote(null);
    setError(null);
  };

  const decide = async (action: "approve" | "reject") => {
    if (!canAct) return;
    setBusy(true);
    setError(null);
    const r = await postFixes({ action, id, ...(action === "reject" && note?.trim() ? { note: note.trim() } : {}) });
    setBusy(false);
    if (r.error) {
      setError(r.error);
      return;
    }
    const next = { ...decided, [id]: action === "approve" ? ("approved" as const) : ("rejected" as const) };
    setDecided(next);
    setNote(null);
    // the next case still waiting: after this one, then from the top
    const order = [...ids.slice(index + 1).map((_, k) => index + 1 + k), ...ids.slice(0, index).map((_, k) => k)];
    const nextIndex = order.find((i) => !next[ids[i]] && byId.get(ids[i])?.status === "proposed");
    if (nextIndex === undefined) {
      onClose();
      router.refresh();
    } else {
      setIndex(nextIndex);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "a") {
        e.preventDefault();
        void decide("approve");
      } else if (k === "r") {
        e.preventDefault();
        if (canAct) setNote("");
      } else if (k === "j") {
        e.preventDefault();
        go(1);
      } else if (k === "k") {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const kbd = "ml-1.5 rounded border border-[#DDE1DA] px-1 text-[10px] font-mono opacity-80";
  const bar = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-[#5B6470] tabular">
          {index + 1} of {ids.length}
        </span>
        {verdict && <span className={`chip ${statusTone(verdict)}`}>{verdict === "approved" ? "Approved" : "Rejected"}</span>}
        {item && !verdict && item.status !== "proposed" && <span className={`chip ${statusTone(item.status)}`}>{shortStatus(item.status)} — no longer waiting</span>}
        <span className="flex-1" />
        <button type="button" className="btn-primary h-8 px-3 text-sm" disabled={!canAct} onClick={() => void decide("approve")}>
          {busy && note === null ? "Approving…" : "Approve"}
          <kbd className={kbd}>A</kbd>
        </button>
        <button type="button" className="btn-ghost h-8 px-3 text-sm" disabled={!canAct} onClick={() => setNote("")}>
          Reject<kbd className={kbd}>R</kbd>
        </button>
        <button type="button" className="btn-ghost h-8 px-3 text-sm" disabled={index === 0} onClick={() => go(-1)}>
          Previous<kbd className={kbd}>K</kbd>
        </button>
        <button type="button" className="btn-ghost h-8 px-3 text-sm" disabled={index >= ids.length - 1} onClick={() => go(1)}>
          Next<kbd className={kbd}>J</kbd>
        </button>
      </div>
      {note !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={noteRef}
            className="field h-9 px-2 text-sm flex-1 min-w-[14rem]"
            placeholder="Why not? (optional) — Enter rejects, Esc cancels"
            aria-label="Why reject this fix (optional)"
            maxLength={DECISION_NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void decide("reject");
              } else if (e.key === "Escape") {
                // cancel the note, keep the drawer open
                e.preventDefault();
                e.stopPropagation();
                setNote(null);
              }
            }}
          />
          <button type="button" className="btn-primary h-9 px-3 text-sm" disabled={!canAct} onClick={() => void decide("reject")}>
            {busy ? "Rejecting…" : "Reject this fix"}
          </button>
          <button type="button" className="btn-ghost h-9 px-3 text-sm" disabled={busy} onClick={() => setNote(null)}>
            Cancel
          </button>
        </div>
      )}
      {error && <p className="text-xs text-[#B3401F]">{error}</p>}
    </div>
  );

  return (
    <SideDrawer open onClose={close} title={item ? `Review — ${item.topicTitle ?? item.title}` : "Review"} bar={bar}>
      {/* review mode decides with its own keyed buttons: the card's Approve /
          Reject would be a second, unkeyed copy of the same action */}
      <div className="[&_[data-fix-decision]]:hidden">
        {item ? item.detail : <p className="text-sm text-[#5B6470]">This case is no longer on the page.</p>}
      </div>
    </SideDrawer>
  );
}

// ── the board ───────────────────────────────────────────────────────────────

export function FixesBoard({ items, initial, canDecide }: { items: BoardItem[]; initial: BoardParams; canDecide: boolean }) {
  const [params, setParams] = useState<BoardParams>(initial);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [rejectNote, setRejectNote] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const urlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (urlTimer.current) clearTimeout(urlTimer.current);
    },
    [],
  );

  /** A filter or the view changed: the state now, the URL after a beat for
   *  the search box. The board filters on the client, so the URL is written
   *  with history.replaceState (Next keeps the router in sync) — router.replace
   *  would re-run the force-dynamic page's loader on every chip. A filter
   *  change clears the selection, so a bulk press only acts on rows in view. */
  const update = (patch: Partial<BoardParams>) => {
    const next = { ...params, ...patch };
    setParams(next);
    if ("status" in patch || "cause" in patch || "lang" in patch || "q" in patch) {
      setSelected(new Set());
      setRejectNote(null);
    }
    if (urlTimer.current) clearTimeout(urlTimer.current);
    urlTimer.current = setTimeout(() => window.history.replaceState(null, "", `${PATH}${boardQuery(next)}`), "q" in patch ? 400 : 0);
  };

  const byId = useMemo(() => new Map(items.map((r) => [r.id, r])), [items]);
  const filtered = useMemo(() => filterCases(items, params), [items, params]);
  const counts = useMemo(() => facetCounts(items, params), [items, params]);
  const groups = useMemo(() => groupByCause(filtered), [filtered]);
  const waiting = filtered.filter((r) => r.status === "proposed");

  const chosen = items.filter((r) => selected.has(r.id));
  const approvable = chosen.filter((r) => r.status === "proposed").map((r) => r.id);
  const retryable = chosen.filter((r) => r.status === "needs_founder").map((r) => r.id);

  const onCheck = (id: string, on: boolean) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const onCheckAll = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const n = new Set(prev);
      for (const id of ids) {
        if (on) n.add(id);
        else n.delete(id);
      }
      return n;
    });
  const onOpen = (id: string) => setDrawer({ mode: "case", id });
  const closeDrawer = useCallback(() => setDrawer(null), []);
  const onNotice = (action: string): Done => (data) => setNotice(bulkNotice(action, data));
  const onBulkDone = (action: string): Done => (data) => {
    setNotice(bulkNotice(action, data));
    setSelected(new Set());
    setRejectNote(null);
  };

  const statusOptions: ChipOption[] = STATUS_FILTERS.map((s) => ({ value: s.key, label: s.label, count: counts.status[s.key] }));
  const causeOptions: ChipOption[] = [
    { value: "", label: "Any", count: counts.causeTotal },
    ...counts.causes.map((c) => ({ value: c.key, label: c.label, count: c.count })),
  ];
  if (params.cause && !counts.causes.some((c) => c.key === params.cause)) {
    const label = items.find((r) => r.cause.key === params.cause)?.cause.label ?? params.cause;
    causeOptions.push({ value: params.cause, label, count: 0 });
  }
  const langOptions: ChipOption[] = [{ value: "", label: "Any", count: counts.langTotal }, ...counts.langs.map((l) => ({ value: l.code, label: l.code, count: l.count }))];
  if (params.lang && !counts.langs.some((l) => l.code === params.lang)) langOptions.push({ value: params.lang, label: params.lang, count: 0 });

  const caseItem = drawer?.mode === "case" ? byId.get(drawer.id) : undefined;
  const viewBtn = (v: BoardParams["view"], label: string) => (
    <button
      type="button"
      aria-pressed={params.view === v}
      onClick={() => update({ view: v })}
      className={`h-9 px-3 text-sm ${params.view === v ? "bg-[#14241E] text-white" : "bg-white text-[#5B6470] hover:bg-[#F4F5F2]"}`}
    >
      {label}
    </button>
  );

  return (
    <div>
      <section className="card p-4 mb-4 space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            className="field h-9 px-3 text-sm flex-1 min-w-[12rem]"
            placeholder="Search topics…"
            aria-label="Search topics"
            maxLength={100}
            value={params.q}
            onChange={(e) => update({ q: e.target.value })}
          />
          <div role="group" aria-label="View" className="inline-flex rounded-lg border border-[#DDE1DA] overflow-hidden">
            {viewBtn("grouped", "Grouped")}
            {viewBtn("list", "List")}
          </div>
          {canDecide && (
            <button
              type="button"
              className="btn-primary h-9 px-4 text-sm"
              disabled={!waiting.length}
              onClick={() => setDrawer({ mode: "review", ids: waiting.map((r) => r.id) })}
              title="A approve · R reject · J next · K previous · Esc close"
            >
              Review {waiting.length} waiting
            </button>
          )}
        </div>
        <ChipRow label="Status" options={statusOptions} value={params.status} onPick={(v) => update({ status: v as StatusFilter })} />
        {causeOptions.length > 1 && <ChipRow label="Cause" options={causeOptions} value={params.cause} onPick={(v) => update({ cause: v })} />}
        {langOptions.length > 2 || params.lang ? <ChipRow label="Language" options={langOptions} value={params.lang} onPick={(v) => update({ lang: v })} /> : null}
      </section>

      {notice && (
        <p className="text-sm text-[#0F7A68] mb-3 flex items-center gap-2">
          {notice}
          <button type="button" className="text-xs text-[#5B6470] underline" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}

      {filtered.length === 0 ? (
        <div className="card p-8 text-center text-[#5B6470] text-sm space-y-2">
          <p>No cases match these filters.</p>
          <button type="button" className="text-xs text-[#1F5B99] hover:underline" onClick={() => update({ status: "open", cause: "", lang: "", q: "" })}>
            Clear filters
          </button>
        </div>
      ) : params.view === "grouped" ? (
        <div className="space-y-4">
          {groups.map((g) => (
            <GroupBlock key={g.key} g={g} selected={selected} onCheck={onCheck} onCheckAll={onCheckAll} onOpen={onOpen} canDecide={canDecide} onNotice={onNotice} />
          ))}
        </div>
      ) : (
        <div className="card overflow-hidden">
          {filtered.map((r) => (
            <Row key={r.id} r={r} checked={selected.has(r.id)} onCheck={onCheck} onOpen={onOpen} canDecide={canDecide} showCause />
          ))}
        </div>
      )}

      {canDecide && chosen.length > 0 && (
        <div className="sticky bottom-4 z-10 mt-4 card shadow-lg px-4 py-2.5 flex flex-wrap items-center gap-2" role="region" aria-label="Selected cases">
          <span className="text-sm font-medium tabular">{chosen.length} selected</span>
          <ActButton
            body={{ action: "approve_many", ids: approvable }}
            label="Approve selected"
            busyLabel="Approving…"
            disabled={!approvable.length || rejectNote !== null}
            title={`${plural(approvable.length, "selected case")} waiting for you`}
            confirm={CONFIRM_APPROVE(approvable.length)}
            onDone={onBulkDone("approve_many")}
          />
          <ActButton
            body={{ action: "retry_many", ids: retryable }}
            label="Retry selected"
            busyLabel="Retrying…"
            primary={false}
            disabled={!retryable.length || rejectNote !== null}
            title={`${plural(retryable.length, "selected case")} that need you`}
            confirm={CONFIRM_RETRY(retryable.length)}
            onDone={onBulkDone("retry_many")}
          />
          {rejectNote === null ? (
            <button
              type="button"
              className="btn-ghost h-8 px-3 text-sm"
              disabled={!approvable.length}
              title={`${plural(approvable.length, "selected case")} waiting for you`}
              onClick={() => setRejectNote("")}
            >
              Reject selected
            </button>
          ) : (
            <>
              <input
                className="field h-8 px-2 text-sm min-w-[14rem] flex-1"
                placeholder="Why not? (optional)"
                aria-label="Why reject the selected fixes (optional)"
                maxLength={DECISION_NOTE_MAX}
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
              />
              <ActButton
                body={{ action: "reject_many", ids: approvable, ...(rejectNote.trim() ? { note: rejectNote.trim() } : {}) }}
                label={`Reject ${approvable.length}`}
                busyLabel="Rejecting…"
                disabled={!approvable.length}
                confirm={CONFIRM_REJECT(approvable.length)}
                onDone={onBulkDone("reject_many")}
              />
              <button type="button" className="btn-ghost h-8 px-3 text-sm" onClick={() => setRejectNote(null)}>
                Cancel
              </button>
            </>
          )}
          <span className="flex-1" />
          <button
            type="button"
            className="btn-ghost h-8 px-3 text-sm"
            onClick={() => {
              setSelected(new Set());
              setRejectNote(null);
            }}
          >
            Clear
          </button>
        </div>
      )}

      {drawer?.mode === "case" && (
        <SideDrawer open onClose={closeDrawer} title={caseItem ? (caseItem.topicTitle ?? caseItem.title) : "Case"}>
          {caseItem ? caseItem.detail : <p className="text-sm text-[#5B6470]">This case is no longer on the page.</p>}
        </SideDrawer>
      )}
      {drawer?.mode === "review" && <ReviewDrawer ids={drawer.ids} byId={byId} onClose={closeDrawer} />}
    </div>
  );
}
