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

// The new-joiner profile form. The role toggle is SEEDED from the signup pick but
// the user confirms (or corrects) it here. "Continue" stays disabled until every
// mandatory field for the chosen role is filled — the exact same missingRequired()
// the server re-checks, so the client gate and the server gate never disagree.
export default function OnboardingForm({
  seedRole,
  initialName,
}: {
  seedRole: OnboardingRole;
  initialName: string;
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
      const data = (await res.json().catch(() => ({}))) as { error?: string; role?: OnboardingRole };
      if (!res.ok) {
        setError(data.error ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }
      // Land on the confirmed role's home. A hard replace + refresh so the server
      // layout re-reads the now-onboarded profile (no bounce back here).
      router.replace(homeForRole(data.role ?? role));
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
      setSubmitting(false);
    }
  }

  const roleBtn = (r: OnboardingRole, label: string, sub: string) => (
    <button
      key={r}
      type="button"
      onClick={() => setRole(r)}
      aria-pressed={role === r}
      className={`flex-1 rounded-xl border p-4 text-left transition ${
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

  const chip = (value: string, selected: boolean, onClick: () => void) => (
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
      {value}
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
          <h1 className="text-2xl">Welcome — let&apos;s set you up</h1>
        </div>
        <p className="text-sm text-[#5B6470] mt-1 mb-6">
          A couple of quick questions so SketchCast fits how you&apos;ll use it. You can change these later.
        </p>

        <form onSubmit={onSubmit} className="space-y-6">
          {/* Role */}
          <div>
            {label("I'm here as a…", true)}
            <div className="flex gap-3">
              {roleBtn("teacher", "Teacher", "Create lessons & teach classes")}
              {roleBtn("parent", "Parent", "Support my child's learning")}
            </div>
          </div>

          {/* Name */}
          <div>
            {label("Your full name", true)}
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Alex Morgan"
              className={`field w-full h-11 px-3 text-[#14181F] ${show("full_name") ? "border-[#C0392B]" : ""}`}
            />
          </div>

          {role === "teacher" ? (
            <>
              {/* Affiliation */}
              <div>
                {label("Where do you teach?", true)}
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
                      <span className="text-sm text-[#14181F]">{a.label}</span>
                    </label>
                  ))}
                </div>
                {show("affiliation") && <p className="text-xs text-[#C0392B] mt-1">Please pick one.</p>}
              </div>

              {p.affiliation === "school" && (
                <div>
                  {label("School name", true)}
                  <input
                    value={p.school_name ?? ""}
                    onChange={(e) => setP((s) => ({ ...s, school_name: e.target.value }))}
                    placeholder="e.g. Riverside Secondary"
                    className={`field w-full h-11 px-3 text-[#14181F] ${show("school_name") ? "border-[#C0392B]" : ""}`}
                  />
                </div>
              )}

              <div>
                {label("Grade levels you teach", true)}
                <div className="flex flex-wrap gap-2">
                  {GRADE_OPTIONS.map((g) =>
                    chip(g, (p.grade_levels ?? []).includes(g), () =>
                      setP((s) => ({ ...s, grade_levels: toggleIn(s.grade_levels, g) })),
                    ),
                  )}
                </div>
                {show("grade_levels") && <p className="text-xs text-[#C0392B] mt-1">Pick at least one.</p>}
              </div>

              <div>
                {label("Subjects you teach", true)}
                <div className="flex flex-wrap gap-2">
                  {SUBJECT_OPTIONS.map((sub) =>
                    chip(sub, (p.subjects ?? []).includes(sub), () =>
                      setP((s) => ({ ...s, subjects: toggleIn(s.subjects, sub) })),
                    ),
                  )}
                </div>
                {show("subjects") && <p className="text-xs text-[#C0392B] mt-1">Pick at least one.</p>}
              </div>
            </>
          ) : (
            <>
              <div>
                {label("How many children will you support?", true)}
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
                  placeholder="e.g. 2"
                  className={`field w-full h-11 px-3 text-[#14181F] ${show("children_count") ? "border-[#C0392B]" : ""}`}
                />
              </div>

              <div>
                {label("Your children's grade levels", true)}
                <div className="flex flex-wrap gap-2">
                  {GRADE_OPTIONS.map((g) =>
                    chip(g, (p.child_grade_levels ?? []).includes(g), () =>
                      setP((s) => ({ ...s, child_grade_levels: toggleIn(s.child_grade_levels, g) })),
                    ),
                  )}
                </div>
                {show("child_grade_levels") && <p className="text-xs text-[#C0392B] mt-1">Pick at least one.</p>}
              </div>
            </>
          )}

          {/* Optional */}
          <div>
            {label("How did you hear about us?")}
            <input
              value={p.heard_from ?? ""}
              onChange={(e) => setP((s) => ({ ...s, heard_from: e.target.value }))}
              placeholder="Optional"
              className="field w-full h-11 px-3 text-[#14181F]"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
          {attempted && !ready && !error && (
            <p className="text-sm text-[#C0392B]">Please complete the required fields marked with *.</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            aria-disabled={!ready || submitting}
            className={`btn-primary w-full h-11 ${!ready ? "opacity-60" : ""}`}
          >
            {submitting ? "Setting up…" : "Continue"}
          </button>
        </form>
      </div>
    </main>
  );
}
