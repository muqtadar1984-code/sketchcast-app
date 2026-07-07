import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { aiTutorEnabled } from "@/utils/flags";
import { elevenLabsEnabled } from "@/utils/narration";
import { resolveVoice } from "@/utils/tutor/models";
import { resolveTutorContext } from "@/utils/tutor/service";
import { synthesizeVoice } from "@/utils/tutor/voice";

export const runtime = "nodejs";

// Voice for a coach reply. The client posts a chunk of the coach's text and the
// chosen voice; we return either { provider: "browser" } (the client speaks it,
// $0) or { provider: "elevenlabs", audioUrl } (a cached/just-synthesised clip).
// Premium is gated (elevenLabsEnabled now; Pro+ entitlement in M7) and capped +
// cached inside synthesizeVoice — this route only does access control + routing.
export async function POST(request: Request) {
  if (!aiTutorEnabled()) return NextResponse.json({ error: "Not available." }, { status: 404 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { text?: string; generationId?: string; voiceId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const text = String(body.text ?? "").trim();
  const generationId = String(body.generationId ?? "");
  if (!text || !generationId) return NextResponse.json({ error: "Nothing to speak." }, { status: 400 });
  if (text.length > 2000) return NextResponse.json({ error: "Too much text to speak at once." }, { status: 400 });

  const admin = createAdminClient();
  // Same access fence as the chat route: only a lesson assigned to this student.
  const ctx = await resolveTutorContext(admin, user.id, generationId);
  if (!ctx) return NextResponse.json({ error: "This lesson isn't assigned to you." }, { status: 403 });

  const voice = resolveVoice(body.voiceId, { premiumAllowed: elevenLabsEnabled() });
  const result = await synthesizeVoice(admin, user.id, voice, text);
  return NextResponse.json(result);
}
