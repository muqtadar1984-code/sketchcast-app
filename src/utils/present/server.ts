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
  school_id: string | null;
  class_id: string | null;
  subject: string | null;
  book_id: string | null;
  chapter_num: number | null;
  part: number | null;
  started_at: string | null;
  ended_at: string | null;
  page_count: number | null;
  pdf_path: string | null;
  recap_draft: string | null;
  recap_body: string | null;
  recap_published_at: string | null;
};

const SESSION_COLUMNS =
  "id, teacher_id, school_id, class_id, subject, book_id, chapter_num, part, started_at, ended_at, page_count, pdf_path, recap_draft, recap_body, recap_published_at";

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
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .maybeSingle();
  const row = (data ?? null) as SessionRow | null;
  return row && row.teacher_id === c.userId ? row : null;
}

/**
 * A session by id, WITHOUT the ownership check — for the read path, where the
 * reader is deliberately not the owner.
 *
 * Separate from ownedSession() on purpose. The two differ by one line and mean
 * opposite things, and a boolean parameter on one function is how a write path
 * eventually gets called with `false`. Everything that calls this must apply
 * mayReadRecap() to what it gets back; nothing that writes may call it at all.
 */
export async function sessionById(
  admin: ReturnType<typeof createAdminClient>,
  sessionId: string,
): Promise<SessionRow | null> {
  if (!sessionId) return null;
  const { data } = await admin
    .from("present_sessions")
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .maybeSingle();
  return (data ?? null) as SessionRow | null;
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
