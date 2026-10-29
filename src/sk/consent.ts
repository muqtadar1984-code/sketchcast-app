// SK S6 slice A — consent (Final Plan §8.1, §9.5; S6 design decisions 2–4).
// Server only: it is handed the service-role client for reads the student's
// own session cannot make (another user's consent rows, the school's config).
//
// WHO CONSENTS FOR A CHILD (decision 2) — one switch is enough:
//   * a home learner: an ACTIVE `consents` row (revoked_at null) for the scope
//     from a guardian who is a VERIFIED linked parent (parent_links.verified_at
//     set) — written only by the 0173 RPC sk_set_consent;
//   * a school learner: the school's switch, schools.config.sk_learning_memory
//     = true, under the school's data agreement.
//
// WHAT IT CONTROLS (decision 3): SK learning facts and SK tutor history need
// `transcripts`; Transcribe for a student needs `voice` (slice B). Without it
// the tutor still works, but nothing is kept beyond the turn. Educational
// records (item_attempts, mastery) follow their existing rules (§9.5) and are
// NOT gated here. Ask Coach (assistant_messages) is NOT gated (decision 4).
//
// Every read FAILS CLOSED: an error or a missing row is "no consent".

import { consentAllows, type Consent } from "./access";

export type ConsentScope = Consent["scope"];
export const CONSENT_SCOPES: readonly ConsentScope[] = ["voice", "transcripts", "analytics"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The slice of the supabase-js client these reads use. */
export type ConsentDb = { from: (table: string) => any };
/** The slice of the SESSION client the RPC wrapper uses. */
export type RpcDb = { rpc: (fn: string, args: Record<string, unknown>) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

type Row = Record<string, unknown>;

function rowsOf(r: unknown, what: string): Row[] {
  const x = r as { data?: unknown; error?: { message?: string } | null } | null;
  if (x?.error) throw new Error(`[sk consent] ${what} read failed: ${x.error.message ?? "error"}`);
  return Array.isArray(x?.data) ? (x!.data as Row[]) : x?.data ? [x.data as Row] : [];
}

/** The student's role and school, or null when the profile cannot be read. */
async function profileOf(admin: ConsentDb, userId: string): Promise<{ role: string | null; schoolId: string | null } | null> {
  const p = rowsOf(await admin.from("profiles").select("role, school_id").eq("id", userId).maybeSingle(), "profile")[0];
  if (!p) return null;
  return { role: typeof p.role === "string" ? p.role : null, schoolId: typeof p.school_id === "string" && p.school_id ? p.school_id : null };
}

/** Does the school hold SK learning memory under its data agreement? */
async function schoolSwitchOn(admin: ConsentDb, schoolId: string | null): Promise<boolean> {
  if (!schoolId) return false;
  const s = rowsOf(await admin.from("schools").select("config").eq("id", schoolId).maybeSingle(), "school")[0];
  const cfg = (s?.config ?? null) as { sk_learning_memory?: unknown } | null;
  return cfg?.sk_learning_memory === true;
}

/** An active consent row for the scope from a VERIFIED linked guardian. */
async function guardianConsent(admin: ConsentDb, studentId: string, scope: ConsentScope): Promise<boolean> {
  const rows = rowsOf(await admin.from("consents").select("guardian_id, scope, revoked_at").eq("child_id", studentId).eq("scope", scope), "consents");
  const guardians = [...new Set(rows.filter((r) => r.scope === scope && !r.revoked_at && typeof r.guardian_id === "string").map((r) => r.guardian_id as string))];
  if (!guardians.length) return false;
  const links = rowsOf(await admin.from("parent_links").select("parent_id, child_id, verified_at").eq("child_id", studentId).in("parent_id", guardians), "parent_links");
  return links.some((l) => l.child_id === studentId && guardians.includes(l.parent_id as string) && typeof l.verified_at === "string" && !!l.verified_at);
}

/**
 * Has `studentId` got consent for `scope`? True when an active consent row
 * from a verified guardian exists, OR the student's school has switched SK
 * learning memory on (decision 2). Any failure → false.
 */
export async function hasConsent(admin: ConsentDb, studentId: string, scope: ConsentScope): Promise<boolean> {
  if (!UUID_RE.test(studentId) || !CONSENT_SCOPES.includes(scope)) return false;
  try {
    if (await guardianConsent(admin, studentId, scope)) return true;
    const p = await profileOf(admin, studentId);
    return p ? await schoolSwitchOn(admin, p.schoolId) : false;
  } catch (e) {
    console.error((e as Error).message);
    return false;
  }
}

/**
 * May SK KEEP memory for this user under `scope`? The rule of consentAllows
 * (access.ts): an adult needs no one's consent for their own memory; a
 * STUDENT needs hasConsent. An unreadable profile keeps nothing.
 */
export async function memoryAllowed(admin: ConsentDb, userId: string, scope: ConsentScope): Promise<boolean> {
  if (!UUID_RE.test(userId)) return false;
  let role: string | null;
  try {
    const p = await profileOf(admin, userId);
    if (!p || !p.role) return false;
    role = p.role;
  } catch (e) {
    console.error((e as Error).message);
    return false;
  }
  if (role !== "student") return consentAllows(scope, role, []);
  return hasConsent(admin, userId, scope);
}

export type SetConsentResult =
  | { ok: true; consent: { childId: string; scope: ConsentScope; grantedAt: string | null; revokedAt: string | null } | null }
  | { ok: false; reason: "bad_input" | "not_parent" | "error" };

/**
 * A parent grants or revokes a scope for their child through the 0173 RPC,
 * on the parent's OWN session client: the database checks the verified link
 * (auth.uid() is the guardian; nothing here can name another guardian).
 */
export async function setConsent(session: RpcDb, childId: string, scope: string, grant: boolean): Promise<SetConsentResult> {
  if (!UUID_RE.test(childId) || !CONSENT_SCOPES.includes(scope as ConsentScope) || typeof grant !== "boolean") return { ok: false, reason: "bad_input" };
  const { data, error } = ((await session.rpc("sk_set_consent", { p_child: childId, p_scope: scope, p_grant: grant })) ?? {}) as {
    data?: Row | null;
    error?: { code?: string; message?: string } | null;
  };
  if (error) {
    if (error.code === "42501") return { ok: false, reason: "not_parent" };
    if (error.code === "22023") return { ok: false, reason: "bad_input" };
    console.error("[sk consent] sk_set_consent failed:", error.message);
    return { ok: false, reason: "error" };
  }
  const row = data && typeof data === "object" && typeof data.child_id === "string" ? data : null;
  return {
    ok: true,
    consent: row
      ? { childId: row.child_id as string, scope: row.scope as ConsentScope, grantedAt: (row.granted_at as string) ?? null, revokedAt: (row.revoked_at as string) ?? null }
      : null,
  };
}
