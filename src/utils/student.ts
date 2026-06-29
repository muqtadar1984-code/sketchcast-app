// Invited students log in with a name-derived ID, not an email. Supabase auth
// needs a unique email per user (and siblings may share a parent email), so the
// ID is backed by a synthetic address under this domain. The parent's real email
// is stored separately on the profile for communication only.
export const STUDENT_EMAIL_DOMAIN = "students.sketchcast.app";

export function studentEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${STUDENT_EMAIL_DOMAIN}`;
}

// "Aisha", "Khan" -> "aisha.khan" (caller appends a numeric suffix on collision).
export function usernameBase(firstName: string, lastName: string): string {
  const clean = (s: string) =>
    s.normalize("NFKD").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const first = clean(firstName);
  const last = clean(lastName);
  return [first, last].filter(Boolean).join(".") || "student";
}
