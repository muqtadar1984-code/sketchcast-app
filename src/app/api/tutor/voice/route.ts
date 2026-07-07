import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { aiTutorEnabled, aiTutorRequireProPlus } from "@/utils/flags";
import { elevenLabsEnabled } from "@/utils/narration";
import { resolveVoice } from "@/utils/tutor/models";
import { resolveTutorContext, tutorEntitled, loadOwnCoachMessage } from "@/utils/tutor/service";
import { synthesizeVoice } from "@/utils/tutor/voice";

export const runtime = "nodejs";

// Voice for a coach reply. The client posts the ID of a coach message it received
// (not free text) plus the chosen voice; we return either { provider: "browser" }
// (the client speaks it, $0) or { provider: "elevenlabs", audioUrl } (a cached or
// just-synthesised clip). Binding to a logged coach message is the safety gate:
// only a real reply that already passed the closed-book fence can ever be spoken,
// so the (premium) voice can't be used to synthesise arbitrary/un-fenced text.
// Premium is gated (elevenLabsEnabled + Pro+) and capped + cached inside
// synthesizeVoice.
export async function POST(request: Request) {
  if (!aiTutorEnabled()) return NextResponse.json({ error: "Not available." }, { status: 404 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { messageId?: string; generationId?: string; voiceId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const messageId = String(body.messageId ?? "");
  const generationId = String(body.generationId ?? "");
  if (!messageId || !generationId) return NextResponse.json({ error: "Nothing to speak." }, { status: 400 });

  const admin = createAdminClient();
  // Same access fence as the chat route: only a lesson assigned to this student.
  const ctx = await resolveTutorContext(admin, user.id, generationId);
  if (!ctx) return NextResponse.json({ error: "This lesson isn't assigned to you." }, { status: 403 });
  if (aiTutorRequireProPlus() && !(await tutorEntitled(admin, generationId))) {
    return NextResponse.json({ error: "The AI Coach is a Pro+ feature.", upgrade: true }, { status: 403 });
  }

  // The text is ALWAYS a real coach message this student received on this lesson —
  // never client-supplied free text. Bounds cost and keeps voice inside the fence.
  const text = await loadOwnCoachMessage(admin, messageId, user.id, generationId);
  if (!text) return NextResponse.json({ error: "Nothing to speak." }, { status: 404 });

  const voice = resolveVoice(body.voiceId, { premiumAllowed: elevenLabsEnabled() });
  const result = await synthesizeVoice(admin, user.id, voice, text.slice(0, 2000));
  return NextResponse.json(result);
}
