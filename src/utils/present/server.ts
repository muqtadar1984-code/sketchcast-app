import "server-only";
import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { presentAllowed } from "@/utils/flags";

// What every /api/present/* route needs before it does anything.
//
// 404 ON EVERY REFUSAL, never 403. Present mode is unreleased and restricted to
// a named account; a 403 tells anyone probing the app that the surface exists
// and that they merely lack permission. Not signed in, not on the allowlist, not
// your session — all the same reply.

export const NOT_FOUND = () => NextResponse.json({ error: "Not found." }, { status: 404 });

export type Caller = {
  userId: string;
  admin: ReturnType<typeof createAdminClient>;
};

/**
 * The signed-in, allowlisted caller, or null.
 *
 * The service role is handed back with them because every present_* table is
 * revoked from `authenticated` — the routes are the only write path, which is
 * what makes their checks structural rather than a convention.
 */
export async function caller(): Promise<Caller | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !presentAllowed(user)) return null;
  try {
    return { userId: user.id, admin: createAdminClient() };
  } catch {
    return null;
  }
}

export type SessionRow = {
  id: string;
  teacher_id: string;
  class_id: string | null;
  subject: string | null;
  book_id: string | null;
  chapter_num: number | null;
  part: number | null;
  ended_at: string | null;
};

/**
 * A session the caller actually owns.
 *
 * CHECKED ON EVERY WRITE, not just at start. The service role bypasses RLS, so
 * without this a caller who is on the allowlist could append strokes to somebody
 * else's lesson simply by knowing an id. The allowlist is one person today,
 * which is exactly why this is easy to leave out and expensive to add later.
 */
export async function ownedSession(c: Caller, sessionId: string): Promise<SessionRow | null> {
  if (!sessionId) return null;
  const { data } = await c.admin
    .from("present_sessions")
    .select("id, teacher_id, class_id, subject, book_id, chapter_num, part, ended_at")
    .eq("id", sessionId)
    .maybeSingle();
  const row = (data ?? null) as SessionRow | null;
  return row && row.teacher_id === c.userId ? row : null;
}

/** Parse a JSON body, refusing anything that is valid JSON but not an object —
 *  `null`, `7` and `"x"` all parse, and all of them throw on the first property
 *  read, turning an intended 400 into a 500. */
export async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
