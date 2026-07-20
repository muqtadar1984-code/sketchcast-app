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
