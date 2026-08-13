import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { renderEmail } from "@/utils/lifecycle/copy";
import { selectSegment, type Segment, type UserFacts } from "@/utils/lifecycle/segments";
import { secretMatches, unsubscribeToken } from "@/utils/lifecycle/token";

export const runtime = "nodejs";
// Never prerender or cache: this has side effects and reads live data.
export const dynamic = "force-dynamic";

// Activation reminders. Runs daily from Vercel Cron; sends at most one email
// per user per segment, ever.
//
// Three independent things stop this from mailing the wrong people:
//   1. LIFECYCLE_EMAILS_SINCE — a cutoff. Accounts created before it are never
//      selected. UNSET MEANS SEND NOTHING, so a missing variable fails closed
//      rather than mailing the entire user base.
//   2. lifecycle_email_candidates() returns TEACHERS only (43 of 89 accounts
//      are students, and they are minors).
//   3. selectSegment() skips anyone with a generation ATTEMPT, so a user whose
//      generations we broke is never told to "create your first lesson".
//
// The sent-marker is written AFTER a successful send. A provider failure
// therefore retries tomorrow instead of being silently swallowed.

const FROM = "SketchCast <noreply@sketchcast.app>";
const REPLY_TO = process.env.LIFECYCLE_REPLY_TO || "muqtadar.quraishi@sketchcast.app";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://app.sketchcast.app";

/** Belt-and-braces ceiling. At current volume a run sends single digits; if a
 * misconfigured cutoff ever selected everyone, this bounds the damage to 50. */
const MAX_PER_RUN = 50;

type Candidate = {
  user_id: string;
  email: string | null;
  first_name: string | null;
  created_at: string;
  opted_out_at: string | null;
  book_count: number;
  oldest_book_at: string | null;
  newest_book_title: string | null;
  generation_attempts: number;
  already_sent: string[] | null;
};

async function send(to: string, subject: string, text: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error("lifecycle email skipped: RESEND_API_KEY not set");
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject, text }),
  });
  if (!res.ok) {
    console.error("lifecycle email failed:", res.status, await res.text().catch(() => ""));
  }
  return res.ok;
}

async function run(request: Request) {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` using that exact
  // env var, so CRON_SECRET is the one that must match for scheduled runs.
  // LIFECYCLE_CRON_SECRET is an optional second key for manual curl invocations
  // without handing out the platform-wide cron secret.
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const authorised =
    secretMatches(bearer, process.env.CRON_SECRET) ||
    secretMatches(bearer, process.env.LIFECYCLE_CRON_SECRET);
  if (!authorised) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sinceRaw = process.env.LIFECYCLE_EMAILS_SINCE;
  if (!sinceRaw) {
    // Fail closed. Existing users were contacted by hand and must never be
    // swept up by a cron that lost its cutoff.
    return NextResponse.json(
      { skipped: "LIFECYCLE_EMAILS_SINCE not set — sending nothing" },
      { status: 200 },
    );
  }
  const since = new Date(sinceRaw);
  if (Number.isNaN(since.getTime())) {
    return NextResponse.json({ error: "LIFECYCLE_EMAILS_SINCE is not a valid date" }, { status: 500 });
  }

  const dry = new URL(request.url).searchParams.get("dry") === "1";
  const now = new Date();
  const admin = createAdminClient();

  const { data, error } = await admin.rpc("lifecycle_email_candidates", {
    p_since: since.toISOString(),
  });
  if (error) {
    console.error("lifecycle candidates query failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const selected: { userId: string; email: string; segment: Segment; subject: string }[] = [];
  for (const c of (data ?? []) as Candidate[] ) {
    const facts: UserFacts = {
      userId: c.user_id,
      email: c.email,
      createdAt: c.created_at,
      optedOutAt: c.opted_out_at,
      bookCount: Number(c.book_count ?? 0),
      oldestBookAt: c.oldest_book_at,
      generationAttempts: Number(c.generation_attempts ?? 0),
      alreadySent: (c.already_sent ?? []) as Segment[],
    };
    const segment = selectSegment(facts, now, since);
    if (!segment || !c.email) continue;

    const { subject } = renderEmail(segment, {
      firstName: c.first_name,
      bookTitle: c.newest_book_title,
      appUrl: `${APP_URL}/dashboard`,
      unsubscribeUrl: "",
    });
    selected.push({ userId: c.user_id, email: c.email, segment, subject });
    if (selected.length >= MAX_PER_RUN) break;
  }

  if (dry) {
    return NextResponse.json({
      dryRun: true,
      since: since.toISOString(),
      candidates: (data ?? []).length,
      wouldSend: selected.length,
      recipients: selected,
    });
  }

  let sent = 0;
  const failed: string[] = [];
  for (const s of selected) {
    const c = (data as Candidate[]).find((x) => x.user_id === s.userId)!;
    const { subject, text } = renderEmail(s.segment, {
      firstName: c.first_name,
      bookTitle: c.newest_book_title,
      appUrl: `${APP_URL}/dashboard`,
      unsubscribeUrl: `${APP_URL}/api/lifecycle/unsubscribe?t=${encodeURIComponent(
        unsubscribeToken(s.userId),
      )}`,
    });

    if (!(await send(s.email, subject, text))) {
      failed.push(s.email);
      continue; // no marker → retried on tomorrow's run
    }
    // Marker AFTER the send. The unique (user_id, segment) constraint makes a
    // duplicate physically impossible even if this route runs twice at once.
    const { error: markErr } = await admin
      .from("lifecycle_emails")
      .insert({ user_id: s.userId, segment: s.segment });
    if (markErr) console.error("lifecycle marker insert failed:", s.userId, markErr.message);
    sent += 1;
  }

  return NextResponse.json({ since: since.toISOString(), candidates: (data ?? []).length, sent, failed });
}

// Vercel Cron issues a GET; POST is kept for manual/dry runs via curl.
export const GET = run;
export const POST = run;
