"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

// "Create all unmatched" for one curriculum's derived candidates — POST
// /api/library/candidates/bulk {curriculumId}. Every open candidate of the
// curriculum with no suggested topic is created (topic + alias + node_ids
// mappings) unless its key is already held, in which case it is SKIPPED and
// listed here with the topic that holds it, for a merge by hand. The result
// stays on screen after the refresh so the skips are not lost.

type Skipped = { candidateId: string; raw_title: string; key: string; reason: string; existingId: string | null; existingTitle: string | null };
type Result = { created: { raw_title: string; topicId: string; mappings: number }[]; skipped: Skipped[]; remaining: number; error?: string };

export default function BulkCreate({ curriculumId, count, name }: { curriculumId: string; count: number; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!window.confirm(`Create a topic for every unmatched candidate of ${name} (${count})? Keys already held are skipped, not merged.`)) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/library/candidates/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ curriculumId }),
    });
    const json = (await res.json().catch(() => ({}))) as Partial<Result> & { error?: string };
    setBusy(false);
    if (!res.ok && !json.created) {
      setError(json.error ?? "Something went wrong.");
      return;
    }
    setResult({ created: json.created ?? [], skipped: json.skipped ?? [], remaining: json.remaining ?? 0, error: json.error });
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1.5 text-xs">
      <button
        type="button"
        onClick={run}
        disabled={busy || count === 0}
        className="btn-primary h-8 px-3 whitespace-nowrap"
        title="Create a topic (with its alias and objective mappings) for every candidate here that has no suggested topic; taken keys are skipped"
      >
        {busy ? "Creating…" : `Create all unmatched (${count})`}
      </button>
      {error && <p className="text-red-600 text-right max-w-sm">{error}</p>}
      {result && (
        <div className="card p-3 w-full sm:w-96 text-left space-y-1.5">
          <p>
            <span className="font-medium text-[#0F7A68]">{result.created.length} created</span>
            {" · "}
            <span className={result.skipped.length ? "font-medium text-[#9A6400]" : ""}>{result.skipped.length} skipped</span>
            {result.remaining > 0 && <> · {result.remaining} remaining — click again</>}
          </p>
          {result.error && <p className="text-red-600">{result.error}</p>}
          {result.skipped.length > 0 && (
            <ul className="max-h-48 overflow-auto divide-y divide-[#F4F6F3]">
              {result.skipped.map((s) => (
                <li key={s.candidateId} className="py-1">
                  <span className="font-medium">{s.raw_title}</span> <span className="text-[#98A0A9] font-mono">{s.key}</span>
                  <span className="block text-[#5B6470]">
                    {s.reason}
                    {s.existingId && (
                      <>
                        {" · "}
                        <Link href={`/library/topics/${s.existingId}`} className="underline">
                          open {s.existingTitle ?? "the topic"}
                        </Link>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => setResult(null)} className="underline text-[#5B6470]">
            dismiss
          </button>
        </div>
      )}
    </div>
  );
}
