import { createAdminClient } from "@/utils/supabase/admin";

// Founder notification for a first-time registration — sent exactly once per
// account (profiles.signup_notified_at is the dedup marker, set after a
// successful send). Called from the dashboard's first load, which every signup
// path (email, Google, invite, school setup) funnels through. Never throws:
// a notification must never break a page.

const TO = process.env.FEEDBACK_EMAIL_TO || "muqtadar.quraishi@sketchcast.app";
const FROM = "SketchCast AI <noreply@sketchcast.app>";

export async function notifySignupOnce(
  userId: string,
  email: string | null,
  name: string | null,
  role: string | null,
): Promise<void> {
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key) return; // not configured yet — will notify on a later visit
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        subject: `New SketchCast registration: ${name || email || "someone"}`,
        text: [
          `A new user just signed up (beta-capped automatically).`,
          "",
          `Name:  ${name || "—"}`,
          `Email: ${email || "—"}`,
          // Never assume "teacher": callers pass the SETTLED role (post-onboarding),
          // so an empty value here means genuinely unknown, not a default.
          `Role:  ${role || "unknown"}`,
          `Time:  ${new Date().toISOString()}`,
          "",
          `Feedback dashboard: https://app.sketchcast.app/dashboard/beta-feedback`,
        ].join("\n"),
      }),
    });
    if (!res.ok) {
      console.error("signup notification failed:", res.status, await res.text().catch(() => ""));
      return; // marker not set → retried on their next visit
    }
    const admin = createAdminClient();
    await admin
      .from("profiles")
      .update({ signup_notified_at: new Date().toISOString() })
      .eq("id", userId);
  } catch (e) {
    console.error("signup notification error:", e);
  }
}

// Founder notification for a self-serve SCHOOL registration (0101). Fired by
// /api/school-finish right after finish_school_registration() reports
// created=true — which happens on exactly one call per school by construction,
// so no dedup marker is needed. Never throws: the registration has already
// committed by the time this runs, and an email must never un-succeed it.
export async function notifySchoolRegistration(input: {
  schoolId: string;
  name: string;
  slug: string | null;
  country: string | null;
  registrantEmail: string | null;
  registrantName: string | null;
  registrantRole: string | null;
  schoolType: string | null;
  sizeBand: string | null;
  curricula: string[];
  trialEndsAt: string | null;
}): Promise<void> {
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key) return;
    // The console lives at /console/… on its own host when that is configured,
    // and at the same path on the main host otherwise (console-routing.ts).
    const consoleHost = process.env.NEXT_PUBLIC_CONSOLE_HOST || "app.sketchcast.app";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        subject: `New school trial: ${input.name}`,
        text: [
          `A school just registered itself and started a 30-day trial.`,
          "",
          `School:     ${input.name}`,
          `Portal:     ${input.slug ? `school.sketchcast.app/${input.slug}` : "—"}`,
          `Country:    ${input.country || "—"}`,
          `Type/size:  ${input.schoolType || "—"} · ${input.sizeBand || "—"}`,
          `Curricula:  ${input.curricula.length ? input.curricula.join(", ") : "—"}`,
          `Registrant: ${input.registrantName || "—"} <${input.registrantEmail || "—"}> · ${input.registrantRole || "role unknown"}`,
          `Trial ends: ${input.trialEndsAt ? input.trialEndsAt.slice(0, 10) : "—"}`,
          "",
          `Console: https://${consoleHost}/console/schools/${input.schoolId}`,
        ].join("\n"),
      }),
    });
    if (!res.ok) {
      console.error("school registration notification failed:", res.status, await res.text().catch(() => ""));
    }
  } catch (e) {
    console.error("school registration notification error:", e);
  }
}

// A trial or expired school pressed "Request activation" (0101, Phase 3). The
// route sends this on the FIRST request only. Never throws.
export async function notifyActivationRequest(input: {
  schoolId: string;
  name: string;
  slug: string | null;
  requesterEmail: string | null;
  requesterName: string | null;
  requesterRole: string;
}): Promise<void> {
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key) return;
    const consoleHost = process.env.NEXT_PUBLIC_CONSOLE_HOST || "app.sketchcast.app";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        subject: `Activation requested: ${input.name}`,
        text: [
          `A school asked to be activated.`,
          "",
          `School:  ${input.name}`,
          `Portal:  ${input.slug ? `school.sketchcast.app/${input.slug}` : "—"}`,
          `Asked by: ${input.requesterName || "—"} <${input.requesterEmail || "—"}> · ${input.requesterRole}`,
          "",
          `Activate or issue an invoice from the console: https://${consoleHost}/console/schools/${input.schoolId}`,
        ].join("\n"),
      }),
    });
    if (!res.ok) {
      console.error("activation request notification failed:", res.status, await res.text().catch(() => ""));
    }
  } catch (e) {
    console.error("activation request notification error:", e);
  }
}


// ── "your issue is resolved" — every resolution reaches the client ─────────
//
// Founder direction (2026-09-25): whenever an issue is resolved, from the
// console or by the worker's support agent, the owner hears about it, in
// plain words, with an invitation to reply. The worker composes the same
// shape (support_agent/actions.py resolution_text); this is the console's
// half. Replies go to the support mailbox, never to noreply.

const REPLY_TO = process.env.SUPPORT_STAFF_EMAIL || "muqtadar.quraishi@sketchcast.app";

const KIND_WORDS: Record<string, string> = {
  presentation: "lesson video",
  exam_paper: "test paper",
  lesson_plan: "lesson plan",
  case_study: "case study",
  deck: "slide deck",
  worksheet: "worksheet",
  activity: "activities",
  index_book: "book",
};

/** "worksheet", "lesson video", … — the thing the owner asked for, in their words. */
export function issueThing(kind: string | null | undefined, category: string | null | undefined): string {
  const k = (kind ?? "").trim();
  if (k && KIND_WORDS[k]) return KIND_WORDS[k];
  if (k) return k.replace(/_/g, " ");
  return (category ?? "request").replace(/_/g, " ");
}

/** The subject and body, pure, so the words can be tested without a mailer. */
export function issueResolvedEmail(input: {
  kind?: string | null;
  category?: string | null;
  bookTitle?: string | null;
  note?: string | null;
}): { subject: string; text: string } {
  const what = issueThing(input.kind, input.category);
  const where = input.bookTitle ? ` for "${input.bookTitle}"` : "";
  const note = (input.note ?? "").trim();
  const lines = ["Hi,", "", `The problem with your ${what}${where} on SketchCast has been addressed.`];
  if (note) lines.push("", note);
  lines.push(
    "",
    "If you face any issue with it, or anything else, just reply to this email and we will take it up again.",
    "",
    "Thanks for using SketchCast.",
    "",
    "SketchCast AI",
  );
  return { subject: `Your ${what}${where} on SketchCast is sorted`, text: lines.join("\n") };
}

/** Send it. Never throws; returns whether a send was attempted. Student
 *  accounts (@students.sketchcast.app) have no mailbox and are skipped. */
export async function notifyIssueResolved(
  toEmail: string | null | undefined,
  input: Parameters<typeof issueResolvedEmail>[0],
): Promise<boolean> {
  try {
    const key = process.env.RESEND_API_KEY;
    const to = (toEmail ?? "").trim();
    if (!key || !to || to.endsWith("@students.sketchcast.app")) return false;
    const { subject, text } = issueResolvedEmail(input);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject, text }),
    });
    if (!res.ok) {
      console.error("issue resolved notification failed:", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (e) {
    console.error("issue resolved notification error:", e);
    return false;
  }
}
