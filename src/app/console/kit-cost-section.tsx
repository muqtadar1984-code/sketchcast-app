import { fmtUsd } from "@/utils/financials";
import { COST_WINDOWS, TRANSLATED_COST_WARN_USD, type CostWindow, type GroupStats, type KitCostReport } from "@/utils/kit-cost";

// "Average cost per kit" on the Overview — a render of utils/kit-cost.ts.
// Server component; the window is a plain GET form like the Traffic tab's.

const KIND_LABEL: Record<string, string> = {
  presentation: "Video",
  deck: "Deck",
  worksheet: "Worksheet",
  activity: "Activity",
  case_study: "Case study",
  lesson_plan: "Lesson plan",
  exam_paper: "Test paper",
  translation: "Translation run",
  question_bank: "Question bank",
  quiz: "Quiz",
};

const usd = (n: number | null) => (n === null ? "—" : fmtUsd(n));
const chip = (on: boolean) =>
  on ? "chip bg-[#14181F] text-white normal-case tracking-normal" : "chip bg-[#EEF0EC] text-[#5B6470] normal-case tracking-normal";

function GroupCard({ title, sub, g }: { title: string; sub: string; g: GroupStats }) {
  return (
    <div className="rounded-xl bg-white border border-[#E6E8E4] px-4 py-3 min-w-0">
      <div className="text-xs text-[#5B6470]">{title}</div>
      <div className="text-[11px] text-[#98A0A9]">{sub}</div>
      <div className="flex items-baseline gap-3 mt-1">
        <span className="text-2xl tabular">{usd(g.avgUsd)}</span>
        <span className="text-xs text-[#5B6470]">avg · median {usd(g.medianUsd)}</span>
      </div>
      <div className="text-[11px] text-[#98A0A9] mt-0.5">
        {g.costed} of {g.kits} kits costed · {usd(g.totalUsd)} total
        {g.allIn > 0 && ` · ${g.allIn} all-in`}
      </div>
      {g.fullKits !== undefined && (
        <div className="text-[11px] text-[#98A0A9]">
          {g.fullKitEstimateUsd != null && `Full six-piece kit ≈ ${usd(g.fullKitEstimateUsd)} (sum of piece averages) · `}
          {g.fullKits} of {g.kits} were full six-piece kits
        </div>
      )}
      {g.excluded.length > 0 && (
        <div className="text-[11px] text-[#9A6400] mt-0.5">
          Left out: {g.excluded.map((e) => `${e.n} ${e.reason}`).join(" · ")}
        </div>
      )}

      {g.pieces.length > 0 && (
        <div className="mt-2 divide-y divide-[#EEF0EC] text-sm">
          {g.pieces.map((p) => (
            <div key={p.kind} className="flex items-baseline justify-between gap-2 py-1">
              <span className="text-[#5B6470]">{KIND_LABEL[p.kind] ?? p.kind}</span>
              <span className="tabular">
                {usd(p.avgUsd)} <span className="text-[11px] text-[#98A0A9]">× {p.n}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {g.providers.length > 0 && (
        <div className="mt-2 pt-2 border-t border-[#EEF0EC] text-[11px] text-[#5B6470] space-y-0.5">
          {g.providers.map((p) => (
            <div key={p.provider} className="flex items-baseline justify-between gap-2">
              <span>
                {g.providersInferred && p.provider !== "Mixed" ? "≈ " : ""}
                {p.provider} · {p.kits} kit{p.kits === 1 ? "" : "s"}
              </span>
              <span className="tabular">{usd(p.avgUsd)} avg</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function KitCostSection({ report, window, topicTitles }: { report: KitCostReport; window: CostWindow; topicTitles?: Record<string, string> }) {
  const { extras } = report;
  const allIn = report.client.allIn + report.english.allIn + report.translated.allIn;
  const costed = report.client.costed + report.english.costed + report.translated.costed;
  return (
    <section className="mb-10">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-xl">Average cost per kit</h2>
        <form method="get" className="flex flex-wrap items-center gap-2 text-xs">
          {COST_WINDOWS.map((d) => (
            <button key={d} name="costdays" value={d} className={chip(window.days === d)}>
              {d} days
            </button>
          ))}
          <label className="flex items-center gap-1 text-[#5B6470]">
            since
            <input
              type="date"
              name="costsince"
              defaultValue={window.since ?? ""}
              className="rounded border border-[#E6E8E4] bg-white px-1.5 py-0.5 text-xs"
            />
          </label>
          <button className={chip(window.since !== null)}>Go</button>
        </form>
      </div>
      <p className="text-xs text-[#98A0A9] mb-3">Kits started {window.label}, by when their first piece was created.</p>

      <div className="grid md:grid-cols-3 gap-3">
        <GroupCard title="Client kits" sub="Teachers' and parents' own books · demo and staff excluded" g={report.client} />
        <GroupCard title="Catalogue kits · English" sub="topic_kits without a source kit" g={report.english} />
        <GroupCard title="Catalogue kits · translated" sub="Translation run + the pieces rewritten in the language" g={report.translated} />
      </div>

      <div className="rounded-xl bg-white border border-[#E6E8E4] px-4 py-3 mt-3 text-sm text-[#5B6470]">
        <span className="text-xs text-[#5B6470] me-2">Per-topic extras</span>
        {extras.articles.costed} articles at {usd(extras.articles.avgUsd)} · {extras.questions.costed} question sets at{" "}
        {usd(extras.questions.avgUsd)} · {usd(extras.perTopicUsd)} per topic over {extras.topics} topic{extras.topics === 1 ? "" : "s"}
        {extras.orphanTranslate.jobs > 0 && (
          <span className="block text-[11px] text-[#98A0A9] mt-0.5">
            Translation runs whose kit was replaced or never finished: {extras.orphanTranslate.jobs} ({usd(extras.orphanTranslate.totalUsd)}) —
            real spend, not in the translated average.
          </span>
        )}
      </div>

      {report.translatedOverWarn.length > 0 && (
        <details className="rounded-xl bg-white border border-[#F2D6A2] px-4 py-3 mt-3 text-sm text-[#5B6470]">
          <summary className="cursor-pointer text-[#9A6400]">
            Translated kits over ${TRANSLATED_COST_WARN_USD.toFixed(2)}: {report.translatedOverWarn.length}
            {report.translatedOverWarn.length >= 3 && " — repeated breaches, investigate"}
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {report.translatedOverWarn.slice(0, 30).map((k) => (
              <li key={k.kitId}>
                <span className="font-medium">{k.language}</span> · {topicTitles?.[k.topicId] ?? k.topicId.slice(0, 8)} · {usd(k.totalUsd)}
                {k.ttsEstimateUsd > 0 && <span className="text-[#98A0A9]"> (measured {usd(k.measuredUsd)} + TTS ≈ {usd(k.ttsEstimateUsd)} est.)</span>}
                <span className="text-[#98A0A9]"> — {k.pieces.map((p) => `${p.kind} ${usd(p.usd)}`).join(", ")}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="text-xs text-[#98A0A9] mt-2">
        {allIn > 0 ? `${allIn} of ${costed} costed kits include images and narration; the rest are` : "Text model spend only:"} images and
        narration not recorded yet · Sonnet 5.5 booked at $3/$15, not $2/$10, so Claude reads high · a retry overwrites its job&apos;s usage, so
        failed attempts&apos; spend is missing · kits begun before 15 Oct are left out (usage was only recorded per generation from then) · ≈ = provider from the piece&apos;s recorded
        model or the routing (Arabic-script lessons and catalogue text after 18 Oct 08:33 UTC on Claude), not a per-call split.
      </p>
    </section>
  );
}
