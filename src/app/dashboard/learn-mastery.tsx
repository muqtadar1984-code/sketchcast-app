// Practice MASTERY and RECOMMENDED PLANS on the grown-ups' pages (SK student
// Board plan 2026-10-31, phase 4): the teacher's analytics (per class, per
// student), the home educator's analytics (per child) and the parent's
// My Children (per child). Presentational only — the pages read the rows
// through the viewer's own session (RLS: teaches_student / is_parent_of,
// 0178 + 0179) and pass them in. Compact and phone-friendly: chips that wrap,
// no wide tables.

import type { Dictionary } from "@/i18n/dictionaries";
import { fmt } from "@/i18n/format";
import { bandCounts, classConcepts, type Band, type ConceptMastery } from "@/sk/practice/mastery";
import PlanCard, { type PlanCardData } from "./plan-card";

export type LearnWords = Dictionary["learnPlan"];

export const BAND_TONE: Record<Band, string> = {
  secure: "bg-[#E2F4F1] text-[#0C8175]",
  learning: "bg-[#FFF1D6] text-[#9A6400]",
  new: "bg-[#EEF0EC] text-[#5B6470]",
};

/** One student's concepts as wrapping chips (weakest first, at most `max`). */
export function ConceptChips({ rows, t, max = 8 }: { rows: readonly ConceptMastery[]; t: LearnWords; max?: number }) {
  if (!rows.length) return <span className="text-xs text-[#98A0A9]">{t.noMastery}</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {rows.slice(0, max).map((r) => (
        <span
          key={`${r.kitId}:${r.key}`}
          className={`chip font-sans normal-case tracking-normal ${BAND_TONE[r.band]}`}
          title={`${t.band[r.band]} · ${fmt(t.score, { score: r.score })} · ${fmt(t.questions, { n: r.evidence })}`}
        >
          {r.name} <span className="tabular opacity-80">{r.score}</span>
        </span>
      ))}
      {rows.length > max && <span className="text-xs text-[#5B6470]">+{rows.length - max}</span>}
    </span>
  );
}

/** "3 secure · 2 learning · 1 new". */
export function BandLine({ rows, t }: { rows: readonly ConceptMastery[]; t: LearnWords }) {
  const c = bandCounts(rows);
  return (
    <span className="text-xs text-[#5B6470] tabular">
      {c.secure} {t.band.secure.toLowerCase()} · {c.learning} {t.band.learning.toLowerCase()} · {c.new} {t.band.new.toLowerCase()}
    </span>
  );
}

/**
 * The mastery section for groups of learners: a class (teacher) or one child
 * (home educator / parent). `groups` = [{ id, name, students: [{id, name}] }].
 */
export function MasterySection({
  groups,
  rows,
  t,
  perClass,
}: {
  groups: { id: string; name: string; students: { id: string; name: string }[] }[];
  rows: readonly ConceptMastery[];
  t: LearnWords;
  /** Show the class-level concept summary (teachers). */
  perClass: boolean;
}) {
  const byStudent = new Map<string, ConceptMastery[]>();
  for (const r of rows) byStudent.set(r.studentId, [...(byStudent.get(r.studentId) ?? []), r]);
  const any = groups.some((g) => g.students.some((s) => byStudent.has(s.id)));
  return (
    <section className="mb-10" data-learn="mastery">
      <h2 className="text-xl mb-1">{t.masteryTitle}</h2>
      <p className="text-sm text-[#5B6470] mb-3">{t.masteryHint}</p>
      {!any ? (
        <div className="card px-5 py-3 text-sm text-[#5B6470]">{t.noMastery}</div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => {
            const mine = g.students.flatMap((s) => byStudent.get(s.id) ?? []);
            if (!mine.length) return null;
            const concepts = classConcepts(mine).slice(0, 6);
            return (
              <div key={g.id} className="card divide-y divide-[#EEF0EC]">
                <div className="px-4 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{g.name}</span>
                  <BandLine rows={mine} t={t} />
                </div>
                {perClass && (
                  <div className="px-4 sm:px-5 py-3">
                    <p className="text-xs font-medium text-[#5B6470] mb-2">{t.classConcepts}</p>
                    <ul className="space-y-1.5 text-sm">
                      {concepts.map((c) => (
                        <li key={`${c.kitId}:${c.key}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                          <span className="min-w-0 break-words">{c.name}</span>
                          <span className="flex flex-wrap items-center gap-1.5 text-xs">
                            <span className="tabular font-medium">{fmt(t.score, { score: c.avg })}</span>
                            <span className={`chip font-sans normal-case tracking-normal ${BAND_TONE.secure}`}>{c.secure}</span>
                            <span className={`chip font-sans normal-case tracking-normal ${BAND_TONE.learning}`}>{c.learning}</span>
                            <span className={`chip font-sans normal-case tracking-normal ${BAND_TONE.new}`}>{c.new}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {perClass ? (
                  <details className="px-4 sm:px-5 py-3">
                    <summary className="text-xs font-medium text-[#0C8175] cursor-pointer min-h-11 flex items-center">{t.byStudent}</summary>
                    <ul className="mt-2 space-y-2">
                      {g.students
                        .filter((s) => byStudent.has(s.id))
                        .map((s) => (
                          <li key={s.id} className="text-sm">
                            <div className="font-medium mb-1">{s.name}</div>
                            <ConceptChips rows={byStudent.get(s.id) ?? []} t={t} />
                          </li>
                        ))}
                    </ul>
                  </details>
                ) : (
                  <div className="px-4 sm:px-5 py-3">
                    <ConceptChips rows={mine} t={t} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** The plans section: approval cards for the approver, read-only copies for everyone else. */
export function PlansSection({ plans, t, title = true }: { plans: PlanCardData[]; t: LearnWords; title?: boolean }) {
  return (
    <section className={title ? "mb-10" : ""} data-learn="plans" id={title ? "plans" : undefined}>
      {title && (
        <>
          <h2 className="text-xl mb-1">{t.plansTitle}</h2>
          <p className="text-sm text-[#5B6470] mb-3">{t.plansHint}</p>
        </>
      )}
      {!plans.length ? (
        <div className="card px-5 py-3 text-sm text-[#5B6470]">{t.noPlans}</div>
      ) : (
        <div className="space-y-3">
          {plans.map((p) => (
            <PlanCard key={p.id} plan={p} t={t} />
          ))}
        </div>
      )}
    </section>
  );
}
