import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { onboardingEnabled } from "@/utils/flags";
import { missingRequired, type OnboardingProfile, type OnboardingRole } from "@/utils/onboarding";

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

  // Whitelist the jsonb to the known keys so a client can't stuff arbitrary data.
  const clean: OnboardingProfile = {
    country: str(raw.country, 80),
    heard_from: str(raw.heard_from, 200),
    affiliation:
      raw.affiliation === "school" || raw.affiliation === "independent" || raw.affiliation === "homeschool"
        ? raw.affiliation
        : undefined,
    school_name: str(raw.school_name, 160),
    title: str(raw.title, 80),
    grade_levels: arr(raw.grade_levels),
    subjects: arr(raw.subjects),
    children_count: num(raw.children_count),
    child_grade_levels: arr(raw.child_grade_levels),
    school_on_platform: str(raw.school_on_platform, 20),
  };

  const { error } = await createAdminClient()
    .from("profiles")
    .update({ role, full_name: fullName, profile: clean, onboarded_at: new Date().toISOString() })
    .eq("id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, role });
}
