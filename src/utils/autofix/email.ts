// The founder-approval email for a drafted auto-fix. Reuses the app's Resend
// convention (plain-text fetch, from noreply@sketchcast.app, never throw). The two
// links are the ONLY release control: Approve merges the PR to prod, Reject closes
// it. When CI is red the Approve link is withheld and the mail says "needs review".

const TO = process.env.FEEDBACK_EMAIL_TO || "muqtadar.quraishi@sketchcast.app";
const FROM = "SketchCast AI <noreply@sketchcast.app>";

export type AutofixEmail = {
  issueTitle: string;
  issueId: string;
  prNumber: number | null;
  prUrl: string | null;
  ciPassed: boolean;
  sensitive: boolean;
  summary: string;
  approveUrl: string | null; // null when CI failed → Approve is withheld
  rejectUrl: string;
};

export async function sendAutofixEmail(e: AutofixEmail): Promise<boolean> {
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key) return false;
    const ci = e.ciPassed ? "✅ passing (tsc + eslint + tests)" : "❌ FAILED — do not release without reviewing";
    const lines = [
      `An auto-fix has been drafted for a reported issue.`,
      "",
      `Issue:  ${e.issueTitle}`,
      `PR:     ${e.prUrl ?? "(not opened)"}${e.prNumber ? ` (#${e.prNumber})` : ""}`,
      `CI:     ${ci}`,
      e.sensitive ? `⚠️  SENSITIVE: the diff touches auth / billing / migrations — review the code carefully.` : "",
      "",
      `What changed:`,
      e.summary || "(no summary)",
      "",
      "———",
      e.approveUrl
        ? `✅ Approve & release (merges to production):\n${e.approveUrl}`
        : `Approve is withheld because CI failed. Open the PR above, fix or discard it.`,
      "",
      `✖ Reject (closes the PR, nothing ships):\n${e.rejectUrl}`,
      "",
      `These links are single-use and expire in 7 days. Nothing reaches production until you tap Approve.`,
      `Issue in console: https://app.sketchcast.app/console/issues/${e.issueId}`,
    ].filter((l) => l !== "");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        subject: `${e.sensitive ? "⚠️ " : ""}[Auto-fix ready] ${e.issueTitle}`.slice(0, 180),
        text: lines.join("\n"),
      }),
    });
    if (!res.ok) {
      console.error("autofix email failed:", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (err) {
    console.error("autofix email error:", err);
    return false;
  }
}
