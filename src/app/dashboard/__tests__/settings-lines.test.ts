// SK S6 slice C — /dashboard/settings: the page's data → the client island's
// props (lines.ts privacyProps): every row in plain words, every date
// formatted, the right sections per role, each toggle's one-line meaning.
// Run: node node_modules/vitest/vitest.mjs run src/app/dashboard/__tests__/settings-lines.test.ts
import { describe, expect, it } from "vitest";
import en from "@/i18n/messages/en.json";
import ms from "@/i18n/messages/ms.json";
import { dateFmt, learningLine, privacyProps, workflowLine } from "../settings/lines";
import { DEFAULT_PREFS } from "@/sk/prefs";
import type { SkSettingsData } from "@/sk/settings";

const t = en.settings;
const date = dateFmt("en");
const base: SkSettingsData = { role: "teacher", prefs: DEFAULT_PREFS, memoryReadable: true, workflow: [], learning: null, children: [], school: null, student: null };

describe("settings lines", () => {
  it("workflow facts read as sentences, with the date they were saved", () => {
    const p = privacyProps(t, { ...base, workflow: [{ kind: "recent_kit", label: "5B, Plant and Animal Cells", date: "2026-10-28T03:00:00Z" }, { kind: "preference", pref: "suggestions", on: false, date: null }] }, date);
    expect(p.workflow).toEqual([
      { text: "A lesson you opened recently: 5B, Plant and Animal Cells", meta: "updated Oct 28, 2026" },
      { text: "Your setting: SK suggestions — Off", meta: "" },
    ]);
  });

  it("every workflow and learning kind has words (no raw keys)", () => {
    for (const r of [
      { kind: "recent_class", label: "5B", date: null },
      { kind: "pending_task", label: "notice.post", date: null },
      { kind: "other", label: "x", date: null },
      { kind: "preference", pref: "readAloud", on: true, date: null },
      { kind: "preference", pref: "handsFree", on: false, date: null },
    ] as const)
      expect(workflowLine(t, r)).not.toMatch(/\{|\}/);
    for (const kind of ["misconception", "explained", "struggled", "strength"] as const) expect(learningLine(t, { kind, label: "Osmosis", date: null, until: null })).toContain("Osmosis");
  });

  it("a student: her learning with 'kept until', who turned memory on; no switch for her", () => {
    const p = privacyProps(
      t,
      { ...base, role: "student", learning: [{ kind: "misconception", label: "Plant cells have no mitochondria", date: "2026-10-27T00:00:00Z", until: "2027-01-25T00:00:00Z" }], student: { memory: "school", voice: null } },
      date,
    );
    expect(p.learning).toEqual([{ text: "A mix-up SK noticed: Plant cells have no mitochondria", meta: "Oct 27, 2026 · kept until Jan 25, 2027" }]);
    expect(p.student).toEqual({ memory: t.studentOnSchool, memoryOn: true, voice: t.studentVoiceOff });
    expect(privacyProps(t, { ...base, role: "student", learning: [], student: { memory: null, voice: null } }, date).student?.memory).toBe(t.studentOff);
  });

  it("a parent: one row per verified child; a nameless child gets the fallback", () => {
    const p = privacyProps(t, { ...base, role: "parent", children: [{ id: "c1", name: "", transcripts: true, voice: false }] }, date);
    expect(p.children).toEqual([{ id: "c1", name: "your child", transcripts: true, voice: false }]);
  });

  it("a principal: the switch, with who changed it and when (or that nobody has)", () => {
    const on = privacyProps(t, { ...base, role: "school_admin", school: { id: "s", name: "SK Taman Ilmu", on: true, changedBy: "Puan Aminah", changedAt: "2026-10-28T09:00:00Z" } }, date);
    expect(on.school).toEqual({ name: "SK Taman Ilmu", on: true, changed: "Last changed by Puan Aminah on Oct 28, 2026." });
    const never = privacyProps(t, { ...base, role: "school_admin", school: { id: "s", name: "X", on: false, changedBy: null, changedAt: null } }, date);
    expect(never.school?.changed).toBe(t.schoolNeverChanged);
  });

  it("each toggle explains itself in ONE line, in every locale tested", () => {
    for (const s of [en.settings, ms.settings]) {
      for (const k of ["readAloudHint", "handsFreeHint", "suggestionsHint", "childMemoryHint", "childVoiceHint", "schoolSwitchHint"] as const) {
        expect(s[k], k).not.toContain("\n");
        expect(s[k].length, k).toBeLessThan(220);
      }
    }
  });
});
