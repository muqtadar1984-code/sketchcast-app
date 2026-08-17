/** Shared sender for lifecycle email — used by BOTH the daily cron
 * (/api/lifecycle/reminders) and the console's manual remind button
 * (/api/console/remind), so the two can never drift on From/Reply-To or
 * provider mechanics. Plain text via Resend; the copy lives in ./copy.ts.
 */

export const LIFECYCLE_FROM = "SketchCast <noreply@sketchcast.app>";

export function lifecycleReplyTo(): string {
  return process.env.LIFECYCLE_REPLY_TO || "muqtadar.quraishi@sketchcast.app";
}

export function lifecycleAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "https://app.sketchcast.app";
}

export async function sendLifecycleEmail(
  to: string,
  subject: string,
  text: string,
): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error("lifecycle email skipped: RESEND_API_KEY not set");
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: LIFECYCLE_FROM,
      to: [to],
      reply_to: lifecycleReplyTo(),
      subject,
      text,
    }),
  });
  if (!res.ok) {
    console.error("lifecycle email failed:", res.status, await res.text().catch(() => ""));
  }
  return res.ok;
}
