"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LANGUAGES, languageLabel } from "@/utils/narration";
import { SWEEP_DEFAULT_LIMIT, SWEEP_MAX_LIMIT, type SweepCandidate, type SweepNotReady } from "@/utils/catalogue/translate-sweep";
import { MaturityChip } from "../../catalogue-ui";
import { Drawer } from "./review-inbox";

// The Kit Translator's sweep from the review inbox (plan D7, T2 —
// 2026-10-17): a Translate… button in the queue's header opens a drawer that
// shows, for one language, which current English kits WILL be queued (the
// first N, in the sweep's order — subjects alternating, oldest first), which
// are ready after those, and which are not ready and why; then queues the
// first N through POST /api/library/translate. "Five kits first, then the
// rest": the founder sets N, queues, reads what happened, and comes back for
// the rest once those are reviewed. The route decides readiness
// (readyForTranslation); this panel only shows its answer and asks once.

const TARGETS = LANGUAGES.filter((l) => l.value !== "en");
const DEFAULT_LANGUAGE = "ar";

type DryRun = { language: string; ready: SweepCandidate[]; notReady: SweepNotReady[] };
type SweepAnswer = { language: string; queued: string[]; alreadyQueued: string[]; skipped: { kitId: string; why: string }[]; remaining: number; notReady: SweepNotReady[] };

/** The button in the queue's header, for members who may generate. */
export function TranslateSweepButton({ generateEnabled }: { generateEnabled: boolean }) {
  return (
    <Drawer label="Translate…" title="Translate the catalogue — one language, the ready kits first" wide={false}>
      <TranslateSweepPanel generateEnabled={generateEnabled} />
    </Drawer>
  );
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

export function TranslateSweepPanel({ generateEnabled }: { generateEnabled: boolean }) {
  const router = useRouter();
  const [language, setLanguage] = useState(DEFAULT_LANGUAGE);
  const [limitText, setLimitText] = useState(String(SWEEP_DEFAULT_LIMIT));
  const [dry, setDry] = useState<DryRun | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<SweepAnswer | null>(null);
  // a stale dry run (the language changed under it) never lands
  const seq = useRef(0);

  const load = (lang: string) => {
    const mine = ++seq.current;
    return fetch(`/api/library/translate?language=${encodeURIComponent(lang)}`)
      .then(async (res) => {
        const json = await readJson(res);
        if (mine !== seq.current) return;
        if (!res.ok) {
          setLoadError((json.error as string) ?? "Could not read the catalogue.");
          return;
        }
        setDry(json as unknown as DryRun);
      })
      .catch((e: unknown) => {
        if (mine === seq.current) setLoadError(e instanceof Error ? e.message : "Could not read the catalogue.");
      });
  };

  // The dry run for the language: on open, and again when the language
  // changes (the handler clears the old answer first, so the lists never
  // show one language's kits under another's name). A response that arrives
  // after a newer request started is dropped by the sequence check; one that
  // arrives after the drawer closed sets state on an unmounted component,
  // which React ignores.
  useEffect(() => {
    void load(language);
  }, [language]);

  const pickLanguage = (lang: string) => {
    setLanguage(lang);
    setDry(null);
    setLoadError(null);
    setAnswer(null);
    setPostError(null);
  };

  const label = languageLabel(language) ?? language;
  const limitNumber = Number.parseInt(limitText, 10);
  const limit = Number.isInteger(limitNumber) && limitNumber >= 1 && limitNumber <= SWEEP_MAX_LIMIT ? limitNumber : null;
  const ready = dry?.ready ?? [];
  const notReady = dry?.notReady ?? [];
  const batch = limit ? ready.slice(0, limit) : [];
  const rest = limit ? ready.slice(limit) : ready;
  const titleOf = (kitId: string) => ready.find((r) => r.kitId === kitId)?.title ?? kitId.slice(0, 8);
  const lockWhy = !generateEnabled ? "Catalogue generation is switched off (FEATURE_CATALOGUE_GENERATE)." : !limit ? `First N must be a whole number from 1 to ${SWEEP_MAX_LIMIT}.` : !batch.length ? "Nothing is ready to translate." : null;

  const queue = async () => {
    if (!limit || !batch.length) return;
    if (
      !window.confirm(
        `Queue ${batch.length} ${label} translation${batch.length === 1 ? "" : "s"}?\n\n` +
          `The worker runs them ONE KIT AT A TIME on the catalogue lane, in its off-peak window — a sweep takes nights, not minutes. Each translation lands in the review queue; nothing is published until a reviewer approves it.`,
      )
    )
      return;
    setBusy(true);
    setPostError(null);
    setAnswer(null);
    try {
      const res = await fetch("/api/library/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, limit }),
      });
      const json = await readJson(res);
      if (!res.ok) {
        setPostError((json.error as string) ?? "Something went wrong.");
        return;
      }
      setAnswer(json as unknown as SweepAnswer);
      router.refresh();
      // the lists again, now that the queued kits are "already queued"
      setDry(null);
      void load(language);
    } finally {
      setBusy(false);
    }
  };

  const row = (c: SweepCandidate, extra?: React.ReactNode) => (
    <li key={c.kitId} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
      <span className="min-w-0 grow leading-snug">{c.title}</span>
      {c.subject && <span className="chip bg-[#EEF0EC] text-[#3F4752]">{c.subject}</span>}
      <MaturityChip maturity={c.bankMaturity} />
      {extra}
    </li>
  );

  return (
    <div className="space-y-4 text-sm">
      <p className="text-xs text-[#3F4752]">
        The sweep takes the catalogue&apos;s current English kits — approved, part 1 public on YouTube, an approved bank, not superseded — that have no live {label} translation, alternating subjects and oldest first. The worker translates the words, keeps the pictures, figures and maths, and re-renders with {label} voices; each translation then waits in the review queue.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[#3F4752]">Language</span>
          <select value={language} onChange={(e) => pickLanguage(e.target.value)} className="field h-8 px-2 text-xs" disabled={busy} aria-label="Language to translate into">
            {TARGETS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[#3F4752]">First N kits</span>
          <input type="number" min={1} max={SWEEP_MAX_LIMIT} step={1} value={limitText} onChange={(e) => setLimitText(e.target.value)} className="field h-8 px-2 text-xs w-24" disabled={busy} aria-label="How many kits to queue now" />
        </label>
        <div className="text-xs text-[#3F4752] pb-2">
          {dry ? (
            <>
              <span className="font-medium text-[#14181F]">{ready.length}</span> ready · <span className="font-medium text-[#14181F]">{notReady.length}</span> not ready
            </>
          ) : loadError ? (
            <span className="text-[#B3401F]">{loadError}</span>
          ) : (
            "Reading the catalogue…"
          )}
        </div>
      </div>

      {answer && (
        <div className="rounded-lg border border-[#CFE8DC] bg-[#F1FAF5] p-3 space-y-1 text-xs">
          <p className="text-sm font-medium text-[#0F7A68]">
            {answer.queued.length ? `Queued ${answer.queued.length} ${label} translation${answer.queued.length === 1 ? "" : "s"}.` : `Nothing new was queued.`}
          </p>
          {answer.queued.length > 0 && <p>Queued: {answer.queued.map(titleOf).join(" · ")}</p>}
          {answer.alreadyQueued.length > 0 && <p>Already queued (a live job for the same kit): {answer.alreadyQueued.map(titleOf).join(" · ")}</p>}
          {answer.skipped.length > 0 && (
            <p className="text-[#B3401F]">
              Skipped:{" "}
              {answer.skipped.map((s) => (
                <span key={s.kitId}>
                  {titleOf(s.kitId)} ({s.why}){" "}
                </span>
              ))}
            </p>
          )}
          <p className="text-[#3F4752]">
            {answer.remaining > 0 ? `${answer.remaining} more ready kit${answer.remaining === 1 ? "" : "s"} — come back for the rest once these are reviewed.` : "Every ready kit is queued."} The worker runs one kit at a time on the catalogue lane; each translation appears in the review queue when its check and render are done.
          </p>
        </div>
      )}

      {dry && (
        <>
          <section>
            <h3 className="text-xs font-medium text-[#3F4752] uppercase tracking-wide">
              Will be queued now ({batch.length})
            </h3>
            {batch.length === 0 ? (
              <p className="text-[#3F4752] py-1.5">{ready.length ? "Set First N to at least 1." : `No kit is ready for ${label} — every current English kit has a live ${label} translation or a job, or is held back below.`}</p>
            ) : (
              <ol className="divide-y divide-[#EEF0EC]">{batch.map((c, i) => row(c, <span className="text-xs text-[#98A0A9] tabular">#{i + 1}</span>))}</ol>
            )}
          </section>

          {rest.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer select-none text-xs font-medium text-[#3F4752] uppercase tracking-wide list-none [&::-webkit-details-marker]:hidden">
                <span className="text-[#98A0A9] mr-1 inline-block transition-transform group-open:rotate-90">▶</span>
                Ready, after these ({rest.length})
              </summary>
              <ol className="divide-y divide-[#EEF0EC]">{rest.map((c, i) => row(c, <span className="text-xs text-[#98A0A9] tabular">#{batch.length + i + 1}</span>))}</ol>
            </details>
          )}

          <section>
            <h3 className="text-xs font-medium text-[#3F4752] uppercase tracking-wide">Not ready ({notReady.length})</h3>
            {notReady.length === 0 ? (
              <p className="text-[#3F4752] py-1.5">Every current English kit is ready or already translated.</p>
            ) : (
              <ul className="divide-y divide-[#EEF0EC]">
                {notReady.map((n) => (
                  <li key={n.kitId} className="py-1.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 grow leading-snug">{n.title}</span>
                      {n.subject && <span className="chip bg-[#EEF0EC] text-[#3F4752]">{n.subject}</span>}
                      <MaturityChip maturity={n.bankMaturity} />
                    </div>
                    <p className={`text-xs ${n.code === "queued" || n.code === "translation_live" ? "text-[#3F4752]" : "text-[#9A6400]"}`}>{n.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {postError && <p className="text-sm text-[#B3401F]">{postError}</p>}
      <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-[#EEF0EC]">
        <button type="button" onClick={queue} disabled={busy || !dry || !!lockWhy} title={lockWhy ?? undefined} className="btn-primary h-9 px-4 text-sm disabled:opacity-50">
          {busy ? "Queuing…" : `Queue ${batch.length} ${label} translation${batch.length === 1 ? "" : "s"}`}
        </button>
        {lockWhy && dry && <span className="text-xs text-[#3F4752]">{lockWhy}</span>}
      </div>
    </div>
  );
}
