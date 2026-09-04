import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { DECK_URL_TTL_SECONDS, resolveDeckWith, type DeckStore } from "../logic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/deck/{genId} — the STUDENT's download of an assigned deck
// (kind 'deck', migration 0103).
//
// The row that links here holds no signed URL: it holds this path, and the
// URL is minted HERE, on the click. See ../logic.ts for why — a client that
// holds an hour-long URL cannot tell how long it has been holding it once the
// router restores the row from cache, and it was that gap that let an expired
// link record the item complete and then fail at storage.
//
// Shaped after /api/quiz/[generationId], which made the same move for
// questions.json: session first, service role second, and the share checked
// by the same isAssignedToStudent before any storage path is read. The
// service role is needed for the signing itself — artifact files live under
// the ADULT's folder, so a student session cannot sign them; this handler and
// the student dashboard are the only doors, and both check the share first.
export async function GET(_request: Request, { params }: { params: Promise<{ genId: string }> }) {
  const { genId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Not signed in." }, 401);

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    // Never the underlying cause: that names our env vars to the internet.
    return json({ error: "Deck downloads are unavailable right now." }, 500);
  }

  const result = await resolveDeckWith(admin as unknown as DeckStore, user.id, genId);
  if (!result.ok) return json({ error: result.error }, result.status);

  const { data } = await admin.storage
    .from("artifacts")
    .createSignedUrl(result.path, DECK_URL_TTL_SECONDS, { download: result.filename });
  if (!data?.signedUrl) return json({ error: "Deck couldn't load — refresh the page" }, 502);

  // 302 to a URL that lives one minute. Never cached: the target expires, the
  // decision is per-student, and a cached redirect would outlive both.
  const res = NextResponse.redirect(data.signedUrl, 302);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/** Every refusal answers the same way: a sentence a child can read, no
 * caching, nothing about what does or does not exist beyond the status. */
function json(body: { error: string }, status: number) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
