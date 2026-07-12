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

  if (invite.role === "parent") {
    // Parenthood is a GRANT: linking never downgrades an existing adult role
    // (a teacher who accepts a parent invite stays a teacher and gains links).
    const { data: me } = await admin
      .from("profiles")
      .select("role, school_id")
      .eq("id", user.id)
      .maybeSingle();
    if (!me) return back("apply");
    if (me.role === "student") return back("role"); // a minor cannot become a parent
    if (me.role === "teacher" && !me.school_id) {
      // A fresh default account (signup default is teacher) with no teaching
      // footprint → this person came to BE a parent.
      const [{ count: nBooks }, { count: nClasses }] = await Promise.all([
        admin.from("books").select("id", { count: "exact", head: true }).eq("owner_id", user.id),
        admin.from("classes").select("id", { count: "exact", head: true }).eq("teacher_id", user.id),
      ]);
      if ((nBooks ?? 0) === 0 && (nClasses ?? 0) === 0) {
        await admin.from("profiles").update({ role: "parent" }).eq("id", user.id);
      }
    }
    // Parents never get school_id — their school relationship flows through
    // the children (a parent with school_id would inherit the school library).

    const { data: mapped } = await admin
      .from("invite_children")
      .select("student_id")
      .eq("invite_id", invite.id);
    for (const m of mapped ?? []) {
      const { data: child } = await admin
        .from("profiles")
        .select("role, school_id, parent_email")
        .eq("id", m.student_id)
        .maybeSingle();
      // Re-validate at accept time: still a student of the inviting school.
      if (!child || child.role !== "student" || child.school_id !== invite.school_id) continue;
      const verified =
        (child.parent_email || "").toLowerCase() === (invite.email || "").toLowerCase();
      await admin
        .from("parent_links")
        .upsert(
          {
            parent_id: user.id,
            child_id: m.student_id,
            source: "school",
            created_by: invite.invited_by ?? null,
            verified_at: verified ? new Date().toISOString() : null,
          },
          { onConflict: "parent_id,child_id" },
        );
    }
    // Accepting an invite identifies this user (as a parent here) → they skip the
    // new-joiner onboarding gate (0038). Harmless if they were already onboarded.
    await admin.from("profiles").update({ onboarded_at: new Date().toISOString() }).eq("id", user.id);
    await admin.from("invites").update({ accepted_at: new Date().toISOString() }).eq("id", invite.id);
    return NextResponse.redirect(`${origin}/dashboard/children`);
  }

  const { error: uErr } = await admin
    .from("profiles")
    // onboarded_at: the invite's role identifies this user → skip the onboarding gate (0038).
    .update({ role: invite.role, school_id: invite.school_id, onboarded_at: new Date().toISOString() })
    .eq("id", user.id);
  if (uErr) return back("apply");
  await admin.from("invites").update({ accepted_at: new Date().toISOString() }).eq("id", invite.id);

  return NextResponse.redirect(`${origin}/dashboard`);
}
