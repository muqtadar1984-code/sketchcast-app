import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isPlatformAdminRequest } from "@/utils/platform-admin";
import { isOpenFeedbackRequest } from "@/utils/console-actions";

export const runtime = "nodejs";

// Ask a user the in-app feedback questionnaire (staff only, audited). Creates
// a feedback_requests row (0083, service-role only); the app shows the
// 6-question modal while a request is OPEN. One open request at a time — a
// second ask while the first is unanswered (or actively snoozed) is a 409.
// After an answer, or once a snooze has lapsed unanswered, a new ask is fine.
// Non-staff get 404 — the console must not be probeable.

type Body = { user_id?: string };

export async function POST(request: Request) {
  const staff = await isPlatformAdminRequest();
  if (!staff) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const userId = (body.user_id ?? "").trim();
  if (!userId) return NextResponse.json({ error: "user_id is required." }, { status: 400 });

  const admin = createAdminClient();

  const { data: target } = await admin
    .from("profiles")
    .select("id, is_demo, role")
    .eq("id", userId)
    .maybeSingle();
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });
  // The roster only renders actions on the real tab, but the route is the
  // actual gate: demo tenants never see a feedback ask.
  if (target.is_demo) {
    return NextResponse.json({ error: "Demo accounts don't get feedback requests." }, { status: 400 });
  }
  // The dashboard never shows the questionnaire to students, so a student ask
  // could only wedge as "Requested" forever with no way to answer it.
  if ((target.role as string) === "student") {
    return NextResponse.json({ error: "Students don't get feedback requests." }, { status: 400 });
  }

  const now = new Date();
  const { data: unanswered, error: qErr } = await admin
    .from("feedback_requests")
    .select("id, snoozed_until, responded_at")
    .eq("user_id", userId)
    .is("responded_at", null);
  if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 });
  const open = ((unanswered ?? []) as { snoozed_until: string | null; responded_at: string | null }[])
    .some((r) => isOpenFeedbackRequest({ snoozedUntil: r.snoozed_until, respondedAt: r.responded_at }, now));
  if (open) {
    return NextResponse.json(
      { error: "An open feedback request already exists for this user." },
      { status: 409 },
    );
  }

  // Supersede stale asks by REUSING the row, never deleting it: any unanswered
  // row left at this point is necessarily a LAPSED snooze (a truly open one
  // just 409'd above). The user's dashboard may still be showing the popup for
  // that lapsed request — re-opening the same id keeps their in-flight answers
  // valid, where a delete+insert would 404 their submit and lose typed text.
  const stale = ((unanswered ?? []) as { id: string }[])[0];
  if (stale) {
    const { error: updErr } = await admin
      .from("feedback_requests")
      .update({ requested_by: staff.id, created_at: now.toISOString(), snoozed_until: null })
      .eq("id", stale.id)
      .is("responded_at", null);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  } else {
    const { error: insErr } = await admin
      .from("feedback_requests")
      .insert({ user_id: userId, requested_by: staff.id });
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  await admin.from("platform_audit_log").insert({
    actor_id: staff.id,
    action: "feedback_request",
    target_kind: "profile",
    target_id: userId,
    detail: {},
  });

  return NextResponse.json({ ok: true });
}
