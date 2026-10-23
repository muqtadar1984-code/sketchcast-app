"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentSettings } from "@/utils/catalogue/pinterest";

// Client buttons for the Pinterest tab: the agent's controls (Run once more,
// pause/resume, clear the breaker), Retry on a failed pin, and a board's edit
// and approve. Each is one POST; the routes decide. Nothing here posts.

async function post(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: res.ok, error: json.error };
}

const BTN = "btn-ghost h-8 px-3 text-sm disabled:opacity-50";
const PRIMARY = "btn-primary h-8 px-3 text-sm disabled:opacity-50";

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (url: string, body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setMsg(null);
    const r = await post(url, body);
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: done } : { ok: false, text: r.error ?? "That did not work." });
    if (r.ok) router.refresh();
  };
  return { busy, msg, run };
}

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <span role="status" className={`text-xs ${msg.ok ? "text-[#0F7A68]" : "text-[#B42318]"}`}>{msg.text}</span>;
}

export function AgentControls({ settings, runOnceWhy }: { settings: AgentSettings; runOnceWhy: string | null }) {
  const { busy, msg, run } = useAction();
  const API = "/api/library/pinterest/agent";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={PRIMARY}
        disabled={busy || !!runOnceWhy}
        title={runOnceWhy ?? "Post one more round now: the next approved pin per language, one at a time"}
        onClick={() => run(API, { action: "run_once" }, "Round requested — the worker starts it within a minute.")}
      >
        Run once more
      </button>
      {settings.paused ? (
        <button type="button" className={BTN} disabled={busy} onClick={() => run(API, { action: "resume" }, "Resumed.")}>Resume</button>
      ) : (
        <button type="button" className={BTN} disabled={busy} onClick={() => run(API, { action: "pause" }, "Paused — nothing new starts.")}>Pause</button>
      )}
      {settings.breaker?.tripped ? (
        <button type="button" className={BTN} disabled={busy} onClick={() => run(API, { action: "clear_breaker" }, "Breaker cleared.")}>Clear breaker</button>
      ) : null}
      <Msg msg={msg} />
    </div>
  );
}

export function RetryPin({ pinId }: { pinId: string }) {
  const { busy, msg, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" className={BTN} disabled={busy} onClick={() => run("/api/library/pinterest/pins", { action: "retry", pinId }, "Back in the queue.")}>Retry</button>
      <Msg msg={msg} />
    </span>
  );
}

export function BoardRow({
  board,
  canAct,
}: {
  board: { id: string; name: string; description: string; status: string };
  canAct: boolean;
}) {
  const { busy, msg, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(board.name);
  const [description, setDescription] = useState(board.description);
  const API = "/api/library/pinterest/boards";
  const planned = board.status === "planned";

  if (editing) {
    return (
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(API, { action: "edit", boardId: board.id, name, description }, "Saved.").then(() => setEditing(false));
        }}
      >
        <label htmlFor={`board-name-${board.id}`} className="sr-only">Board name</label>
        <input id={`board-name-${board.id}`} value={name} maxLength={180} onChange={(e) => setName(e.target.value)} className="field h-9 w-full px-3" />
        <label htmlFor={`board-desc-${board.id}`} className="sr-only">Board description</label>
        <textarea id={`board-desc-${board.id}`} value={description} maxLength={500} rows={3} onChange={(e) => setDescription(e.target.value)} className="field w-full px-3 py-2" />
        <div className="flex gap-2">
          <button type="submit" className={PRIMARY} disabled={busy || !name.trim()}>Save</button>
          <button type="button" className={BTN} onClick={() => setEditing(false)}>Cancel</button>
          <Msg msg={msg} />
        </div>
      </form>
    );
  }
  return (
    <div className="space-y-1">
      <p className="font-medium">{board.name}</p>
      <p className="text-sm text-[#5B6470]">{board.description}</p>
      {canAct && planned ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            className={PRIMARY}
            disabled={busy}
            onClick={() => run(API, { action: "approve", boardId: board.id }, "Approved — the worker creates it on Pinterest.")}
          >
            Approve board
          </button>
          <button type="button" className={BTN} disabled={busy} onClick={() => setEditing(true)}>Edit</button>
          <Msg msg={msg} />
        </div>
      ) : null}
    </div>
  );
}
