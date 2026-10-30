"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// SK S7 K3 — the founder's "Import now": calls K1's POST
// /api/sk/knowledge/import (founder-only, behind the SK allow-list gate) and
// says what the poll did. Staff chrome is English by design (console/layout).

type PollResult =
  | { status: "waiting_for_book_app" }
  | { status: "waiting_for_0174"; live: number }
  | { status: "ok"; live: number; imported: number[]; unchanged: number[]; skipped: number[]; unavailable: string[]; errors: { release_id: number; error: string }[] }
  | { error: string };

export function describePoll(r: PollResult): string {
  if ("error" in r) return `Failed: ${r.error}`;
  if (r.status === "waiting_for_book_app") return "Waiting for the book app: pub_releases (0172) is not there yet.";
  if (r.status === "waiting_for_0174") return `${r.live} live release(s), but SK's migration 0174 is not applied yet — nothing imported.`;
  const bits = [`${r.imported.length} imported`, `${r.unchanged.length} unchanged`, `${r.skipped.length} skipped`];
  if (r.unavailable.length) bits.push(`${r.unavailable.length} marked unavailable`);
  if (r.errors.length) bits.push(`${r.errors.length} failed (${r.errors.map((e) => `#${e.release_id}: ${e.error}`).join("; ")})`);
  return bits.join(" · ");
}

export default function ImportNowButton({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/sk/knowledge/import", { method: "POST" });
      if (res.status === 404) setMsg("Not available: the import route answers only a founder address that passes the SK allow-list.");
      else setMsg(describePoll((await res.json()) as PollResult));
      router.refresh();
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={disabled || busy}
        className="inline-flex min-h-10 items-center rounded-lg bg-[#14181F] px-4 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? "Importing…" : "Import now"}
      </button>
      {msg && (
        <span role="status" className="text-sm text-[#5B6470]">
          {msg}
        </span>
      )}
    </div>
  );
}
