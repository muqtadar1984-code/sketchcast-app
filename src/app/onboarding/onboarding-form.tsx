"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LogoMark } from "../dashboard/icons";
import {
  AFFILIATIONS,
  GRADE_OPTIONS,
  SUBJECT_OPTIONS,
  homeForRole,
  missingRequired,
  type OnboardingProfile,
  type OnboardingRole,
} from "@/utils/onboarding";
import { COUNTRY_CODES } from "@/utils/countries";
import { htmlLang, type Locale } from "@/i18n/locales";
import type { Dictionary } from "@/i18n/dictionaries";

type OnboardingMessages = Dictionary["app"]["onboarding"];

// The grade and subject options are STORED as their English strings (they go
// into profiles.onboarding_profile and are read back by the team), so the value
// never moves — only what the reader sees does. These maps turn a stored value
// into its dictionary key, exactly as the notification bell maps status codes;
// an unrecognised value falls through to itself rather than a blank chip.
const GRADE_KEY: Record<string, keyof OnboardingMessages["grades"]> = {
  "Early years / Kindergarten": "kindergarten",
  "Grades 1–3": "g1to3",
  "Grades 4–6": "g4to6",
  "Grades 7–9": "g7to9",
  "Grades 10–12": "g10to12",
};
const SUBJECT_KEY: Record<string, keyof OnboardingMessages["subjects"]> = {
  Mathematics: "maths",
  Science: "science",
  English: "english",
  "Computing / ICT": "computing",
  "Social studies": "socialStudies",
  Languages: "languages",
  Arts: "arts",
  Other: "other",
};

// The new-joiner profile form. The role toggle is SEEDED from the signup pick but
// the user confirms (or corrects) it here. "Continue" stays disabled until every
// mandatory field for the chosen role is filled — the exact same missingRequired()
// the server re-checks, so the client gate and the server gate never disagree.
//
// Every word arrives as props from the (server) page; the type import is
// type-only and erased, so the server-only dictionary never reaches the bundle.
export default function OnboardingForm({
  seedRole,
  initialName,
  locale,
  t,
  common,
}: {
  seedRole: OnboardingRole;
  initialName: string;
  locale: Locale;
  t: OnboardingMessages;
  common: Dictionary["common"];
}) {
  const router = useRouter();
  const [role, setRole] = useState<OnboardingRole>(seedRole);
  const [fullName, setFullName] = useState(initialName);
  const [p, setP] = useState<OnboardingProfile>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);

  const missing = useMemo(() => missingRequired(role, fullName, p), [role, fullName, p]);
  const ready = missing.length === 0;
  // Only surface the "still needed" hint once the user has tried to continue.
  const show = (field: string) => attempted && missing.includes(field);

  const gradeLabel = (g: string) => t.grades[GRADE_KEY[g]] ?? g;
  const subjectLabel = (s: string) => t.subjects[SUBJECT_KEY[s]] ?? s;

  // Country options: the codes live in countries.ts, the NAMES come from the
  // runtime's own CLDR data via Intl.DisplayNames — no country-name strings in
  // the message files, and every locale gets native names for free. Sorted by
  // that localized name so the list reads naturally in Arabic as in French.
  // htmlLang() maps our internal "ms-arab" to the BCP-47 "ms-Arab" that Intl
  // understands; a runtime without the locale's region data falls back to the
  // bare code, which still renders and still saves.
  const countries = useMemo(() => {
    const tag = htmlLang(locale);
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([tag], { type: "region" });
    } catch {
      names = null;
    }
    return COUNTRY_CODES.map((code) => {
      let name = code as string;
      try {
        name = names?.of(code) ?? code;
      } catch {
        // an unknown code would throw; the registry only holds assigned ones
      }
      return { code, name };
    }).sort((a, b) => a.name.localeCompare(b.name, tag));
  }, [locale]);

  function toggleIn(list: string[] | undefined, value: string): string[] {
    const set = new Set(list ?? []);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    return Array.from(set);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    setError(null);
    if (!ready) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, full_name: fullName.trim(), profile: p }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        role?: OnboardingRole;
        home_educator?: boolean;
      };
      if (!res.ok) {
        setError(data.error ?? common.somethingWentWrong);
        setSubmitting(false);
        return;
      }
      // Land on the confirmed role's home. A hard replace + refresh so the server
      // layout re-reads the now-onboarded profile (no bounce back here). The
      // SERVER's word on home_educator decides the parent landing (0087): a
      // homeschooling/tutoring parent homes on the full Library.
      router.replace(homeForRole(data.role ?? role, { homeEducator: data.home_educator === true }));
      router.refresh();
    } catch {
      setError(t.networkError);
      setSubmitting(false);
    }
  }

  const roleBtn = (r: OnboardingRole, label: string, sub: string) => (
    <button
      key={r}
      type="button"
      onClick={() => setRole(r)}
      aria-pressed={role === r}
      className={`flex-1 rounded-xl border p-4 text-start transition ${
        role === r
          ? "border-[#1FB8A6] bg-[#E2F4F1]"
          : "border-[#E6E8E4] bg-white hover:border-[#CBD2CC]"
      }`}
    >
      <span className={`block text-sm font-semibold ${role === r ? "text-[#0C8175]" : "text-[#14181F]"}`}>
        {label}
      </span>
      <span className="block text-xs text-[#5B6470] mt-0.5">{sub}</span>
    </button>
  );

  // `value` is what gets STORED; `text` is what the reader sees.
  const chip = (value: string, text: string, selected: boolean, onClick: () => void) => (
    <button
      key={value}
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-full border px-3 py-1.5 text-sm ${
        selected
          ? "border-[#1FB8A6] bg-[#E2F4F1] text-[#0C8175]"
          : "border-[#E6E8E4] bg-white text-[#5B6470] hover:border-[#CBD2CC]"
      }`}
    >
      {text}
    </button>
  );

  const label = (text: string, required = false) => (
    <span className="block text-sm font-medium text-[#14181F] mb-2">
      {text}
      {required && <span className="text-[#C0392B]"> *</span>}
    </span>
  );

  return (
    <main className="min-h-screen flex items-start sm:items-center justify-center bg-[#FCFCFA] px-4 py-10">
      <div className="w-full max-w-lg card rounded-2xl p-8">
        <div className="flex items-center gap-2.5 mb-1">
          <LogoMark size={34} />
          <h1 className="text-2xl">{t.title}</h1>
        </div>
        <p className="text-sm text-[#5B6470] mt-1 mb-6">{t.subtitle}</p>

        <form onSubmit={onSubmit} className="space-y-6">
          {/* Role */}
          <div>
            {label(t.roleQuestion, true)}
            <div className="flex gap-3">
              {roleBtn("teacher", t.teacher, t.teacherSub)}
              {roleBtn("parent", t.parent, t.parentSub)}
            </div>
          </div>

          {/* Name */}
          <div>
            {label(t.fullName, true)}
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder={t.namePlaceholder}
              className={`field w-full h-11 px-3 text-[#14181F] ${show("full_name") ? "border-[#C0392B]" : ""}`}
            />
          </div>

          {/* Country — required for both roles, saved to profiles.country with
              country_source='signup' (0085). NO default: the placeholder option
              is empty, so an untouched select fails missingRequired and the
              inline error shows; nobody gets a silently-assumed country. */}
          <div>
            {label(t.country, true)}
            <select
              value={p.country ?? ""}
              onChange={(e) => setP((s) => ({ ...s, country: e.target.value || undefined }))}
              required
              className={`field w-full h-11 px-3 ${p.country ? "text-[#14181F]" : "text-[#98A0A9]"} ${
                show("country") ? "border-[#C0392B]" : ""
              }`}
            >
              <option value="" />
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
            {show("country") && <p className="text-xs text-[#C0392B] mt-1">{t.countryRequired}</p>}
          </div>

          {role === "teacher" ? (
            <>
              {/* Affiliation */}
              <div>
                {label(t.whereTeach, true)}
                <div className="space-y-2">
                  {AFFILIATIONS.map((a) => (
                    <label
                      key={a.value}
                      className={`flex items-center gap-3 rounded-lg border px-3 h-11 cursor-pointer ${
                        p.affiliation === a.value ? "border-[#1FB8A6] bg-[#E2F4F1]" : "border-[#E6E8E4] bg-white"
                      }`}
                    >
                      <input
                        type="radio"
                        name="affiliation"
                        checked={p.affiliation === a.value}
                        onChange={() => setP((s) => ({ ...s, affiliation: a.value }))}
                        className="accent-[#0C8175]"
                      />
                      <span className="text-sm text-[#14181F]">{t.affiliations[a.value]}</span>
                    </label>
                  ))}
                </div>
                {show("affiliation") && <p className="text-xs text-[#C0392B] mt-1">{t.pickOne}</p>}
              </div>

              {p.affiliation === "school" && (
                <div>
                  {label(t.schoolName, true)}
                  <input
                    value={p.school_name ?? ""}
                    onChange={(e) => setP((s) => ({ ...s, school_name: e.target.value }))}
                    placeholder={t.schoolPlaceholder}
                    className={`field w-full h-11 px-3 text-[#14181F] ${show("school_name") ? "border-[#C0392B]" : ""}`}
                  />
                </div>
              )}

              <div>
                {label(t.gradesTeach, true)}
                <div className="flex flex-wrap gap-2">
                  {GRADE_OPTIONS.map((g) =>
                    chip(g, gradeLabel(g), (p.grade_levels ?? []).includes(g), () =>
                      setP((s) => ({ ...s, grade_levels: toggleIn(s.grade_levels, g) })),
                    ),
                  )}
                </div>
                {show("grade_levels") && <p className="text-xs text-[#C0392B] mt-1">{t.pickAtLeastOne}</p>}
              </div>

              <div>
                {label(t.subjectsTeach, true)}
                <div className="flex flex-wrap gap-2">
                  {SUBJECT_OPTIONS.map((sub) =>
                    chip(sub, subjectLabel(sub), (p.subjects ?? []).includes(sub), () =>
                      setP((s) => ({ ...s, subjects: toggleIn(s.subjects, sub) })),
                    ),
                  )}
                </div>
                {show("subjects") && <p className="text-xs text-[#C0392B] mt-1">{t.pickAtLeastOne}</p>}
              </div>
            </>
          ) : (
            <>
              {/* Purpose — required for parents (homeschool release). The two
                  answers route to two different home surfaces ("homeschool"
                  writes profiles.home_educator = true, 0087, and lands on the
                  full Library), so no default is pre-selected: an untouched
                  group fails missingRequired and the inline hint shows. Same
                  radio pattern as the teacher affiliation above. */}
              <div>
                {label(t.purposeQuestion, true)}
                <div className="space-y-2">
                  {(
                    [
                      { value: "school", text: t.purposeSchool, sub: t.purposeSchoolSub },
                      { value: "homeschool", text: t.purposeHomeschool, sub: t.purposeHomeschoolSub },
                    ] as const
                  ).map((o) => (
                    <label
                      key={o.value}
                      className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer ${
                        p.purpose === o.value ? "border-[#1FB8A6] bg-[#E2F4F1]" : "border-[#E6E8E4] bg-white"
                      }`}
                    >
                      <input
                        type="radio"
                        name="purpose"
                        checked={p.purpose === o.value}
                        onChange={() => setP((s) => ({ ...s, purpose: o.value }))}
                        className="accent-[#0C8175]"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm text-[#14181F]">{o.text}</span>
                        <span className="block text-xs text-[#5B6470]">{o.sub}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {show("purpose") && <p className="text-xs text-[#C0392B] mt-1">{t.pickOne}</p>}
              </div>

              <div>
                {label(t.childrenCount, true)}
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={p.children_count ?? ""}
                  onChange={(e) =>
                    setP((s) => ({
                      ...s,
                      children_count: e.target.value ? Math.max(1, Math.min(20, Number(e.target.value))) : undefined,
                    }))
                  }
                  placeholder={t.childrenPlaceholder}
                  className={`field w-full h-11 px-3 text-[#14181F] ${show("children_count") ? "border-[#C0392B]" : ""}`}
                />
              </div>

              <div>
                {label(t.childGrades, true)}
                <div className="flex flex-wrap gap-2">
                  {GRADE_OPTIONS.map((g) =>
                    chip(g, gradeLabel(g), (p.child_grade_levels ?? []).includes(g), () =>
                      setP((s) => ({ ...s, child_grade_levels: toggleIn(s.child_grade_levels, g) })),
                    ),
                  )}
                </div>
                {show("child_grade_levels") && <p className="text-xs text-[#C0392B] mt-1">{t.pickAtLeastOne}</p>}
              </div>
            </>
          )}

          {/* Optional */}
          <div>
            {label(t.heardFrom)}
            <input
              value={p.heard_from ?? ""}
              onChange={(e) => setP((s) => ({ ...s, heard_from: e.target.value }))}
              placeholder={t.optional}
              className="field w-full h-11 px-3 text-[#14181F]"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
          {attempted && !ready && !error && (
            <p className="text-sm text-[#C0392B]">{t.completeRequired}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            aria-disabled={!ready || submitting}
            className={`btn-primary w-full h-11 ${!ready ? "opacity-60" : ""}`}
          >
            {submitting ? t.settingUp : t.continue}
          </button>
        </form>
      </div>
    </main>
  );
}
