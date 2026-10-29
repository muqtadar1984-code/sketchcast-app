// /dashboard/settings — the plain-language lines (SK S6 slice C). PURE: the
// page formats every row on the server with these, so the client island only
// renders strings. Kept out of page.tsx (a page may export only its component
// and route config).

import type { Dictionary } from "@/i18n/dictionaries";
import { htmlLang, type Locale } from "@/i18n/locales";
import { fmt } from "@/i18n/format";
import type { LearningRow, SkSettingsData, WorkflowRow } from "@/sk/settings";
import type { SkPrivacyProps } from "./sk-privacy";

type SettingsMessages = Dictionary["settings"];

export function dateFmt(locale: Locale) {
  const f = new Intl.DateTimeFormat(htmlLang(locale), { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kuala_Lumpur" });
  return (iso: string | null | undefined): string => {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : f.format(d);
  };
}

/** One plain-language line per workflow fact. */
export function workflowLine(t: SettingsMessages, r: WorkflowRow): string {
  switch (r.kind) {
    case "preference": {
      const label = r.pref === "readAloud" ? t.readAloud : r.pref === "handsFree" ? t.handsFree : t.suggestions;
      return fmt(t.factPreference, { label, value: r.on ? t.on : t.off });
    }
    case "recent_class":
      return fmt(t.factRecentClass, { label: r.label });
    case "recent_kit":
      return fmt(t.factRecentKit, { label: r.label });
    case "pending_task":
      return fmt(t.factPendingTask, { label: r.label });
    default:
      return fmt(t.factOther, { label: r.label });
  }
}

/** One plain-language line per learning fact. */
export function learningLine(t: SettingsMessages, r: LearningRow): string {
  const tpl = r.kind === "misconception" ? t.learnMisconception : r.kind === "explained" ? t.learnExplained : r.kind === "struggled" ? t.learnStruggled : t.learnStrength;
  return fmt(tpl, { label: r.label });
}

/** The client island's props: every row already in words, every date formatted. */
export function privacyProps(t: SettingsMessages, data: SkSettingsData, date: (iso: string | null | undefined) => string): SkPrivacyProps {
  return {
    t,
    role: data.role,
    prefs: data.prefs,
    memoryReadable: data.memoryReadable,
    workflow: data.workflow.map((r) => ({ text: workflowLine(t, r), meta: r.date ? fmt(t.updated, { date: date(r.date) }) : "" })),
    learning: data.learning ? data.learning.map((r) => ({ text: learningLine(t, r), meta: [r.date ? date(r.date) : "", r.until ? fmt(t.keptUntil, { date: date(r.until) }) : ""].filter(Boolean).join(" · ") })) : null,
    children: data.children.map((c) => ({ ...c, name: c.name || t.childFallback })),
    school: data.school
      ? {
          name: data.school.name,
          on: data.school.on,
          changed: data.school.changedAt
            ? data.school.changedBy
              ? fmt(t.schoolChanged, { name: data.school.changedBy, date: date(data.school.changedAt) })
              : fmt(t.schoolChangedNoName, { date: date(data.school.changedAt) })
            : t.schoolNeverChanged,
        }
      : null,
    student: data.student
      ? {
          memory: data.student.memory === "parent" ? t.studentOnParent : data.student.memory === "school" ? t.studentOnSchool : t.studentOff,
          memoryOn: data.student.memory !== null,
          voice: data.student.voice ? t.studentVoiceOn : t.studentVoiceOff,
        }
      : null,
  };
}
