// S4 slice E — one child's "This week" card (server component, no state, no
// hover-only controls). The numbers and steps are parent-digest.ts weekCard's,
// the SAME as SK's child.week answer; the labels are the page's dictionary.

import type { Dictionary } from "@/i18n/dictionaries";
import type { WeekCard as WeekCardData } from "@/sk/parent-digest";

type WeekMessages = Dictionary["school"]["children"]["week"];

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export default function WeekCard({ card, t }: { card: WeekCardData; t: WeekMessages }) {
  const stats: Array<{ key: string; label: string; n: number; alert?: boolean }> = [
    { key: "done", label: t.done, n: card.done },
    { key: "overdue", label: t.overdue, n: card.overdue, alert: card.overdue > 0 },
    { key: "awaiting", label: t.awaiting, n: card.awaiting },
    { key: "mastered", label: t.mastered, n: card.mastered },
    { key: "notes", label: t.notes, n: card.notes },
  ];
  return (
    <section data-sk="week-card" data-child={card.childId} aria-label={`${t.title} — ${card.name}`} className="px-5 py-3 bg-[#F6FAF9]">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h3 className="text-sm font-medium text-[#14181F]">{t.title}</h3>
        <span className="text-xs text-[#5B6470]">{t.period}</span>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {stats.map((s) => (
          <div key={s.key} data-stat={s.key} className="rounded-lg bg-white border border-[#EEF0EC] px-3 py-2 min-w-0">
            <dt className="text-[11px] leading-tight text-[#5B6470] break-words">{s.label}</dt>
            <dd className={`text-lg font-medium tabular ${s.alert ? "text-[#B3401F]" : "text-[#14181F]"}`}>{s.n}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-2.5">
        <p className="text-xs font-medium text-[#5B6470]">{t.todo}</p>
        {card.steps.length ? (
          <ul data-sk="week-steps" className="mt-1 list-disc ps-5 space-y-0.5 text-sm text-[#14181F]">
            {card.steps.map((step) => (
              <li key={step} className="break-words">
                {cap(step)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-[#5B6470]">{t.nothing}</p>
        )}
      </div>
    </section>
  );
}
