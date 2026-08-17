// Shared, pure onboarding logic — imported by the client form (to disable
// "Continue"), the server route (to reject a bypass), and the tests. No React,
// no DB. The option lists are placeholders the team can refine.

import { isCountryCode } from "@/utils/countries";

export type OnboardingRole = "teacher" | "parent";

export const GRADE_OPTIONS = [
  "Early years / Kindergarten",
  "Grades 1–3",
  "Grades 4–6",
  "Grades 7–9",
  "Grades 10–12",
] as const;

export const SUBJECT_OPTIONS = [
  "Mathematics",
  "Science",
  "English",
  "Computing / ICT",
  "Social studies",
  "Languages",
  "Arts",
  "Other",
] as const;

export const AFFILIATIONS = [
  { value: "school", label: "I teach at a school" },
  { value: "independent", label: "Independent teacher / tutor" },
  { value: "homeschool", label: "Homeschool educator" },
] as const;

export type OnboardingProfile = {
  /** ISO 3166-1 alpha-2 code (src/utils/countries.ts) — REQUIRED since 0085;
   * also written to profiles.country with country_source='signup'. */
  country?: string;
  heard_from?: string;
  // teacher
  affiliation?: "school" | "independent" | "homeschool";
  school_name?: string;
  title?: string;
  grade_levels?: string[];
  subjects?: string[];
  // parent
  children_count?: number;
  child_grade_levels?: string[];
  school_on_platform?: string;
};

/** The role the toggle defaults to, seeded from the signup pick. Only teacher /
 * parent are self-selectable here (school admins come via the school-setup flow);
 * anything else seeds teacher. */
export function seedRole(role: string | null | undefined): OnboardingRole {
  return role === "parent" ? "parent" : "teacher";
}

/** Required fields still missing for (role, full name, profile). PURE — the same
 * check runs on the client (disable Continue) and the server (reject a bypass);
 * an empty array means ready to submit. */
export function missingRequired(
  role: OnboardingRole,
  fullName: string,
  p: OnboardingProfile,
): string[] {
  const m: string[] = [];
  if (!fullName || !fullName.trim()) m.push("full_name");
  // Country is required for BOTH roles, and must be a real assigned alpha-2
  // code — the select only offers real codes, so anything else is a bypass.
  // No default: the user must actively choose (an unchosen select posts "").
  if (!isCountryCode(p.country)) m.push("country");
  if (role !== "teacher" && role !== "parent") {
    m.push("role");
    return m; // no point checking role-specific fields for an invalid role
  }
  if (role === "teacher") {
    if (!p.affiliation) m.push("affiliation");
    if (p.affiliation === "school" && !(p.school_name && p.school_name.trim())) m.push("school_name");
    if (!(p.grade_levels && p.grade_levels.length)) m.push("grade_levels");
    if (!(p.subjects && p.subjects.length)) m.push("subjects");
  } else {
    if (!p.children_count || p.children_count < 1) m.push("children_count");
    if (!(p.child_grade_levels && p.child_grade_levels.length)) m.push("child_grade_levels");
  }
  return m;
}

/** Where to send the user after onboarding, by their confirmed role. */
export function homeForRole(role: OnboardingRole): string {
  return role === "parent" ? "/dashboard/children" : "/dashboard";
}
