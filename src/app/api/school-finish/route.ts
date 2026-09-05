import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { countryFromHeaders } from "@/utils/geo";
import { isCountryCode } from "@/utils/countries";
import { notifySchoolRegistration } from "@/utils/notify";
import { verifyTurnstile, hostnameOf } from "@/utils/turnstile";
import {
  SCHOOL_TYPES,
  SIZE_BANDS,
  REGISTRANT_ROLES,
  CURRICULA,
  TURNSTILE_ACTION,
  pickOption,
} from "@/utils/school-registration-options";

export const runtime = "nodejs";

// Finalize "Create your school's workspace": create a NEW school with a 30-day
// trial and make the signed-in user its school_admin (migration 0101).
// Self-serve is SAFE here because the school is brand-new and empty — the
// admin only ever sees their own school's data (not a claim over an existing
// school's students).
//
// The route does only what a route can — the session, the request headers,
// the Turnstile token, the per-network throttle, the shape of the body — and
// hands everything to finish_school_registration(), which is one transaction
// and idempotent: a retried or timed-out submit returns the school it already
// made rather than minting a second one.
//
// Errors carry a machine `code` beside the English `error` so the form can
// word the ones it has copy for (captcha, throttle) in the reader's language.

/** Machine strings raised by finish_school_registration(), mapped to copy. */
const FUNCTION_ERRORS: Record<string, { status: number; error: string }> = {
  email_not_confirmed: {
    status: 403,
    error: "Please confirm your email address first — open the link we sent you, then try again.",
  },
  name_too_short: { status: 400, error: "Please enter your school's name." },
  no_profile: { status: 400, error: "Your account isn't ready yet. Please sign in again." },
};

/** Schools one network address may register per day before we ask them to
 * talk to us. Three is generous for a real network (a district office setting
 * up several schools) and cheap for us either way — each is 14 generations. */
const SCHOOLS_PER_IP_PER_DAY = 3;

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
  turnstileToken?: string | null;
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

  // The registrant's network address: the per-day throttle below, Turnstile's
  // remoteip, and the console's "same address, several trials" flag. Vercel
  // sets x-real-ip; the forwarded chain's first hop is the fallback.
  const regIp =
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;

  // Bot check — dark until TURNSTILE_SECRET_KEY exists (utils/turnstile.ts).
  // The token must have been solved for THIS surface (action) on THIS host.
  const captcha = await verifyTurnstile(body.turnstileToken, regIp, {
    action: TURNSTILE_ACTION,
    hostname: hostnameOf(request.headers.get("host")),
  });
  if (!captcha.ok) {
    return NextResponse.json(
      { error: "Please complete the verification and try again.", code: "captcha" },
      { status: 400 },
    );
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  // Per-network throttle: schools actually created from this address today.
  // Counted on the private registrations table (service role), so the check
  // costs one indexed count and cannot be reset by deleting a school.
  if (regIp) {
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    const { count } = await admin
      .from("school_registrations")
      .select("school_id", { count: "exact", head: true })
      .eq("reg_ip", regIp)
      .gte("created_at", dayAgo);
    if ((count ?? 0) >= SCHOOLS_PER_IP_PER_DAY) {
      return NextResponse.json(
        {
          error: "Several schools were registered from this network today. Email sales@sketchcast.app and we'll set yours up.",
          code: "rate_limited",
        },
        { status: 429 },
      );
    }
  }

  // Country: the form's answer when it is a real alpha-2, else the CDN's edge
  // header — the same assumption /signup makes.
  const claimed = (body.country ?? "").trim().toUpperCase();
  const country = isCountryCode(claimed) ? claimed : countryFromHeaders(request.headers);

  // The form's vocabularies, validated against the same sets the form renders
  // from. Unknown values become null rather than an error: a stale tab from
  // before an option was renamed should still register the school.
  const schoolType = pickOption(body.meta?.school_type, SCHOOL_TYPES);
  const sizeBand = pickOption(body.meta?.size_band, SIZE_BANDS);
  const registrantRole = pickOption(body.registration?.registrant_role, REGISTRANT_ROLES);
  const curricula = Array.isArray(body.meta?.curricula)
    ? body.meta!.curricula.map((c) => pickOption(c, CURRICULA)).filter((c): c is (typeof CURRICULA)[number] => !!c).slice(0, 10)
    : [];

  const { data, error } = await admin.rpc("finish_school_registration", {
    p_user: user.id,
    p_name: schoolName,
    p_country: country,
    p_meta: { school_type: schoolType, size_band: sizeBand, curricula },
    p_registration: {
      registrant_role: registrantRole,
      phone: clip(body.registration?.phone, 40),
      heard_from: clip(body.registration?.heard_from, 80),
      reg_ip: regIp,
    },
  });

  if (error) {
    const known = FUNCTION_ERRORS[error.message];
    if (known) return NextResponse.json({ error: known.error, code: error.message }, { status: known.status });
    console.error("school-finish.rpc_failed", { user: user.id, err: error.message });
    return NextResponse.json({ error: "Could not create the school." }, { status: 500 });
  }

  const result = (data ?? {}) as { school_id?: string; slug?: string; created?: boolean };

  // Founder notification — only on the call that actually inserted the school
  // (a retry returns created=false), so it fires once per school.
  if (result.created === true && result.school_id) {
    const [{ data: school }, { data: me }] = await Promise.all([
      admin.from("schools").select("name, slug, country, trial_ends_at, meta").eq("id", result.school_id).maybeSingle(),
      admin.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
    ]);
    const meta = (school?.meta ?? {}) as { school_type?: string; size_band?: string; curricula?: string[] };
    await notifySchoolRegistration({
      schoolId: result.school_id,
      name: (school?.name as string) || schoolName,
      slug: (school?.slug as string) ?? result.slug ?? null,
      country: (school?.country as string) ?? country ?? null,
      registrantEmail: user.email ?? null,
      registrantName: (me?.full_name as string) ?? null,
      registrantRole,
      schoolType: meta.school_type ?? null,
      sizeBand: meta.size_band ?? null,
      curricula: Array.isArray(meta.curricula) ? meta.curricula : [],
      trialEndsAt: (school?.trial_ends_at as string) ?? null,
    });
  }

  return NextResponse.json({ ok: true, slug: result.slug ?? null, created: result.created === true });
}
