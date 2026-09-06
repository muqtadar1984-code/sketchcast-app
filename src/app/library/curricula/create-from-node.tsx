"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { NODE_KIND_LABEL } from "@/utils/catalogue/status";
import type { NodeKind } from "@/utils/catalogue/types";

// "Create topic from node" on an uncovered curriculum node — POST
// /api/library/curricula {nodeId, title?, childIds?}. The node's title becomes
// a candidate topic with a curriculum alias. A LEAF maps itself (one click). A
// GROUP (a sub-strand's objectives, a unit's topics) opens a small form: the
// title, and its children with tick boxes — all ticked by default — and the
// route maps every ticked child as full coverage, never the group itself. A
// 409 means the key already belongs to a topic, so the message links to it.

type Child = { id: string; code: string; title: string };

export default function CreateFromNode({
  nodeId,
  title,
  kind,
  objectives,
}: {
  nodeId: string;
  title: string;
  kind: NodeKind | null;
  /** The node's mappable children (a sub-strand's objectives); empty for a leaf. */
  objectives: Child[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingId, setExistingId] = useState<string | null>(null);
  const [name, setName] = useState(title);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(objectives.map((c) => c.id)));

  const grouped = objectives.length > 0;
  const kindLabel = kind ? NODE_KIND_LABEL[kind] : "node";

  async function create() {
    setBusy(true);
    setError(null);
    setExistingId(null);
    const payload: Record<string, unknown> = { nodeId };
    if (grouped) {
      payload.title = name;
      payload.childIds = objectives.filter((c) => ticked.has(c.id)).map((c) => c.id);
    }
    const res = await fetch("/api/library/curricula", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Something went wrong.");
      if (json.existingId) setExistingId(json.existingId as string);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  const toggle = (id: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!grouped) {
    return (
      <span className="inline-flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={create}
          disabled={busy}
          className="btn-ghost h-8 px-2.5 text-xs whitespace-nowrap"
          title={`Create the topic "${title}" from this ${kindLabel}`}
        >
          {busy ? "…" : "Create topic from node"}
        </button>
        <ErrorLine error={error} existingId={existingId} />
      </span>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn-ghost h-8 px-2.5 text-xs whitespace-nowrap"
        title={`Create the topic "${title}" and map its ${objectives.length} ${objectives.length === 1 ? "objective" : "objectives"}`}
      >
        Create topic from {objectives.length} objective{objectives.length === 1 ? "" : "s"}
      </button>
    );
  }

  return (
    <form
      className="card p-3 w-full sm:w-96 space-y-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <p className="text-xs text-[#5B6470]">
        New topic from this {kindLabel}; the ticked objectives are mapped to it (full coverage). The {kindLabel} itself is
        not mapped — it counts as covered once its objectives are.
      </p>
      <label className="block">
        <span className="text-xs text-[#5B6470]">Title (becomes the canonical key)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} className="field w-full h-9 px-3 mt-1" autoFocus />
      </label>
      <ul className="max-h-56 overflow-auto divide-y divide-[#F4F6F3] rounded-lg border border-[#EEF0EC]">
        {objectives.map((c) => (
          <li key={c.id}>
            <label className="flex items-start gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-[#F8FAF7]">
              <input type="checkbox" checked={ticked.has(c.id)} onChange={() => toggle(c.id)} className="mt-1" />
              <span className="min-w-0">
                <span className="font-mono text-xs text-[#1F5B99]">{c.code}</span> <span className="text-xs">{c.title}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-2 text-xs text-[#5B6470]">
        <span className="tabular">
          {ticked.size}/{objectives.length} ticked
        </span>
        <span className="flex items-center gap-2">
          <button type="button" onClick={() => setTicked(new Set(objectives.map((c) => c.id)))} className="underline">
            all
          </button>
          <button type="button" onClick={() => setTicked(new Set())} className="underline">
            none
          </button>
        </span>
      </div>
      <ErrorLine error={error} existingId={existingId} />
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy || !name.trim() || ticked.size === 0} className="btn-primary h-9 px-4">
          {busy ? "Creating…" : `Create + map ${ticked.size}`}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn-ghost h-9 px-3">
          Cancel
        </button>
      </div>
    </form>
  );
}

function ErrorLine({ error, existingId }: { error: string | null; existingId: string | null }) {
  if (!error) return null;
  return (
    <span className="block text-xs text-red-600 max-w-sm text-right">
      {error}
      {existingId && (
        <>
          {" "}
          <Link href={`/library/topics/${existingId}`} className="underline">
            Open it
          </Link>
        </>
      )}
    </span>
  );
}
