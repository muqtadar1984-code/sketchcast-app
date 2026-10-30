"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Stage, StageAction, WorkChapter } from "@/utils/books/workbench";

// The left column: six stages as a thin spine, the chapters as a strip of numbered tiles, one action per stage.
const ICON: Record<Stage["key"], string> = { ready: "✓", chapters: "", book: "", audit: "", final: "", publish: "" };
const NAME: Record<Stage["key"], string> = { ready: "Ready", chapters: "Chapters", book: "Book", audit: "Audit", final: "Final", publish: "Publish" };
const BAR: Record<Stage["state"], string> = { done: "bg-[#2F8F5B]", ready: "bg-[#B8862F]", running: "bg-[#3B6FD8] animate-pulse", waiting: "bg-[#E4DCC8]" };
const TILE: Record<WorkChapter["state"], string> = {
  approved: "bg-[#E3EEE5] text-[#24543A]",
  ready: "bg-[#FBEBD5] text-[#8A4B10]",
  drafting: "bg-[#E2E8F3] text-[#28406B] animate-pulse",
  not_drafted: "border border-dashed border-[#D8D3C6] text-[#A39C8C]",
};

export default function Spine(props: {
  slug: string;
  title: string;
  stages: Stage[];
  chapters: WorkChapter[];
  active: number | "book" | "front" | null;
  canRun: boolean;
  canApprove: boolean;
  isOwner: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(a: StageAction) {
    if (a.kind === "view") return router.push(`/books/${props.slug}?view=book`);
    const label = a.kind === "gate_e" ? "Final approval" : a.label;
    const cost = a.kind === "run" && a.usd ? ` It costs about $${a.usd.toFixed(2)}.` : "";
    if (!confirm(`${label}?${cost}`)) return;
    setBusy(label);
    setError(null);
    const r =
      a.kind === "gate_e"
        ? await fetch("/api/pub/gate-e", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ book: props.slug, run: a.run }) })
        : await fetch("/api/pub/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ book: props.slug, stage: a.stage, params: a.params }) });
    const b = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(null);
    if (!r.ok) return setError(b.error ?? `Not started (${r.status}).`);
    router.refresh();
  }

  function allowed(a: StageAction): boolean {
    if (a.kind === "view") return true;
    if (a.kind === "gate_e") return props.canApprove;
    return a.stage === "release" ? props.canApprove : props.canRun;
  }

  return (
    <nav className="space-y-1.5 text-sm" aria-label="Book stages">
      <Link href="/books" className="text-xs text-[#7A7363] hover:text-[#1F2A24]">← Books</Link>
      <p className="font-display text-[15px] leading-snug pb-2">{props.title}</p>
      {props.stages.map((s) => (
        <div key={s.key} className="flex gap-2.5">
          <span className={`w-1.5 shrink-0 rounded-full ${BAR[s.state]} ${s.key === "chapters" ? "" : "h-8"}`} aria-hidden="true" />
          <div className="min-w-0 flex-1 py-1">
            <div className="flex items-center justify-between gap-2">
              <span className={s.state === "waiting" ? "text-[#A39C8C]" : "text-[#1F2A24]"}>
                {s.key === "ready" && s.state === "done" ? `${ICON.ready} ` : ""}
                {NAME[s.key]}
              </span>
              {s.value && <span className="text-xs tabular-nums text-[#7A7363]">{s.value}</span>}
              {s.state === "running" && <span className="text-xs text-[#3B6FD8]">running</span>}
            </div>
            {s.key === "chapters" && props.chapters.length > 0 && (
              <div className="mt-1.5 grid grid-cols-5 gap-1">
                {props.chapters.map((c) => (
                  <Link
                    key={c.chapter}
                    href={`/books/${props.slug}?ch=${c.chapter}`}
                    title={c.title}
                    aria-current={props.active === c.chapter ? "page" : undefined}
                    className={`flex aspect-square items-center justify-center rounded text-[11px] tabular-nums ${TILE[c.state]} ${props.active === c.chapter ? "ring-2 ring-[#3B6FD8] ring-offset-1" : ""}`}
                  >
                    {c.chapter}
                  </Link>
                ))}
              </div>
            )}
            {s.action && allowed(s.action) && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => act(s.action!)}
                className={`mt-1.5 rounded-md border px-2 py-0.5 text-xs ${s.key === "book" && props.active === "book" ? "border-[#3B6FD8] text-[#3B6FD8]" : "border-[#D8D3C6] text-[#5F5A4E] hover:border-[#B8862F]"}`}
              >
                {s.action.kind === "view" ? "Read" : s.action.kind === "gate_e" ? "Approve book" : s.action.label}
                {s.action.kind === "run" && s.action.usd ? ` · $${s.action.usd.toFixed(2)}` : ""}
              </button>
            )}
            {s.key === "book" && (
              <Link
                href={`/books/${props.slug}?view=front`}
                aria-current={props.active === "front" ? "page" : undefined}
                className={`ml-1 mt-1.5 inline-block rounded-md border px-2 py-0.5 text-xs ${props.active === "front" ? "border-[#3B6FD8] text-[#3B6FD8]" : "border-[#D8D3C6] text-[#5F5A4E] hover:border-[#B8862F]"}`}
              >
                Front matter
              </Link>
            )}
          </div>
        </div>
      ))}
      {error && <p className="text-xs text-[#8E2A21]">{error}</p>}
      {props.isOwner && (
        <Link href={`/books/${props.slug}/records`} className="block pt-3 text-xs text-[#A39C8C] hover:text-[#1F2A24]">
          Records
        </Link>
      )}
    </nav>
  );
}
