"use client";

import { useEffect, useRef, useState } from "react";
import { NODE_KIND_LABEL } from "@/utils/catalogue/status";
import type { NodeHit, TopicHit } from "@/utils/catalogue/types";

// Two type-ahead pickers used across the portal: a topic (GET
// /api/library/topics?q=) and a curriculum node within one curriculum (GET
// /api/library/curricula/[id]/nodes?q=). Both are controlled: the parent gets
// the chosen hit and renders whatever confirms the choice.
//
// The search is driven from the input's onChange (debounced with a timer ref),
// not from an effect: effects here would only be setting state in response to
// state, which react-hooks/set-state-in-effect rightly rejects. A sequence ref
// makes sure a stale response never overwrites a newer one. `exclude` is
// applied at render time so a parent re-render never refetches.

function useTypeahead<T>(load: (query: string) => Promise<T[]>) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Unmount: cancel the pending search and orphan any in-flight response.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      seq.current++;
    },
    [],
  );

  const onInput = (value: string) => {
    setQ(value);
    if (timer.current) clearTimeout(timer.current);
    const query = value.trim();
    if (!query) {
      seq.current++;
      setHits([]);
      setLoading(false);
      return;
    }
    timer.current = setTimeout(() => {
      const mine = ++seq.current;
      setLoading(true);
      load(query)
        .then((rows) => {
          if (mine === seq.current) setHits(rows);
        })
        .catch(() => {
          if (mine === seq.current) setHits([]);
        })
        .finally(() => {
          if (mine === seq.current) setLoading(false);
        });
    }, 200);
  };

  const reset = () => {
    if (timer.current) clearTimeout(timer.current);
    seq.current++;
    setQ("");
    setHits([]);
    setLoading(false);
  };

  return { q, hits, loading, onInput, reset };
}

async function loadTopics(query: string): Promise<TopicHit[]> {
  const r = await fetch(`/api/library/topics?q=${encodeURIComponent(query)}&limit=12`);
  if (!r.ok) return [];
  const j = (await r.json()) as { topics?: TopicHit[] };
  return j.topics ?? [];
}

export function TopicSearch({
  onPick,
  exclude = [],
  placeholder = "Search topics…",
  autoFocus = false,
}: {
  onPick: (t: TopicHit) => void;
  exclude?: string[];
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const { q, hits, loading, onInput, reset } = useTypeahead(loadTopics);
  const visible = hits.filter((t) => !exclude.includes(t.id));

  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => onInput(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="field h-9 px-3 text-sm w-full"
        aria-label={placeholder}
      />
      {(visible.length > 0 || loading) && q.trim() && (
        <ul className="absolute z-20 mt-1 w-full max-h-64 overflow-auto card divide-y divide-[#EEF0EC] text-sm">
          {loading && visible.length === 0 && <li className="px-3 py-2 text-[#98A0A9]">Searching…</li>}
          {visible.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(t);
                  reset();
                }}
                className="w-full text-left px-3 py-2 hover:bg-[#F4F6F3]"
              >
                <span className="font-medium">{t.title}</span>
                <span className="text-[#5B6470]"> · {t.subject ?? "—"} · </span>
                <span className="text-xs text-[#98A0A9]">{t.status.replace(/_/g, " ")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Node picker within ONE curriculum. Render it with `key={curriculumId}` so a
 *  curriculum change remounts it and no hits from the old one linger. */
export function NodeSearch({
  curriculumId,
  onPick,
  exclude = [],
  placeholder = "Search nodes by code or title…",
}: {
  curriculumId: string;
  onPick: (n: NodeHit) => void;
  exclude?: string[];
  placeholder?: string;
}) {
  const { q, hits, loading, onInput, reset } = useTypeahead(async (query: string): Promise<NodeHit[]> => {
    if (!curriculumId) return [];
    const r = await fetch(`/api/library/curricula/${encodeURIComponent(curriculumId)}/nodes?q=${encodeURIComponent(query)}&limit=20`);
    if (!r.ok) return [];
    const j = (await r.json()) as { nodes?: NodeHit[] };
    return j.nodes ?? [];
  });
  const visible = hits.filter((n) => !exclude.includes(n.id));

  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => onInput(e.target.value)}
        placeholder={placeholder}
        disabled={!curriculumId}
        className="field h-9 px-3 text-sm w-full disabled:opacity-50"
        aria-label={placeholder}
      />
      {(visible.length > 0 || loading) && q.trim() && (
        <ul className="absolute z-20 mt-1 w-full max-h-64 overflow-auto card divide-y divide-[#EEF0EC] text-sm">
          {loading && visible.length === 0 && <li className="px-3 py-2 text-[#98A0A9]">Searching…</li>}
          {visible.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(n);
                  reset();
                }}
                className="w-full text-left px-3 py-2 hover:bg-[#F4F6F3]"
              >
                <span className="font-mono text-xs text-[#1F5B99]">{n.code}</span>
                <span className="font-medium"> {n.title}</span>
                <span className="text-xs text-[#98A0A9]">
                  {" "}
                  · {[n.grade, n.strand, n.sub_strand].filter(Boolean).join(" · ")}
                  {n.kind && ` · ${NODE_KIND_LABEL[n.kind]}`}
                  {n.children > 0 && ` · ${n.children} objective${n.children === 1 ? "" : "s"}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
