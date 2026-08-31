import "server-only";
import type { createAdminClient } from "@/utils/supabase/admin";
import type { RecapReader } from "./audience";
import { presentEntitled } from "./entitlement";

// The three facts mayReadRecap() needs, fetched.
//
// READ THROUGH THE SERVICE ROLE, DELIBERATELY. 0097 revokes every present_*
// table from `authenticated` and 0099 keeps it that way, because a SELECT policy
// is a row filter and recap_DRAFT sits in the same row as recap_body. So the
// grant that would let a student read the published note would also hand them
// the sentence the teacher deleted.
//
// The price of that decision is this file: every check RLS would have done has
// to be done here instead, and it has to be done against the RIGHT identity.
// The RLS helpers cannot be reused — leader_of_school(), enrolled_in_class() and
// friends all resolve auth.uid(), which under the service role is nobody. They
// are re-expressed here as explicit queries about a named user, and that
// difference is the whole reason this is a separate, boring, readable file
// rather than three clever inline joins.

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Is the LESSON'S AUTHOR entitled to Present mode?
 *
 * Asked about the TEACHER, never about the reader — a student is on no plan of
 * their own and must never need to be. Exactly the shape the AI Tutor uses,
 * where the entitlement belongs to the lesson's owner rather than to the student
 * asking the question.
 *
 * IT IS ASKED AT READ TIME, WHICH MEANS A LAPSED PLAN TAKES THE NOTES WITH IT.
 * That is the intended behaviour rather than an accident: a teacher who stops
 * paying stops publishing to her class, and notes that outlived the plan would
 * be a surface nobody could turn off. It is also why this is a question about
 * entitlement and not about a row — there is no per-note flag to go stale.
 */
export async function authorAllowed(admin: Admin, teacherId: string): Promise<boolean> {
  return (await presentEntitled(admin, teacherId)).ok;
}

/**
 * Everything about the reader that bears on the decision.
 *
 * `schoolId` is the SESSION's school, not the reader's — leadership is a
 * relationship to a particular school, and asking "does this reader lead any
 * school" would let a principal of one school read another's lessons.
 */
export async function readerFacts(
  admin: Admin,
  userId: string,
  schoolId: string | null,
): Promise<RecapReader> {
  // (1) Classes this account is enrolled in as a student.
  const { data: mine } = await admin
    .from("enrollments")
    .select("class_id")
    .eq("student_id", userId);
  const enrolledClassIds = (mine ?? []).map((r) => r.class_id as string);

  // (2) Classes a VERIFIED child is enrolled in. An unverified parent link is a
  //     claim, not a relationship — 0018's rule, and the reason `verified_at` is
  //     a column rather than a boolean nobody sets.
  const { data: links } = await admin
    .from("parent_links")
    .select("child_id")
    .eq("parent_id", userId)
    .not("verified_at", "is", null);
  const childIds = (links ?? []).map((l) => l.child_id as string);
  let childClassIds: string[] = [];
  if (childIds.length) {
    const { data: theirs } = await admin
      .from("enrollments")
      .select("class_id")
      .in("student_id", childIds);
    childClassIds = (theirs ?? []).map((r) => r.class_id as string);
  }

  // (3) Leadership of THIS school. Mirrors leader_of_school() exactly — a
  //     school_admin of that school, or a coordinator whose scope names it —
  //     written out because the SQL helper resolves auth.uid(), which the
  //     service role does not have.
  let leadsSchool = false;
  if (schoolId) {
    const { data: prof } = await admin
      .from("profiles")
      .select("role, school_id")
      .eq("id", userId)
      .maybeSingle();
    const sameSchool = (prof?.school_id as string | null) === schoolId;
    if (sameSchool && prof?.role === "school_admin") {
      leadsSchool = true;
    } else if (sameSchool) {
      const { data: scope } = await admin
        .from("coordinator_scope")
        .select("coordinator_id")
        .eq("coordinator_id", userId)
        .eq("school_id", schoolId)
        .limit(1);
      leadsSchool = !!scope?.length;
    }
  }

  return {
    userId,
    enrolledClassIds: [...new Set(enrolledClassIds)],
    childClassIds: [...new Set(childClassIds)],
    leadsSchool,
  };
}
