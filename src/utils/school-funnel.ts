// The school acquisition funnel (Phase 5 of self-serve registration) — PURE.
// Facts about each self-serve school go in; step counts, overall and by
// weekly cohort, come out. No event pipeline: every step is derived from
// tables that already exist (schools, auth.users, generations,
// school_registrations, entitlements). The page fetches; this decides.
//
// The question this answers is whether the school product converts
// commercially, not whether registration works technically — so the steps run
// all the way from "registered" to "paid", and the one KPI the trial is
// designed around (a lesson AND a document) has its own step.

export const STEPS = [
  "registered",
  "confirmed",
  "first_generation",
  "lesson_and_document",
  "returned",
  "activation_requested",
  "invoice_sent",
  "paid",
] as const;
export type Step = (typeof STEPS)[number];

export type FunnelSchool = {
  id: string;
  created_at: string;
  /** The registrant's auth.users.email_confirmed_at. */
  confirmed_at: string | null;
  /** The registrant's auth.users.last_sign_in_at — the "came back" proxy. */
  last_sign_in_at: string | null;
  first_generation_at: string | null;
  lessons_done: number;
  docs_done: number;
  activation_requested_at: string | null;
  invoice_sent: boolean;
  paid: boolean;
};

const DAY = 86400000;

/** Which steps this school has reached. Steps are not strictly ordered — a
 * school can be invoiced without ever generating — so each is judged on its
 * own fact, and the page reads the counts as "how many got here", not as a
 * strict pipeline. */
export function stepsReached(s: FunnelSchool): Set<Step> {
  const out = new Set<Step>(["registered"]);
  if (s.confirmed_at) out.add("confirmed");
  if (s.first_generation_at) out.add("first_generation");
  if (s.lessons_done > 0 && s.docs_done > 0) out.add("lesson_and_document");
  // "Returned": signed in again at least a day after creating the school. The
  // last sign-in is the only session fact auth exposes without an events
  // table, so a school that returned twice on day 1 and never again reads as
  // not-returned — the proxy under-counts, never over-counts.
  if (s.last_sign_in_at && new Date(s.last_sign_in_at).getTime() >= new Date(s.created_at).getTime() + DAY) {
    out.add("returned");
  }
  if (s.activation_requested_at) out.add("activation_requested");
  if (s.invoice_sent || s.paid) out.add("invoice_sent");
  if (s.paid) out.add("paid");
  return out;
}

/** The Monday (UTC) that starts the ISO week containing `iso`, as YYYY-MM-DD. */
export function cohortWeek(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

export type StepCounts = Record<Step, number>;
export type Cohort = { week: string; size: number; counts: StepCounts };
export type Funnel = { total: StepCounts; cohorts: Cohort[] };

const zero = (): StepCounts => Object.fromEntries(STEPS.map((s) => [s, 0])) as StepCounts;

/** Overall counts plus weekly cohorts, newest week first. */
export function buildFunnel(schools: FunnelSchool[]): Funnel {
  const total = zero();
  const byWeek = new Map<string, StepCounts>();
  for (const s of schools) {
    const reached = stepsReached(s);
    const week = cohortWeek(s.created_at);
    const counts = byWeek.get(week) ?? zero();
    for (const step of reached) {
      total[step]++;
      counts[step]++;
    }
    byWeek.set(week, counts);
  }
  const cohorts = [...byWeek.entries()]
    .map(([week, counts]) => ({ week, size: counts.registered, counts }))
    .sort((a, b) => (a.week < b.week ? 1 : a.week > b.week ? -1 : 0));
  return { total, cohorts };
}

/** "n of registered" as a whole percentage; null when nothing registered. */
export function pct(n: number, of: number): number | null {
  return of > 0 ? Math.round((n / of) * 100) : null;
}
