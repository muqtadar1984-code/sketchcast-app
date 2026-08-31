import "server-only";
import type { createAdminClient } from "@/utils/supabase/admin";
import { presentAllowed, type PresentGateUser } from "@/utils/flags";
import { presentAccess, type PresentVerdict } from "./access";

// Fetching the three facts presentAccess() decides on.
//
// THROUGH THE SERVICE ROLE, AND NOT BY CHOICE. `public.plan_tier(uuid)` carries
// EXECUTE for service_role only — `authenticated` and `anon` were never granted
// it, because it is a policy helper rather than an API. So the plan cannot be
// resolved from a member session, and every gate that consults it needs the
// admin client.
//
// WITHOUT THAT CLIENT THIS FAILS CLOSED, to the override and nothing else. A
// missing SUPABASE_SERVICE_ROLE_KEY is a deployment fault, and the safe reading
// of "I cannot tell what you have bought" is not "assume Pro".
//
// ONE GATE, EVERYWHERE. The page, caller() and the kit route all call this, so
// the sync path pays two light lookups per flush. That is deliberate: a second,
// cheaper gate for the "hot" routes would be a second answer to the same
// question, and the day they disagree is the day somebody keeps writing to a
// board their plan no longer carries.

type Admin = ReturnType<typeof createAdminClient>;

/**
 * May this account drive a board?
 *
 * `user` is optional only because two callers already hold the Supabase user and
 * a third (the recap read path, asking about somebody else) does not. When it is
 * omitted the address is looked up, because the override is an email check and
 * skipping it would quietly disable the staff override on that path.
 */
export async function presentEntitled(
  admin: Admin | null,
  userId: string,
  user?: PresentGateUser,
): Promise<PresentVerdict> {
  if (!userId) return { ok: false, why: "not-teaching" };

  // The override first and on its own, so it still works when everything below
  // is unavailable — which is exactly the state a deployment without a service
  // key is in, and exactly when staff need to get in and look.
  const identity = user ?? (await lookupUser(admin, userId));
  if (presentAllowed(identity)) return { ok: true, via: "override" };
  if (!admin) return { ok: false, why: "plan" };

  const [profile, tier] = await Promise.all([
    admin.from("profiles").select("role").eq("id", userId).maybeSingle(),
    admin.rpc("plan_tier", { uid: userId }),
  ]);

  if (tier.error) {
    // A blip is not an entitlement. Logged rather than swallowed: this is the
    // one failure that would look to a teacher exactly like "you did not pay".
    console.error("[present] plan_tier failed", tier.error.message);
  }

  return presentAccess({
    role: (profile.data?.role as string | null) ?? null,
    tier: typeof tier.data === "string" ? tier.data : null,
    override: false,
  });
}

async function lookupUser(admin: Admin | null, userId: string): Promise<PresentGateUser | null> {
  if (!admin) return null;
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error || !data?.user) return null;
    return {
      email: data.user.email ?? null,
      email_confirmed_at: data.user.email_confirmed_at ?? null,
    };
  } catch {
    return null;
  }
}
