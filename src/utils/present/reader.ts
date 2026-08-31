import "server-only";
import type { createAdminClient } from "@/utils/supabase/admin";
import { presentAllowed } from "@/utils/flags";
import type { RecapReader } from "./audience";

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
 * Is the LESSON'S AUTHOR allowed to run Present mode?
 *
 * The allowlist is checked against the teacher, never against the reader — a
 * student is never on it and must never need to be. The address lives in
 * auth.users rather than profiles, so this goes through the admin auth API; a
 * failure there is a refusal, not an exception, because the alternative to
 * "cannot confirm the author" is not "assume yes".
 */
export async function authorAllowed(admin: Admin, teacherId: string): Promise<boolean> {
  try {
    const { data, error } = await admin.auth.admin.getUserById(teacherId);
    if (error || !data?.user) return false;
    return presentAllowed({
      email: data.user.email ?? null,
      email_confirmed_at: data.user.email_confirmed_at ?? null,
    });
  } catch {
    return false;
  }
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
