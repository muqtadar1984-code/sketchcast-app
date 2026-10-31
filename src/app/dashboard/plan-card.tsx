"use client";

// One recommended plan (SK student Board plan 2026-10-31, phase 4): what SK
// proposes for a student and why, and — for the plan's APPROVER only — Approve
// (optionally for the whole class), Decline (with an optional note) and a
// simple text edit of the items before approving. Everyone else (a school
// student's parent, a co-teacher) sees the same card read-only.
//
// The decision goes to POST /api/learn/plan, which runs
// sk_learn_plan_decide() as the signed-in user: the database decides who may
// approve — `canDecide` here only chooses which buttons to draw.
//
// Phone-friendly: 44 px controls, 16 px inputs, everything wraps.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmt } from "@/i18n/format";
import type { Dictionary } from "@/i18n/dictionaries";
import type { PlanItem, PlanStatus } from "@/sk/practice/plan";

type Words = Dictionary["learnPlan"];

export type PlanCardData = {
  id: string;
  studentName: string;
  /** The kit she finished, or null for the weekly plan. */
  kitName: string | null;
  status: PlanStatus;
  summary: string | null;
  items: PlanItem[];
  approverRole: "teacher" | "parent";
  canDecide: boolean;
  canWholeClass: boolean;
  declineNote: string | null;
  createdAt: string;
};

const STATUS_TONE: Record<string, string> = {
  pending_approval: "bg-[#FFF1D6] text-[#9A6400]",
  approved: "bg-[#E2F4F1] text-[#0C8175]",
  declined: "bg-[#EEF0EC] text-[#5B6470]",
};
const BTN = "min-h-11 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50";

export default function PlanCard({ plan, t }: { plan: PlanCardData; t: Words }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<PlanItem[]>(plan.items);
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState("");
  const [whole, setWhole] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function send(decision: "approve" | "decline" | "edit") {
    setBusy(true);
    setMsg(null);
    try {
      const items = editing ? draft.filter((i) => i.title.trim()) : null;
      const r = await fetch("/api/learn/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.id, decision, items, wholeClass: decision === "approve" && whole, note: decision === "decline" ? note : null }),
      });
      const body = (await r.json().catch(() => null)) as { outcome?: string; reason?: string } | null;
      if (!r.ok || body?.outcome !== "done") {
        setMsg({ ok: false, text: body?.reason === "not_approver" ? t.notAllowed : t.failed });
        return;
      }
      setMsg({ ok: true, text: decision === "approve" ? t.done.approved : decision === "decline" ? t.done.declined : t.done.saved });
      setEditing(false);
      setDeclining(false);
      router.refresh();
    } catch {
      setMsg({ ok: false, text: t.failed });
    } finally {
      setBusy(false);
    }
  }

  const items = editing ? draft : plan.items;
  const open = plan.status === "pending_approval";
  return (
    <article className="card px-4 sm:px-5 py-4" data-plan={plan.id} data-plan-status={plan.status}>
      <header className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="min-w-0">
          <p className="font-medium break-words">{fmt(t.forStudent, { name: plan.studentName })}</p>
          <p className="text-xs text-[#5B6470]">{plan.kitName ? fmt(t.afterKit, { kit: plan.kitName }) : t.weekly}</p>
        </div>
        <span className={`chip font-sans normal-case tracking-normal ${STATUS_TONE[plan.status] ?? "bg-[#EEF0EC] text-[#5B6470]"}`}>
          {t.status[plan.status as keyof Words["status"]] ?? plan.status}
        </span>
      </header>

      {plan.summary && <p className="text-sm mb-3">{plan.summary}</p>}

      <ol className="space-y-2 mb-3">
        {items.map((it, i) => (
          <li key={`${it.kind}:${it.generation_id ?? ""}:${it.concept_key ?? ""}:${i}`} className="rounded-lg bg-[#F5F6F3] px-3 py-2 text-sm">
            <span className="text-[11px] font-mono uppercase tracking-[0.12em] text-[#5B6470]">{t.kind[it.kind]}</span>
            {editing ? (
              <div className="mt-1 grid gap-1.5">
                <input
                  value={it.title}
                  maxLength={160}
                  onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, title: e.target.value } : d)))}
                  className="min-h-11 rounded-lg border border-[#E6E8E4] bg-white px-3 py-2 text-base"
                  aria-label={t.kind[it.kind]}
                />
                <textarea
                  value={it.reason}
                  maxLength={300}
                  rows={2}
                  onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, reason: e.target.value } : d)))}
                  className="rounded-lg border border-[#E6E8E4] bg-white px-3 py-2 text-base"
                />
                {draft.length > 1 && (
                  <button type="button" onClick={() => setDraft(draft.filter((_, j) => j !== i))} className={`${BTN} justify-self-start border border-[#E6E8E4] text-[#B3401F]`}>
                    {t.remove}
                  </button>
                )}
              </div>
            ) : (
              <>
                <p className="font-medium break-words">{it.title}</p>
                {it.reason && <p className="text-xs text-[#5B6470] break-words">{it.reason}</p>}
              </>
            )}
          </li>
        ))}
      </ol>

      {plan.status === "declined" && plan.declineNote && <p className="text-xs italic text-[#5B6470] mb-2">{plan.declineNote}</p>}

      {open && !plan.canDecide && <p className="text-xs text-[#5B6470]">{plan.approverRole === "teacher" ? t.readOnlyTeacher : t.readOnlyParent}</p>}

      {open && plan.canDecide && (
        <div className="grid gap-2">
          {declining && (
            <label className="grid gap-1 text-xs text-[#5B6470]">
              {t.declineNote}
              <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className="min-h-11 rounded-lg border border-[#E6E8E4] bg-white px-3 py-2 text-base text-[#14181F]" />
            </label>
          )}
          {plan.canWholeClass && !declining && (
            <label className="flex items-center gap-2 min-h-11 text-sm">
              <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} className="h-5 w-5" />
              {t.wholeClass}
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            {declining ? (
              <>
                <button type="button" disabled={busy} onClick={() => void send("decline")} className={`${BTN} bg-[#B3401F] text-white`}>
                  {t.decline}
                </button>
                <button type="button" disabled={busy} onClick={() => setDeclining(false)} className={`${BTN} border border-[#E6E8E4]`}>
                  {t.cancel}
                </button>
              </>
            ) : editing ? (
              <>
                <button type="button" disabled={busy} onClick={() => void send("approve")} className={`${BTN} bg-[#0C8175] text-white`} data-plan-action="approve">
                  {t.approve}
                </button>
                <button type="button" disabled={busy} onClick={() => void send("edit")} className={`${BTN} border border-[#E6E8E4]`}>
                  {t.save}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDraft(plan.items);
                    setEditing(false);
                  }}
                  className={`${BTN} border border-[#E6E8E4]`}
                >
                  {t.cancel}
                </button>
              </>
            ) : (
              <>
                <button type="button" disabled={busy} onClick={() => void send("approve")} className={`${BTN} bg-[#0C8175] text-white`} data-plan-action="approve">
                  {t.approve}
                </button>
                <button type="button" disabled={busy} onClick={() => setEditing(true)} className={`${BTN} border border-[#E6E8E4]`} data-plan-action="edit">
                  {t.edit}
                </button>
                <button type="button" disabled={busy} onClick={() => setDeclining(true)} className={`${BTN} border border-[#E6E8E4] text-[#B3401F]`} data-plan-action="decline">
                  {t.decline}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={`mt-2 text-sm ${msg.ok ? "text-[#0C8175]" : "text-[#B3401F]"}`}>
          {msg.text}
        </p>
      )}
    </article>
  );
}
