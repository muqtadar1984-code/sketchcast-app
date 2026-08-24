import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { onboardingEnabled } from "@/utils/flags";
import { isHeardChannel, missingRequired, type OnboardingProfile, type OnboardingRole } from "@/utils/onboarding";
import { isCountryCode } from "@/utils/countries";

export const runtime = "nodejs";

// Completes a new joiner's profile. The caller is AUTHENTICATED via their session;
// role + full_name are written with the SERVICE ROLE because role/school_id are
// service-role-only (migration 0010). Role is whitelisted to teacher/parent — a
// user can NEVER self-assign coordinator/admin here (school admins come via the
// school-setup flow). Required fields are re-validated server-side so the client
// gate can't be bypassed.

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}
function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 99) : undefined;
}
function arr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.length <= 60).slice(0, 20);
  return out.length ? out : undefined;
}

export async function POST(request: Request) {
  if (!onboardingEnabled()) return NextResponse.json({ error: "Not enabled." }, { status: 404 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let b: { role?: string; full_name?: string; profile?: OnboardingProfile };
  try {
    b = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const role: OnboardingRole | null =
    b.role === "parent" ? "parent" : b.role === "teacher" ? "teacher" : null;
  if (!role) return NextResponse.json({ error: "Please choose Teacher or Parent." }, { status: 400 });

  const fullName = (b.full_name ?? "").trim().slice(0, 120);
  const raw = (b.profile && typeof b.profile === "object" ? b.profile : {}) as OnboardingProfile;

  const missing = missingRequired(role, fullName, raw);
  if (missing.length) {
    return NextResponse.json({ error: "Please complete the required fields.", missing }, { status: 400 });
  }
  // missingRequired just proved this, but keep the narrowing local and explicit:
  // only an exact assigned alpha-2 code ever reaches the column write below.
  const country = isCountryCode(raw.country) ? raw.country : null;
  if (!country) {
    return NextResponse.json({ error: "Please complete the required fields.", missing: ["country"] }, { status: 400 });
  }

  // Whitelist the jsonb to the known keys so a client can't stuff arbitrary data.
  const clean: OnboardingProfile = {
    // Kept in the jsonb snapshot for continuity, but the AUTHORITATIVE copy is
    // the profiles.country COLUMN written below (0085) — read that, not this.
    country,
    // The countable half of "how did you hear about us". Whitelisted to the
    // known codes exactly like affiliation/purpose below, so the column can be
    // grouped without cleaning.
    heard_channel: isHeardChannel(raw.heard_channel) ? raw.heard_channel : undefined,
    heard_from: str(raw.heard_from, 200),
    affiliation:
      raw.affiliation === "school" || raw.affiliation === "independent" || raw.affiliation === "homeschool"
        ? raw.affiliation
        : undefined,
    school_name: str(raw.school_name, 160),
    title: str(raw.title, 80),
    grade_levels: arr(raw.grade_levels),
    subjects: arr(raw.subjects),
    // Parent purpose (homeschool release) — missingRequired above already
    // proved it's one of the two known values for parents; the whitelist keeps
    // the jsonb snapshot clean either way. The AUTHORITATIVE copy is the
    // profiles.home_educator COLUMN written below (0087) — read that, not this.
    purpose: raw.purpose === "school" || raw.purpose === "homeschool" ? raw.purpose : undefined,
    children_count: num(raw.children_count),
    child_grade_levels: arr(raw.child_grade_levels),
    school_on_platform: str(raw.school_on_platform, 20),
  };

  const { error } = await createAdminClient()
    .from("profiles")
    .update({ role, full_name: fullName, profile: clean, onboarded_at: new Date().toISOString() })
    .eq("id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Country goes to its own COLUMNS (0085) through the caller's AUTHENTICATED
  // session — the column-scoped grant + the profiles_update_self row policy are
  // exactly what authorises this write, the same posture as ui_locale in
  // /api/locale. 'signup' marks it user-stated, never assumed. Best-effort on a
  // pre-0085 database (42703 = no column, 42501 = no grant): the preference
  // doesn't persist yet, but onboarding itself must not trap the user.
  const { error: cErr } = await supabase
    .from("profiles")
    .update({ country, country_source: "signup" })
    .eq("id", user.id);
  if (cErr) console.error("onboarding.country:", cErr.code, cErr.message);

  // Home educator (0087) — same posture as country above: the caller's OWN
  // authenticated session writes their own answer through the column-scoped
  // grant. Parents only; a homeschooling/tutoring parent homes on the full
  // Library, so the response carries the flag for the client's landing
  // redirect. Best-effort on a pre-0087 database: the flag stays false (the
  // column default), the parent lands on their children as before, and
  // onboarding itself never traps the user.
  let homeEducator = false;
  if (role === "parent" && clean.purpose === "homeschool") {
    const { error: hErr } = await supabase
      .from("profiles")
      .update({ home_educator: true })
      .eq("id", user.id);
    if (hErr) console.error("onboarding.home_educator:", hErr.code, hErr.message);
    else homeEducator = true;
  }

  return NextResponse.json({ ok: true, role, home_educator: homeEducator });
}
