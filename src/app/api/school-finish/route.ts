import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { countryFromHeaders } from "@/utils/geo";

export const runtime = "nodejs";

// Finalize "Set up your school": create a NEW school with a 30-day trial and
// make the signed-in user its school_admin (migration 0100). Self-serve is SAFE
// here because the school is brand-new and empty — the admin only ever sees
// their own school's data (not a claim over an existing school's students).
//
// The route does only what a route can — read the session and the request
// headers, shape the body — and hands everything to finish_school_registration(),
// which is one transaction and idempotent: a retried or timed-out submit
// returns the school it already made rather than minting a second one.

/** Machine strings raised by finish_school_registration(), mapped to copy. */
const FUNCTION_ERRORS: Record<string, { status: number; error: string }> = {
  email_not_confirmed: {
    status: 403,
    error: "Please confirm your email address first — open the link we sent you, then try again.",
  },
  name_too_short: { status: 400, error: "Please enter your school's name." },
  no_profile: { status: 400, error: "Your account isn't ready yet. Please sign in again." },
};

const clip = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};

type Body = {
  schoolName?: string;
  country?: string;
  meta?: { school_type?: unknown; size_band?: unknown; curricula?: unknown };
  registration?: { registrant_role?: unknown; phone?: unknown; heard_from?: unknown };
};

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const schoolName = (body.schoolName ?? "").trim();
  if (schoolName.length < 2) {
    return NextResponse.json({ error: FUNCTION_ERRORS.name_too_short.error }, { status: 400 });
  }

  // Country: the form's answer when it gives one (a valid alpha-2), else the
  // CDN's edge header — the same assumption /signup makes.
  const claimed = (body.country ?? "").trim().toUpperCase();
  const country = /^[A-Z]{2}$/.test(claimed) ? claimed : countryFromHeaders(request.headers);

  // The registrant's IP goes to the console-only registrations table, for the
  // "same address, several trials" flag. Vercel sets x-real-ip; the forwarded
  // chain's first hop is the fallback.
  const regIp =
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;

  const curricula = Array.isArray(body.meta?.curricula)
    ? body.meta!.curricula.map((c) => clip(c, 40)).filter((c): c is string => !!c).slice(0, 10)
    : [];

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const { data, error } = await admin.rpc("finish_school_registration", {
    p_user: user.id,
    p_name: schoolName,
    p_country: country,
    p_meta: {
      school_type: clip(body.meta?.school_type, 40),
      size_band: clip(body.meta?.size_band, 20),
      curricula,
    },
    p_registration: {
      registrant_role: clip(body.registration?.registrant_role, 40),
      phone: clip(body.registration?.phone, 40),
      heard_from: clip(body.registration?.heard_from, 80),
      reg_ip: regIp,
    },
  });

  if (error) {
    const known = FUNCTION_ERRORS[error.message];
    if (known) return NextResponse.json({ error: known.error }, { status: known.status });
    console.error("school-finish.rpc_failed", { user: user.id, err: error.message });
    return NextResponse.json({ error: "Could not create the school." }, { status: 500 });
  }

  const result = (data ?? {}) as { school_id?: string; slug?: string; created?: boolean };
  return NextResponse.json({ ok: true, slug: result.slug ?? null, created: result.created === true });
}
