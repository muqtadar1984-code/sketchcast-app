import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isPlatformAdminRequest } from "@/utils/platform-admin";
import {
  REMIND_COOLDOWN_DAYS,
  lifecycleSegmentFor,
  remindSegment,
  reminderRetryAfter,
} from "@/utils/console-actions";
import { renderEmail } from "@/utils/lifecycle/copy";
import { lifecycleAppUrl, sendLifecycleEmail } from "@/utils/lifecycle/send";
import { unsubscribeToken } from "@/utils/lifecycle/token";

export const runtime = "nodejs";

// Manual activation reminder (staff only, audited). Sends EXACTLY the email
// the lifecycle cron would send for the user's segment — same copy
// (src/utils/lifecycle/copy.ts), same From/Reply-To and plain-login-link
// approach (src/utils/lifecycle/send.ts) — then records a console_reminders
// row (0083).
//
// Refusals, in order:
//   404  non-staff (console isn't probeable), or user not found
//   400  not a teacher — lifecycle mail is teacher-only (0080: students are
//        minors; neither students nor parents upload textbooks)
//   400  nothing to remind — they have generation ATTEMPTS (any status; the
//        segments.ts rule: someone we may have failed is a support
//        conversation, not a nudge)
//   400  unsubscribed (email_optout_at) — absolute and permanent
//   429  ANY reminder reached them within 3 days — manual (console_reminders)
//        OR automated (lifecycle_emails); the founder's rule: an automated
//        send also disables manual for 3 days. Body carries retry_after.

type Body = { user_id?: string };

const DAY_MS = 86_400_000;

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
    .select("id, full_name, role, email_optout_at, is_demo")
    .eq("id", userId)
    .maybeSingle();
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });
  if (target.is_demo) {
    return NextResponse.json({ error: "Demo accounts don't get reminders." }, { status: 400 });
  }
  if ((target.role as string) !== "teacher") {
    return NextResponse.json({ error: "Lifecycle reminders are teacher-only." }, { status: 400 });
  }

  // Segment from live facts — LIVE books (what the roster shows; a removed
  // book's title must not appear in the email) and attempts of ANY status.
  const [booksQ, gensQ] = await Promise.all([
    admin
      .from("books")
      .select("title, created_at")
      .eq("owner_id", userId)
      .is("removed_at", null)
      .order("created_at", { ascending: false }),
    admin.from("generations").select("id").eq("owner_id", userId).limit(1),
  ]);
  const books = (booksQ.data ?? []) as { title: string | null }[];
  const attempts = (gensQ.data ?? []).length;
  const segment = remindSegment(books.length, attempts);
  if (!segment) {
    return NextResponse.json({ error: "Nothing to remind — they have already tried generating." }, { status: 400 });
  }

  if (target.email_optout_at) {
    return NextResponse.json({ error: "This user has unsubscribed from reminder email." }, { status: 400 });
  }

  // Cooldown: the LATEST send across both ledgers within the window blocks.
  const cutoff = new Date(Date.now() - REMIND_COOLDOWN_DAYS * DAY_MS).toISOString();
  const [manualQ, autoQ] = await Promise.all([
    admin
      .from("console_reminders")
      .select("sent_at")
      .eq("user_id", userId)
      .gte("sent_at", cutoff)
      .order("sent_at", { ascending: false })
      .limit(1),
    admin
      .from("lifecycle_emails")
      .select("sent_at")
      .eq("user_id", userId)
      .gte("sent_at", cutoff)
      .order("sent_at", { ascending: false })
      .limit(1),
  ]);
  // FAIL CLOSED: if either ledger can't be read, refuse to send rather than
  // risk a repeat email the cooldown never saw (e.g. migration 0083 missing).
  if (manualQ.error || autoQ.error) {
    return NextResponse.json(
      { error: `Cooldown state unavailable: ${(manualQ.error ?? autoQ.error)!.message}` },
      { status: 500 },
    );
  }
  const recent = [
    ...((manualQ.data ?? []) as { sent_at: string }[]),
    ...((autoQ.data ?? []) as { sent_at: string }[]),
  ]
    .map((r) => r.sent_at)
    .sort()
    .pop();
  if (recent) {
    return NextResponse.json(
      {
        error: `A reminder already reached this user within ${REMIND_COOLDOWN_DAYS} days.`,
        retry_after: reminderRetryAfter(recent).toISOString(),
      },
      { status: 429 },
    );
  }

  let email = "";
  try {
    const { data: u } = await admin.auth.admin.getUserById(userId);
    email = u?.user?.email ?? "";
  } catch {
    // fall through to the check below
  }
  if (!email) return NextResponse.json({ error: "No email on file for this user." }, { status: 400 });

  const firstName = ((target.full_name as string | null) ?? "").trim().split(/\s+/)[0] || null;
  const { subject, text } = renderEmail(lifecycleSegmentFor(segment), {
    firstName,
    bookTitle: books[0]?.title ?? null,
    appUrl: `${lifecycleAppUrl()}/dashboard`,
    unsubscribeUrl: `${lifecycleAppUrl()}/api/lifecycle/unsubscribe?t=${encodeURIComponent(
      unsubscribeToken(userId),
    )}`,
  });

  if (!(await sendLifecycleEmail(email, subject, text))) {
    // No ledger row → the button unblocks immediately for a retry.
    return NextResponse.json({ error: "Email send failed — nothing was recorded, retry." }, { status: 502 });
  }

  // Ledger AFTER the send, mirroring the cron's marker-after-send rule.
  const { error: insErr } = await admin
    .from("console_reminders")
    .insert({ user_id: userId, segment, sent_by: staff.id });
  if (insErr) console.error("console_reminders insert failed:", userId, insErr.message);

  await admin.from("platform_audit_log").insert({
    actor_id: staff.id,
    action: "manual_reminder",
    target_kind: "profile",
    target_id: userId,
    detail: { segment },
  });

  return NextResponse.json({ ok: true, segment });
}
