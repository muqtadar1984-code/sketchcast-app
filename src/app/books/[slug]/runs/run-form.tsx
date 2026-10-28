"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { RunnableStage } from "@/utils/books/stages";

// One stage's Run form: its own parameters, the estimate, and Run. On success
// it opens the new run's live page.
export default function RunForm({ slug, stage, perChapterUsd, basis, allowed }: {
  slug: string;
  stage: RunnableStage;
  perChapterUsd: number;
  basis: string;
  allowed: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(stage.params.map((p) => [p.key, String(p.default)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const first = Number(values.first ?? 1);
  const last = Number(values.last ?? 1);
  const chapters = "first" in values ? Math.max(0, last - first + 1) : 1;
  const estimate = perChapterUsd * Math.max(1, chapters);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/pub/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ book: slug, stage: stage.key, params: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v)])) }),
      });
      const body = (await r.json().catch(() => ({}))) as { id?: number; error?: string };
      if (!r.ok || !body.id) throw new Error(body.error ?? `The run was not queued (${r.status}).`);
      router.push(`/books/${slug}/runs/${body.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {stage.params.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {stage.params.map((p) => (
            <label key={p.key} className="text-xs text-[#7A7363]">
              {p.label}
              <input
                type="number"
                min={p.min}
                max={p.max}
                value={values[p.key]}
                onChange={(e) => setValues({ ...values, [p.key]: e.target.value })}
                className="mt-1 block w-24 rounded-md border border-[#E4DCC8] px-2 py-1 text-sm text-[#1F2A24]"
              />
            </label>
          ))}
        </div>
      )}
      <p className="text-sm">
        {estimate === 0 ? (
          <span className="font-medium">Free: no model calls.</span>
        ) : (
          <>
            <span className="font-medium">Estimate: about ${estimate.toFixed(2)}</span>
            <span className="text-[#7A7363]"> — {basis}. Never a cap: you can cancel at any time.</span>
          </>
        )}
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={busy || !allowed}
          className="rounded-md bg-[#1F2A24] px-4 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {busy ? "Queuing…" : "Run"}
        </button>
        {!allowed && <span className="text-xs text-[#7A7363]">Your role on this book may not run this stage.</span>}
        {error && <span className="text-sm text-[#8E2A21]">{error}</span>}
      </div>
    </div>
  );
}
