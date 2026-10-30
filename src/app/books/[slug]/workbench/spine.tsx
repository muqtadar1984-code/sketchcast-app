"use client";

import Link from "next/link";
import type { Stage, StageAction } from "@/utils/books/workbench";
import ActionButton from "./action";

// The left column, direction C "Focus page" (founder 2026-10-30): six thin segments, top to bottom, each an icon
// rather than a word; the chapters segment fills with the approved share and shows "approved/total"; ONE button, the
// next step, beside the stage it belongs to. Chapters are chosen in the reader's header, not here.
const BAR: Record<Stage["state"], string> = { done: "#2F8F5B", ready: "#B8862F", running: "#3B6FD8", waiting: "#E4DCC8" };
const NAME: Record<Stage["key"], string> = { ready: "Ready to draft", chapters: "Chapters", book: "Whole book", audit: "Audit", final: "Final approval", publish: "Publish" };
const STATE: Record<Stage["state"], string> = { done: "done", ready: "to do", running: "running", waiting: "waiting" };

function Icon({ k }: { k: Stage["key"] }) {
  const p = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (k) {
    case "ready":
      return <svg {...p}><path d="M5 12l5 5L20 7" /></svg>;
    case "book":
      return <svg {...p}><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" /><path d="M4 19V5" /></svg>;
    case "audit":
      return <svg {...p}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.2-4.2" /><path d="M8.5 11l1.8 1.8L13.5 9.5" /></svg>;
    case "final":
      return <svg {...p}><circle cx="12" cy="9" r="5" /><path d="M9 13.5L7.5 21l4.5-2.5 4.5 2.5L15 13.5" /></svg>;
    case "publish":
      return <svg {...p}><path d="M4 10l1.5-5h13L20 10" /><path d="M5 10v9h14v-9" /><path d="M10 19v-5h4v5" /></svg>;
    default:
      return null;
  }
}

export default function Spine(props: {
  slug: string;
  title: string;
  stages: Stage[];
  next: Stage | undefined;
  approved: number;
  total: number;
  active: number | "book" | "front" | null;
  canRun: boolean;
  canApprove: boolean;
  isOwner: boolean;
}) {
  const allowed = (a: StageAction) => (a.kind === "gate_e" ? props.canApprove : a.kind === "run" && a.stage === "release" ? props.canApprove : props.canRun);
  return (
    <nav className="text-sm" aria-label="Book stages">
      <Link href="/books" className="text-xs text-[#7A7363] hover:text-[#1F2A24]">← Books</Link>
      <p className="mb-4 mt-1 font-display text-[15px] leading-snug">{props.title}</p>
      <ol className="space-y-1.5">
        {props.stages.map((s) => {
          const color = BAR[s.state];
          const fill = s.key === "chapters" && props.total ? Math.round((100 * props.approved) / props.total) : null;
          const label = `${NAME[s.key]}: ${s.value ? `${s.value}, ` : ""}${STATE[s.state]}`;
          const body =
            s.key === "chapters" ? (
              <span className={`text-xs font-medium tabular-nums ${s.state === "waiting" ? "text-[#A39C8C]" : "text-[#3B6FD8]"}`}>{s.value ?? "0"}</span>
            ) : (
              <span className={s.state === "done" ? "text-[#2F8F5B]" : s.state === "waiting" ? "text-[#C9C2B2]" : "text-[#5F5A4E]"}>
                <Icon k={s.key} />
              </span>
            );
          return (
            <li key={s.key} className="flex items-center gap-2.5" title={label}>
              <span
                className={`w-1.5 shrink-0 rounded-full ${s.key === "chapters" ? "h-12" : "h-7"} ${s.state === "running" ? "animate-pulse" : ""}`}
                style={{ background: fill !== null ? `linear-gradient(${BAR.done} 0 ${fill}%, ${s.state === "waiting" ? BAR.waiting : "#EFE8D8"} ${fill}%)` : color }}
                aria-hidden="true"
              />
              {s.key === "book" ? (
                <Link
                  href={`/books/${props.slug}?view=book`}
                  aria-label={label}
                  aria-current={props.active === "book" || props.active === "front" ? "page" : undefined}
                  className={`rounded p-0.5 ${props.active === "book" || props.active === "front" ? "text-[#3B6FD8]" : "hover:text-[#1F2A24]"}`}
                >
                  {body}
                </Link>
              ) : (
                <span aria-label={label}>{body}</span>
              )}
              {s.state === "running" && <span className="text-[11px] text-[#3B6FD8]">running</span>}
              {props.next?.key === s.key && props.next.action && <ActionButton slug={props.slug} action={props.next.action} allowed={allowed(props.next.action)} />}
            </li>
          );
        })}
      </ol>
      {props.isOwner && (
        <Link href={`/books/${props.slug}/records`} className="mt-6 flex items-center gap-1 text-xs text-[#A39C8C] hover:text-[#1F2A24]" title="Runs, logs, costs and files (owners only)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
          Records
        </Link>
      )}
    </nav>
  );
}
