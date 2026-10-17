"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { TopicKit } from "@/utils/catalogue/types";
import { inboxHref, type InboxParams } from "@/utils/catalogue/review-queue";
import { KitReviewBox, useKitPost } from "./kit-panel";
import { TranslationReviewBox } from "./translations-panel";

// The review inbox's interactive bits (layout D, 2026-10-17). The page
// (review-inbox-view.tsx, a Server Component) lays the two panes out and
// renders the queue, the video and the status line itself; these components
// hold the browser state it cannot: the drawers' open/closed, the reviewer's
// verdict box with its busy / error / notice surface, the left pane's width,
// the j / k keys, and the filter form that navigates on change.

/** A button that opens a drawer from the right edge with `children` inside —
 *  the article, the pre-check findings, the history, the topic's details:
 *  things that are read, not scanned. The drawer is a sheet over the page:
 *  Escape or the backdrop closes it; the page's state (and the panels
 *  inside, which keep their own) survives a router.refresh. */
export function Drawer({ label, title, children, wide = true }: { label: ReactNode; title: string; children: ReactNode; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-ghost h-9 px-3 text-sm inline-flex items-center gap-2" aria-haspopup="dialog" aria-expanded={open}>
        {label}
      </button>
      {open && (
        <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={title}>
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="absolute inset-0 bg-[#14181F]/40" />
          <div className={`absolute inset-y-0 right-0 w-full ${wide ? "max-w-4xl" : "max-w-2xl"} bg-[#FBFCFA] shadow-2xl flex flex-col`}>
            <div className="flex items-center justify-between gap-3 px-5 h-14 border-b border-[#EEF0EC] bg-white shrink-0">
              <p className="font-medium">{title}</p>
              <button type="button" onClick={() => setOpen(false)} className="btn-ghost h-8 px-3 text-xs">
                Close
              </button>
            </div>
            <div className="overflow-y-auto p-5 grow">{children}</div>
          </div>
        </div>
      )}
    </>
  );
}

/** The reviewer's verdict on the kit under review — the English kit's
 *  Approve video / Reject, or a translation's Approve translation / Reject —
 *  posting the kit route's actions exactly as the folded panels do, with the
 *  same busy / error / notice surface (useKitPost). */
export function ReviewVerdict({
  topicId,
  topicStatus,
  kit,
  translation,
  kitArticleStatus,
  canApprove,
}: {
  topicId: string;
  topicStatus: string;
  kit: TopicKit;
  /** the kit is a translation (reviewed through its own acceptance rules) */
  translation: boolean;
  /** the status of the English kit's article version (null when it is gone) */
  kitArticleStatus: string | null;
  canApprove: boolean;
}) {
  const { post, busy, error, errors, notice, setNotice } = useKitPost(topicId);
  return (
    <div className="space-y-2">
      {translation ? (
        <TranslationReviewBox kit={kit} topicStatus={topicStatus} canApprove={canApprove} post={post} busy={busy} setNotice={setNotice} />
      ) : (
        <KitReviewBox kit={kit} topicStatus={topicStatus} kitArticleStatus={kitArticleStatus} canApprove={canApprove} busy={busy} post={post} setNotice={setNotice} />
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {errors.length > 1 && (
        <ul className="text-xs text-red-600 list-disc pl-5 space-y-0.5">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {notice && <p className="text-sm text-[#0F7A68]">{notice}</p>}
    </div>
  );
}

// ── The two panes, with a draggable divider ──────────────────────────────────

const ASIDE_KEY = "library.inbox.aside";
const ASIDE_DEFAULT = 304;
const ASIDE_MIN = 240;
const ASIDE_MAX = 640;
const clampAside = (n: number) => Math.min(ASIDE_MAX, Math.max(ASIDE_MIN, Math.round(n)));

/** The grid: the queue on the left at a width the reviewer drags (the
 *  divider; double-click resets), remembered in this browser; the topic on
 *  the right. Below lg the panes stack and the width does not apply. The
 *  width is a CSS variable written straight onto the grid (no React state):
 *  the server renders the default, the saved width is applied after mount,
 *  and a drag never re-renders the page under the player. */
export function InboxPanes({ aside, children }: { aside: ReactNode; children: ReactNode }) {
  const grid = useRef<HTMLDivElement>(null);
  const apply = (n: number) => grid.current?.style.setProperty("--aside", `${n}px`);
  const current = () => {
    const v = Number.parseInt(grid.current?.style.getPropertyValue("--aside") ?? "", 10);
    return Number.isFinite(v) ? v : ASIDE_DEFAULT;
  };
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(ASIDE_KEY));
      if (saved >= ASIDE_MIN && saved <= ASIDE_MAX) apply(saved);
    } catch {
      /* private window, blocked storage: the default width */
    }
  }, []);
  const remember = (n: number) => {
    try {
      localStorage.setItem(ASIDE_KEY, String(n));
    } catch {
      /* ignore */
    }
  };
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = current();
    const move = (ev: PointerEvent) => apply(clampAside(startW + ev.clientX - startX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      remember(current());
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div ref={grid} className="grid gap-5 lg:grid-cols-[var(--aside)_minmax(0,1fr)]" style={{ "--aside": `${ASIDE_DEFAULT}px` } as CSSProperties}>
      <aside className="relative lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] card flex flex-col min-h-0">
        {aside}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the queue"
          title="Drag to widen or narrow the queue · double-click to reset"
          onPointerDown={startDrag}
          onDoubleClick={() => {
            apply(ASIDE_DEFAULT);
            remember(ASIDE_DEFAULT);
          }}
          className="hidden lg:block absolute top-0 -right-3.5 h-full w-3 cursor-col-resize group"
        >
          <div className="mx-auto h-full w-px bg-transparent group-hover:bg-[#9DB3A9] group-active:bg-[#1F7A5A]" />
        </div>
      </aside>
      <section className="min-w-0 space-y-4">{children}</section>
    </div>
  );
}

// ── j / k: the next and previous row of the left pane ───────────────────────

/** Keyboard shortcuts for moving through the pane's list: j (or ]) opens
 *  the next row, k (or [) the previous — never while typing in a field. */
export function QueueKeys({ prevHref, nextHref }: { prevHref: string | null; nextHref: string | null }) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if ((e.key === "j" || e.key === "]") && nextHref) {
        e.preventDefault();
        router.push(nextHref);
      } else if ((e.key === "k" || e.key === "[") && prevHref) {
        e.preventDefault();
        router.push(prevHref);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, prevHref, nextHref]);
  return null;
}

// ── The left pane's filters ─────────────────────────────────────────────────

/** Subject (both modes), kit language (the queue) or topic status (all
 *  topics), and the search (all topics). Every change navigates at once —
 *  the filters live in the URL (inboxHref), so the next row keeps them. */
export function InboxFilters({
  topicId,
  view,
  subjects,
  languages,
  statuses,
}: {
  topicId: string;
  view: InboxParams;
  subjects: string[];
  /** the kit languages present in the queue, for the queue's filter */
  languages: { value: string; label: string }[];
  statuses: readonly string[];
}) {
  const router = useRouter();
  const [q, setQ] = useState(view.q);
  const go = (patch: Partial<InboxParams>) => router.push(inboxHref(topicId, { ...view, ...patch }));
  const select = "field h-8 px-2 text-xs min-w-0";
  return (
    <div className="mt-2 space-y-1.5">
      {view.queue === "all" && (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            go({ q });
          }}
        >
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, key, summary…" className="field h-8 px-2 text-xs flex-1 min-w-0" aria-label="Search topics" />
          <button type="submit" className="btn-ghost h-8 px-2 text-xs">
            Go
          </button>
        </form>
      )}
      <div className="grid grid-cols-2 gap-1">
        <select value={view.subject} onChange={(e) => go({ subject: e.target.value })} className={select} aria-label="Subject">
          <option value="">Any subject</option>
          {subjects.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {view.queue === "all" ? (
          <select value={view.status} onChange={(e) => go({ status: e.target.value })} className={select} aria-label="Topic status">
            <option value="">Any status</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        ) : (
          <select value={view.language} onChange={(e) => go({ language: e.target.value })} className={select} aria-label="Kit language">
            <option value="">Any language</option>
            {languages.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        )}
      </div>
      {(view.subject || view.status || view.language || view.q) && (
        <button type="button" onClick={() => go({ subject: "", status: "", language: "", q: "" })} className="text-xs text-[#1F5B99] hover:underline">
          Clear filters
        </button>
      )}
    </div>
  );
}
