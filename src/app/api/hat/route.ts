import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { roleHatsEnabled } from "@/utils/flags";
import { HAT_COOKIE, isHat } from "@/utils/hats";
import { hatHome, verifyHat } from "@/utils/hats-server";

export const runtime = "nodejs";

// Switch the active hat. Validates the requested hat is one the caller actually
// HOLDS before setting the cookie — the hat is presentation state (which tabs
// render, where pages land), never a permission, but we still refuse to let
// someone wear a hat that isn't theirs so the UI can trust the cookie.
export async function POST(request: Request) {
  if (!roleHatsEnabled()) return NextResponse.json({ error: "Not enabled." }, { status: 404 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { hat?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const hat = body.hat;
  if (!isHat(hat)) return NextResponse.json({ error: "Unknown hat." }, { status: 400 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .maybeSingle();
  const role = (profile?.role as string | null) ?? null;
  const schoolId = (profile?.school_id as string | null) ?? null;
  if (!role || role === "student") return NextResponse.json({ error: "No hats to wear." }, { status: 403 });

  if (!(await verifyHat(supabase, role, schoolId, hat))) {
    return NextResponse.json({ error: "You don't hold that role." }, { status: 403 });
  }

  const res = NextResponse.json({ ok: true, redirect: await hatHome(supabase, schoolId, hat) });
  res.cookies.set(HAT_COOKIE, hat, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  return res;
}
