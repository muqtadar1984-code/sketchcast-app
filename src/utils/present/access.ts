// Who may drive a board.
//
// THE GATE CHANGED MECHANISM ON 2026-08-29, not just value. It was an operator
// allowlist of one address — right for proving a feature in front of a real
// class, wrong for a cohort, because an allowlist has no notion of plan, school
// or trial. docs/PRESENT-MODE.md said the step after "my ID" would be a plan
// gate; this is it. Founder's rule, verbatim: "this board needs to be provided
// to every teacher, regardless of school affiliation or not. the only gate for
// individual teachers should be pro or pro+ subscription. schools get this by
// default."
//
// Three things follow, and the second and third are the ones that are easy to
// get wrong.
//
// 1. THE PLAN DECIDES, AND plan_tier() IS THE PLAN. The taxonomy already exists
//    in one place — a SECURITY DEFINER function that resolves a school plan held
//    by the school, a personal plan held by the buyer, the launch promo and the
//    trial, in that precedence. Re-deriving any of that in TypeScript would be a
//    second copy to drift; this module takes its answer.
//
// 2. "SCHOOLS GET THIS BY DEFAULT" MEANS THE SCHOOL'S PLAN, NOT THE SCHOOL FIELD.
//    plan_tier returns 'school' only when the account's school holds an ACTIVE
//    school entitlement. A profiles.school_id with nothing paid behind it is a
//    person who was invited to a school, not a customer — and reading it as
//    entitlement would hand the board to 38 accounts nobody has billed.
//
// 3. A PLAN IS NOT A ROLE. plan_tier('school') is returned for EVERY member of a
//    paying school, students included — it answers "what is bought for this
//    account", which is a different question from "may this account teach". A
//    student on a school plan must never drive the board, so the role check is
//    not belt-and-braces here; it is the only thing standing between a paid
//    school and its own pupils opening the teacher's whiteboard.
//
// PURE. Facts in, verdict out. The fetching is entitlement.ts, and the split is
// what lets every branch of this be a test rather than a hope.

/**
 * Plans that carry the board. `pro_plus` is the paid differentiator elsewhere
 * (the AI Tutor); the board is deliberately wider — a Pro teacher standing at a
 * panel is exactly the person this was built for.
 *
 * ⚠️ THIS SET MUST BE REVISITED WHEN plan_tier() GAINS A TIER. The approved
 * school self-serve registration plan adds `school_trial` (a 30-day school
 * trial) and `school_expired` to that function. An unknown tier fails CLOSED
 * here, which is the right default and also the silent one: the day trial
 * schools exist, they will not get the board and nothing will say why. The
 * intended answer is almost certainly `school_trial` in, `school_expired` out —
 * a board is exactly what you demonstrate to sell a school plan — but that is a
 * product decision, not one to make by leaving a set alone.
 */
export const PRESENT_TIERS: ReadonlySet<string> = new Set(["school", "pro", "pro_plus"]);

/**
 * Who may never drive a board, whatever the plan pays for.
 *
 * Deliberately a DENY list rather than an allow list of teaching roles, because
 * "coordinator" is a scope grant and not a role in this schema — a real
 * coordinator's profiles.role is 'teacher', so an allow list of role names would
 * silently exclude them. What is knowable and stable is who does NOT teach.
 */
export const NON_TEACHING_ROLES: ReadonlySet<string> = new Set(["student", "parent"]);

export type PresentFacts = {
  /** profiles.role. Null when the profile could not be read — treated as "not a
   *  teacher", because an unknown role is not a permission. */
  role: string | null;
  /** public.plan_tier(uid): 'school' | 'pro_plus' | 'pro' | 'homeschool' |
   *  'family' | 'promo' | 'trial'. Null when it could not be resolved. */
  tier: string | null;
  /** PRESENT_ALLOWED_EMAILS — the staff override, independent of any plan. */
  override: boolean;
};

export type PresentVerdict =
  | { ok: true; via: "override" | "school" | "plan" }
  | { ok: false; why: "not-teaching" | "plan" };

/**
 * The decision.
 *
 * The override comes FIRST and is absolute: it is how staff reach the board on a
 * trial account, and how the founder tests a feature nobody has bought yet. It
 * cannot be abused by a student because a student cannot satisfy it — the
 * allowlist requires a confirmed email address and student accounts have no
 * email at all (they sign in with an ID).
 */
export function presentAccess(f: PresentFacts): PresentVerdict {
  if (f.override) return { ok: true, via: "override" };
  if (!f.role || NON_TEACHING_ROLES.has(f.role)) return { ok: false, why: "not-teaching" };
  if (f.tier === "school") return { ok: true, via: "school" };
  if (f.tier && PRESENT_TIERS.has(f.tier)) return { ok: true, via: "plan" };
  return { ok: false, why: "plan" };
}

// The sentence for a refusal lives in `present.gate.<why>`, not here — the page
// that renders it resolves the dictionary, and this module stays pure.
