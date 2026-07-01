import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

// Redeem an invite for the just-authenticated user. Both the email-signup and the
// Google paths land here after auth. The service role sets role + school_id
// (users can't self-set those, per migration 0010); the invite email MUST match
// the signed-in user so nobody redeems an invite meant for someone else.
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { origin } = new URL(request.url);
  const back = (reason: string) => NextResponse.redirect(`${origin}/invite/${token}?e=${reason}`);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent("Please sign in to accept the invitation.")}`,
    );
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return back("server");
  }

  const { data: invite } = await admin.from("invites").select("*").eq("token", token).maybeSingle();
  if (!invite) return back("invalid");
  if (invite.accepted_at) return NextResponse.redirect(`${origin}/dashboard`); // already redeemed
  if (new Date(invite.expires_at).getTime() < Date.now()) return back("expired");
  if ((invite.email || "").toLowerCase() !== (user.email || "").toLowerCase()) return back("email");

  const { error: uErr } = await admin
    .from("profiles")
    .update({ role: invite.role, school_id: invite.school_id })
    .eq("id", user.id);
  if (uErr) return back("apply");
  await admin.from("invites").update({ accepted_at: new Date().toISOString() }).eq("id", invite.id);

  return NextResponse.redirect(`${origin}/dashboard`);
}
