"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Run, RunEvent } from "@/utils/books/types";

// A run as it happens: status, step, cost against the estimate, the runner's
// heartbeat and its log. Polls every 3 s while the run is queued or running,
// then refreshes the page once so the run's files appear.
const POLL_MS = 3000;
const LIVE = new Set(["queued", "running"]);
const TONE: Record<string, string> = {
  done: "bg-[#E3EEE5] text-[#24543A] border-[#BCD5C2]",
  failed: "bg-[#F3E1DF] text-[#8E2A21] border-[#E2BAB5]",
  queued: "bg-[#FBEBD5] text-[#8A4B10] border-[#EDCB9C]",
  running: "bg-[#E2E8F3] text-[#28406B] border-[#BCC9E0]",
  cancelled: "bg-[#ECEAE4] text-[#5F5A4E] border-[#D8D3C6]",
};
const LEVEL: Record<string, string> = { error: "text-[#8E2A21]", warning: "text-[#8A4B10]" };

function money(n: number | null | undefined) {
  return n === null || n === undefined ? "—" : `$${Number(n).toFixed(2)}`;
}

function since(iso: string | null | undefined, now: number) {
  if (!iso) return null;
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

export default function RunLive({ slug, initialRun, initialEvents, canControl }: {
  slug: string;
  initialRun: Run;
  initialEvents: RunEvent[];
  canControl: boolean;
}) {
  const router = useRouter();
  const [run, setRun] = useState(initialRun);
  const [events, setEvents] = useState(initialEvents);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const lastId = useRef(initialEvents.length ? initialEvents[initialEvents.length - 1].id : 0);
  const live = LIVE.has(run.status);

  useEffect(() => {
    if (!live) return;
    let stop = false;
    let inFlight = false;
    const t = setInterval(async () => {
      if (inFlight) return; // one poll at a time, so two never ask for the same lines
      inFlight = true;
      try {
        const r = await fetch(`/api/pub/runs/${run.id}?book=${encodeURIComponent(slug)}&after=${lastId.current}`, { cache: "no-store" });
        if (!r.ok || stop) return;
        const body = (await r.json()) as { run: Run; events: RunEvent[] };
        setRun(body.run);
        if (body.events.length) {
          lastId.current = Math.max(lastId.current, ...body.events.map((e) => e.id));
          setEvents((old) => {
            const seen = new Set(old.map((e) => e.id));
            return [...old, ...body.events.filter((e) => !seen.has(e.id))].slice(-1000);
          });
        }
        setNow(Date.now());
        if (!LIVE.has(body.run.status)) router.refresh();
      } catch {
        // a missed poll is retried on the next tick
      } finally {
        inFlight = false;
      }
    }, POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [live, run.id, slug, router]);

  useEffect(() => {
    const el = logRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [events]);

  async function act(action: "cancel" | "retry") {
    setBusy(true);
    setNote(null);
    const r = await fetch(`/api/pub/runs/${run.id}?book=${encodeURIComponent(slug)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const body = (await r.json().catch(() => ({}))) as { error?: string; note?: string };
    setNote(body.error ?? body.note ?? (action === "cancel" ? "Cancel requested." : null));
    setBusy(false);
  }

  const summary = run.detail?.summary as Record<string, unknown> | undefined;
  const beat = run.status === "running" ? since(run.heartbeat_at, now) : null;

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-[#E4DCC8] bg-white p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-display text-lg text-[#1F2A24]">#{run.id} · {run.label}</h2>
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${TONE[run.status] ?? TONE.cancelled}`}>{run.status}</span>
          {live && <span className="text-xs text-[#7A7363]">updating every {POLL_MS / 1000} s</span>}
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div><dt className="text-xs text-[#7A7363]">Step</dt><dd>{run.progress?.note ?? run.progress?.step ?? "—"}</dd></div>
          <div><dt className="text-xs text-[#7A7363]">Cost</dt><dd className="tabular-nums">{money(run.usd)} <span className="text-[#7A7363]">of ≈ {money(run.estimate_usd)}</span></dd></div>
          <div><dt className="text-xs text-[#7A7363]">Started by</dt><dd className="truncate">{run.requested_by ?? run.trigger ?? "—"}</dd></div>
          <div><dt className="text-xs text-[#7A7363]">Runner</dt><dd>{beat ? `alive, last heard ${beat} ago` : run.status === "queued" ? "not started yet" : "finished"}</dd></div>
        </dl>
        {summary && Object.keys(summary).length > 0 && (
          <pre className="text-xs bg-[#FAF7EF] rounded-md p-2 overflow-x-auto">{JSON.stringify(summary, null, 1)}</pre>
        )}
        {run.error && <p className="text-sm text-[#8E2A21] whitespace-pre-wrap">{run.error}</p>}
        {canControl && live && (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" disabled={busy || !!run.cancel_requested_at} onClick={() => act("cancel")} className="rounded-md border border-[#E2BAB5] px-3 py-1 text-sm text-[#8E2A21] disabled:opacity-40">
              {run.cancel_requested_at ? "Cancel requested" : "Cancel"}
            </button>
            {run.status === "queued" && (
              <button type="button" disabled={busy} onClick={() => act("retry")} className="rounded-md border border-[#E4DCC8] px-3 py-1 text-sm disabled:opacity-40">
                Start the runner again
              </button>
            )}
            {note && <span className="text-sm text-[#5F5A4E]">{note}</span>}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-[#E4DCC8] bg-white p-4 sm:p-5">
        <h2 className="font-display text-base text-[#1F2A24] mb-2">Log</h2>
        <div ref={logRef} className="max-h-[28rem] overflow-y-auto rounded-md bg-[#1F2A24] p-3 font-mono text-xs leading-relaxed text-[#E9E4D6]">
          {events.length === 0 ? (
            <p className="text-[#9A9483]">Nothing yet.</p>
          ) : (
            events.map((e) => (
              <div key={e.id} className={`whitespace-pre-wrap break-words ${LEVEL[e.level] ? "text-[#F2B8A8]" : e.kind === "progress" ? "text-[#E9C77B]" : ""}`}>
                <span className="text-[#9A9483]">{new Date(e.at).toLocaleTimeString("en-GB", { timeZone: "UTC" })} </span>
                {e.message}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
