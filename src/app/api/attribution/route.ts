import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isPlausibleSource, SOURCE_COOKIE } from "@/utils/attribution";

export const runtime = "nodejs";

// Writes profiles.signup_source ONCE, for the caller's own account.
//
// SERVICE ROLE, deliberately: signup_source is not granted to `authenticated`,
// because it is something we observed rather than something the user is
// stating about themselves. Routing the write through here is what stops an
// account rewriting its own provenance — the same posture as role in
// /api/onboarding, and the opposite of country, which the user DOES assert and
// therefore writes through their own session.
//
// FIRST WRITE WINS. The client posts at most once per browser, but a user with
// two browsers would otherwise have their origin overwritten by whichever they
// opened second — and the second one is by definition not the first touch.

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Not an error: the capture component fires on public pages too, and simply
  // tries again on a later page once a session exists.
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  // The COOKIE is the trusted copy, not the body. The body is accepted only as
  // a fallback for the first page load, where the cookie was written moments
  // ago in the same tick and may not be on the request yet.
  const cookieSrc = request.headers
    .get("cookie")
    ?.split("; ")
    .find((c) => c.startsWith(`${SOURCE_COOKIE}=`))
    ?.slice(SOURCE_COOKIE.length + 1);

  let bodySrc: unknown = null;
  try {
    bodySrc = ((await request.json()) as { source?: unknown })?.source ?? null;
  } catch {
    // No body / malformed — the cookie path below still works.
  }

  const raw = decodeURIComponent(cookieSrc ?? "") || (typeof bodySrc === "string" ? bodySrc : "");
  // Anything that is not a shape we produce is dropped rather than stored, so a
  // hand-edited cookie cannot put free text on a profile.
  if (!isPlausibleSource(raw)) return NextResponse.json({ ok: false }, { status: 400 });

  const db = createAdminClient();

  const { data: existing, error: readErr } = await db
    .from("profiles")
    .select("signup_source")
    .eq("id", user.id)
    .maybeSingle();
  if (readErr) {
    // Pre-0094 database (42703). The account is fine; provenance just isn't
    // recorded yet. Never surface this to the user.
    console.error("attribution.read:", readErr.code, readErr.message);
    return NextResponse.json({ ok: false }, { status: 200 });
  }
  // Already known — report success so the client stops asking.
  if ((existing as { signup_source?: string | null } | null)?.signup_source) {
    return NextResponse.json({ ok: true, already: true });
  }

  const { error: writeErr } = await db
    .from("profiles")
    .update({ signup_source: raw })
    .eq("id", user.id)
    .is("signup_source", null); // first write wins, enforced in the statement
  if (writeErr) {
    console.error("attribution.write:", writeErr.code, writeErr.message);
    return NextResponse.json({ ok: false }, { status: 200 });
  }

  return NextResponse.json({ ok: true });
}
