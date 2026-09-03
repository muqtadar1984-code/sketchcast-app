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

// Founder notification for a self-serve SCHOOL registration (0100). Fired by
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
