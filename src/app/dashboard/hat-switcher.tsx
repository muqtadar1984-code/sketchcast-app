"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HAT_LABEL, type Hat } from "@/utils/hats";

// The top-right hat dropdown: switch which role's world you're in. The server
// validates the hat is actually held (/api/hat) and answers with that hat's
// home; a full router.refresh() re-renders the header + tabs for the new hat.
export default function HatSwitcher({ hats, active }: { hats: Hat[]; active: Hat }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function change(next: string) {
    if (next === active || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/hat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hat: next }),
      });
      const d = (await res.json().catch(() => ({}))) as { redirect?: string };
      if (res.ok) {
        router.push(d.redirect ?? "/dashboard");
        router.refresh();
        return; // keep busy=true through the navigation
      }
    } catch {
      /* fall through to re-enable */
    }
    setBusy(false);
  }

  return (
    <label className="flex items-center gap-1.5 text-sm">
      <span className="text-[#98A0A9] text-xs hidden sm:inline">Viewing as</span>
      <select
        value={active}
        disabled={busy}
        onChange={(e) => void change(e.target.value)}
        aria-label="Switch role view"
        className="h-9 rounded-lg border border-[#E6E8E4] bg-white px-2 text-sm text-[#14181F] disabled:opacity-50"
      >
        {hats.map((h) => (
          <option key={h} value={h}>
            {HAT_LABEL[h]}
          </option>
        ))}
      </select>
    </label>
  );
}
