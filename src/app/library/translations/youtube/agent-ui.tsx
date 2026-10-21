"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { QueuePlan } from "@/utils/catalogue/youtube-agent";

// The YouTube Publishing Agent's client pieces on /library/translations/youtube
// (Bulk YouTube Posting plan §3, §2.5): the check marks, the sticky bar with
// its confirmation, and the panel's buttons. The route
// (/api/library/youtube/agent) decides everything — what a selection may add
// (the same selectableForPost rule that draws the boxes), and whether "Run
// once more" may run. Nothing here posts: the worker does, one video per
// language per day.

const API = "/api/library/youtube/agent";

async function call(body: Record<string, unknown>): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, json };
}

type Selection = { selected: Set<string>; toggle: (id: string) => void; setMany: (ids: string[], on: boolean) => void; clear: () => void };
const Ctx = createContext<Selection | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const value = useMemo<Selection>(
    () => ({
      selected,
      toggle: (id) =>
        setSelected((s) => {
          const n = new Set(s);
          if (n.has(id)) n.delete(id);
          else n.add(id);
          return n;
        }),
      setMany: (ids, on) =>
        setSelected((s) => {
          const n = new Set(s);
          for (const id of ids) {
            if (on) n.add(id);
            else n.delete(id);
          }
          return n;
        }),
      clear: () => setSelected(new Set()),
    }),
    [selected],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      <SelectionBar />
    </Ctx.Provider>
  );
}

const useSelection = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error("SelectionProvider missing");
  return s;
};

/** A row's box. Disabled rows say why on hover (the selectableForPost sentence,
 *  or "already in the posting queue"). */
export function SelectBox({ kitId, disabledWhy, label }: { kitId: string; disabledWhy: string | null; label: string }) {
  const { selected, toggle } = useSelection();
  return (
    <input
      type="checkbox"
      aria-label={`Select ${label}`}
      title={disabledWhy ?? "Select to add to the posting queue"}
      disabled={!!disabledWhy}
      checked={!disabledWhy && selected.has(kitId)}
      onChange={() => toggle(kitId)}
      className="h-4 w-4 accent-[#0F7A68] disabled:opacity-30"
    />
  );
}

/** The header box: selects every selectable row currently listed (the filters
 *  decide what is listed — nothing filtered out is ever selected). */
export function SelectAllBox({ kitIds }: { kitIds: string[] }) {
  const { selected, setMany } = useSelection();
  const all = kitIds.length > 0 && kitIds.every((k) => selected.has(k));
  return (
    <input
      type="checkbox"
      aria-label="Select every ready translation listed"
      title={kitIds.length ? `Select all ${kitIds.length} listed translations that can be posted` : "Nothing listed can be posted"}
      disabled={kitIds.length === 0}
      checked={all}
      onChange={() => setMany(kitIds, !all)}
      className="h-4 w-4 accent-[#0F7A68] disabled:opacity-30"
    />
  );
}

function SelectionBar() {
  const { selected, clear } = useSelection();
  const router = useRouter();
  const [plan, setPlan] = useState<QueuePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = selected.size;
  if (n === 0 && !plan) return null;

  const preview = async () => {
    setBusy(true);
    setError(null);
    const { ok, json } = await call({ action: "preview", kitIds: [...selected] });
    setBusy(false);
    if (!ok) setError((json.error as string) ?? "The preview failed.");
    else setPlan(json.plan as QueuePlan);
  };
  const add = async () => {
    setBusy(true);
    setError(null);
    const { ok, json } = await call({ action: "add", kitIds: [...selected] });
    setBusy(false);
    if (!ok) {
      setError((json.error as string) ?? "Nothing was queued.");
      return;
    }
    setPlan(null);
    clear();
    router.refresh();
  };

  return (
    <>
      {n > 0 && !plan && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 card shadow-lg px-4 py-3 flex items-center gap-3 text-sm">
          <span className="font-medium">{n} selected</span>
          <button type="button" className="btn-primary h-8 px-3" disabled={busy} onClick={preview}>
            {busy ? "…" : "Add to posting queue…"}
          </button>
          <button type="button" className="btn-ghost h-8 px-3" onClick={clear}>
            Clear
          </button>
          {error && <span className="text-xs text-[#B3401F]">{error}</span>}
        </div>
      )}
      {plan && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Add to the posting queue">
          <div className="card bg-white max-w-xl w-full max-h-[85vh] overflow-y-auto p-5 text-sm">
            <h2 className="text-base font-medium mb-1">Add {plan.accepted.length} to the posting queue</h2>
            <p className="text-[#5B6470] mb-3">
              The agent posts <strong>one video per language per day</strong> (oldest first), each on its own language&apos;s channel, and never while a
              teacher&apos;s job is running. Uploads are private until the YouTube compliance audit is passed; after that, public.
            </p>
            {plan.perLanguage.length > 0 && (
              <table className="w-full mb-3 tabular">
                <thead>
                  <tr className="text-left text-[#5B6470]">
                    <th className="font-normal py-1">Language</th>
                    <th className="font-normal py-1">Adding</th>
                    <th className="font-normal py-1">Already waiting</th>
                    <th className="font-normal py-1">Days at one a day</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.perLanguage.map((p) => (
                    <tr key={p.language} className="border-t border-[#EEF0EC]">
                      <td className="py-1">{p.name}</td>
                      <td className="py-1">{p.adding}</td>
                      <td className="py-1">{p.waiting}</td>
                      <td className="py-1">{p.days}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mb-3">
              The queue will take about <strong>{plan.days}</strong> day{plan.days === 1 ? "" : "s"}. &ldquo;Run once more&rdquo; posts an extra one per
              language any time.
            </p>
            {plan.excluded.length > 0 && (
              <details className="mb-3">
                <summary className="cursor-pointer text-[#9A6400]">{plan.excluded.length} not added</summary>
                <ul className="mt-1 space-y-1 text-xs">
                  {plan.excluded.map((e) => (
                    <li key={e.kitId}>
                      {e.title}
                      {e.languageName ? ` (${e.languageName})` : ""} — {e.why}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {error && <p className="text-xs text-[#B3401F] mb-2">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost h-9 px-4" onClick={() => setPlan(null)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn-primary h-9 px-4" onClick={add} disabled={busy || plan.accepted.length === 0}>
                {busy ? "…" : `Queue ${plan.accepted.length}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** The panel's buttons: Run once more, Pause / Resume. */
export function AgentButtons({ paused, runOnce }: { paused: boolean; runOnce: { ok: boolean; why?: string } }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const press = async (action: "run_once" | "pause" | "resume") => {
    if (action === "run_once" && !window.confirm("Run one more round now? It posts the next waiting video of each language, one at a time.")) return;
    setBusy(action);
    setError(null);
    const { ok, json } = await call({ action });
    setBusy(null);
    if (!ok) setError((json.error as string) ?? "Nothing changed.");
    else router.refresh();
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn-primary h-8 px-3 text-sm"
        disabled={busy !== null || !runOnce.ok}
        title={runOnce.ok ? "Post one more video per language now" : runOnce.why}
        onClick={() => press("run_once")}
      >
        {busy === "run_once" ? "…" : "Run once more"}
      </button>
      <button type="button" className="btn-ghost h-8 px-3 text-sm" disabled={busy !== null} onClick={() => press(paused ? "resume" : "pause")}>
        {busy === "pause" || busy === "resume" ? "…" : paused ? "Resume" : "Pause"}
      </button>
      {error && <span className="text-xs text-[#B3401F]">{error}</span>}
    </div>
  );
}

/** Take one waiting item out of the queue. */
export function RemoveItem({ itemId }: { itemId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="text-xs text-[#5B6470] hover:text-[#B3401F] underline"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const { ok } = await call({ action: "remove", itemIds: [itemId] });
        setBusy(false);
        if (ok) router.refresh();
      }}
    >
      {busy ? "…" : "remove"}
    </button>
  );
}
