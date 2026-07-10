import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { aiTutorEnabled, aiTutorTalEnabled, aiTutorCanvasEnabled, aiTutorRequireProPlus } from "@/utils/flags";
import { resolveTutorContext, tutorEntitled } from "@/utils/tutor/service";
import { signBoardToken, BOARD_TOKEN_TTL_SEC } from "@/utils/tutor/board-token";

export const runtime = "nodejs";

// Mint a short-lived, scoped board token (Phase 2). Called by the PORTAL
// (cookie-authenticated, same-origin) which then hands the token to the sandboxed
// board iframe via postMessage. Proving access here — the SAME checks the turn
// route enforces (assignment + Pro+) — means the iframe never needs cookies or
// direct DB access, and the token it carries can't exceed this (user, lesson).
export async function POST(request: Request) {
  // Gated by the master tutor flag + the canvas flag (the board app is what uses it).
  if (!aiTutorEnabled() || !aiTutorTalEnabled() || !aiTutorCanvasEnabled()) {
    return NextResponse.json({ error: "Not available." }, { status: 404 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { generationId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const generationId = String(body.generationId ?? "");
  if (!generationId) return NextResponse.json({ error: "Missing lesson." }, { status: 400 });

  const admin = createAdminClient();
  const ctx = await resolveTutorContext(admin, user.id, generationId);
  if (!ctx) return NextResponse.json({ error: "This lesson isn't assigned to you." }, { status: 403 });
  if (aiTutorRequireProPlus() && !(await tutorEntitled(admin, generationId))) {
    return NextResponse.json({ error: "The AI Coach is a Pro+ feature.", upgrade: true }, { status: 403 });
  }

  let token: string;
  try {
    token = signBoardToken(user.id, generationId);
  } catch (e) {
    // BOARD_TOKEN_SECRET not configured — fail closed (portal falls back to the
    // in-app board).
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
  return NextResponse.json({ token, expiresIn: BOARD_TOKEN_TTL_SEC });
}
